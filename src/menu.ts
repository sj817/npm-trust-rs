//! Interactive main menu — the default when `npt` is run with no subcommand.

import { t } from './i18n'
import * as color from './color'
import { PkgJson } from './pkgjson'
import { errMsg } from './commands/util'
import { runScan } from './commands/scan'
import { runAudit } from './commands/audit'
import { discoverLocal, validateOwnerRepo } from './discover'
import { configureOne, printSummary, requireId } from './batch'
import { defaultProvisionArgs, runProvision } from './provision'
import { githubTrust, Permission, sameBinding } from './registry/index'
import {
  defaultWizardArgs,
  ensureWorkflowFile,
  promptPublishOtp,
  publishPlaceholder,
  runWizard,
} from './wizard'
import {
  checkboxPrompt,
  confirm,
  confirmGuarded,
  promptLine,
  promptOtp,
  promptValidated,
  selectPrompt,
} from './prompts'
import {
  bindingRepo,
  DEFAULT_WORKFLOW,
  describeBinding,
  desiredBinding,
  resolveClient,
  validateWorkflowFile,
  Writer,
} from './engine'

import type { BatchTarget, OtpBox, SummaryRow } from './batch'
import type { Client, GithubClaims, TrustConfig } from './registry/index'

type Action =
  | 'audit'
  | 'batch'
  | 'bind'
  | 'genci'
  | 'provision'
  | 'publish'
  | 'quit'
  | 'revoke'
  | 'scan'
  | 'status'
  | 'wizard'

/** Cached view of the package's registry state (avoids re-fetching each loop). */
interface Snapshot {
  binding?: TrustConfig
  bindingKnown: boolean
  published: boolean
}

export async function runMenu(): Promise<void> {
  console.log(
    color.title(t('npt — npm Trusted Publishing', 'npt — npm 可信任发布(Trusted Publishing)')),
  )
  console.log()

  const { client } = await resolveClient(true)

  let pkgName: string | undefined
  try {
    pkgName = PkgJson.load('.').name()
  } catch {
    pkgName = undefined
  }
  if (!pkgName) {
    process.stderr.write(
      color.warn(
        t(
          'No package.json in the current directory — only batch commands are available.',
          '当前目录没有 package.json —— 仅提供批量命令。',
        ),
      ) + '\n',
    )
  }

  // Startup snapshot: existence only (cheap, unauth). Binding is fetched lazily
  // so opening the menu never triggers an OTP prompt.
  const snap: Snapshot = {
    published: pkgName ? await existsQuiet(client, pkgName) : false,
    binding: undefined,
    bindingKnown: false,
  }

  for (;;) {
    console.log()
    printHeader(pkgName, snap)
    const action = await promptAction(pkgName !== undefined)
    if (action === 'quit') break
    try {
      await dispatch(action, client, pkgName, snap)
    } catch (error) {
      // Ctrl+C inside a prompt still exits the whole program (handled in cli.ts);
      // any other error returns to the menu instead of killing the session.
      if ((error as { name?: string }).name === 'ExitPromptError') throw error
      process.stderr.write(color.err(`✗ ${errMsg(error)}`) + '\n')
    }
  }
}

async function bind(client: Client, name: string | undefined, snap: Snapshot): Promise<void> {
  if (!name) return
  const writer = new Writer(client)

  let defaultRepo: string | undefined
  try {
    defaultRepo = PkgJson.load('.').repositoryOwnerRepo()
  } catch {
    defaultRepo = undefined
  }
  if (!defaultRepo && snap.binding) defaultRepo = bindingRepo(snap.binding)

  const ownerRepo = await promptValidated(
    t('GitHub repository (owner/repo)', 'GitHub 仓库(owner/repo)'),
    defaultRepo,
    validateOwnerRepo,
  )

  const defaultWf =
    snap.binding?.type === 'github'
      ? (snap.binding.claims as GithubClaims).workflow_ref.file
      : DEFAULT_WORKFLOW
  const workflow = await promptValidated(
    t('CI workflow filename', 'CI workflow 文件名'),
    defaultWf,
    validateWorkflowFile,
  )
  try {
    ensureWorkflowFile('.', workflow)
  } catch {
    // best-effort
  }

  const desired = githubTrust(ownerRepo, workflow, undefined, [Permission.Publish])
  const [current] = await writer.list(name)
  if (current) {
    if (sameBinding(desired, current)) {
      console.log(
        color.ok(t('✓ already the desired binding — nothing to do.', '✓ 已是目标绑定,无需操作。')),
      )
      snap.binding = current
      snap.bindingKnown = true
      return
    }
    console.log(
      t(
        `current: ${describeBinding(current)}\ndesired: ${describeBinding(desired)}`,
        `当前:${describeBinding(current)}\n目标:${describeBinding(desired)}`,
      ),
    )
    if (!(await confirmGuarded(t('Replace it (revoke + create)?', '替换它(撤销 + 重建)?')))) {
      return
    }
    await writer.revoke(name, requireId(current, name))
  } else {
    console.log(t(`desired: ${describeBinding(desired)}`, `目标:${describeBinding(desired)}`))
    if (!(await confirmGuarded(t('Create this binding?', '创建这个绑定?')))) return
  }
  await writer.create(name, desired)
  const desc = describeBinding(desired)
  console.log(color.ok(t(`✓ binding set: ${desc}`, `✓ 绑定已设置:${desc}`)))
  snap.binding = desired
  snap.bindingKnown = true
}

function bindingPart(snap: Snapshot): string {
  if (!snap.bindingKnown) {
    return color.dim(t('binding unknown (View status)', '绑定未知(选"查看状态")'))
  }
  if (!snap.binding) return color.dim(t('no binding', '未绑定'))
  const desc = describeBinding(snap.binding)
  return color.ok(t(`bound ${desc}`, `已绑定 ${desc}`))
}

/**
 * Scan a directory for packages, show each one's publish status, let the user
 * multi-select, then for each selected package first-publish a placeholder (if
 * needed) and bind it — reusing one OTP across the whole batch.
 */
async function configureFromDir(client: Client, dir: string): Promise<void> {
  const candidates = discoverLocal([dir]).filter(p => !p.private && p.name.length > 0)
  if (candidates.length === 0) {
    process.stderr.write(
      color.warn(
        t(
          'No configurable packages found (need non-private package.json with a name).',
          '未找到可配置的包(需非 private 且含 name 的 package.json)。',
        ),
      ) + '\n',
    )
    return
  }

  console.log(
    color.dim(
      t(`Scanning ${candidates.length} package(s)…`, `正在检查 ${candidates.length} 个包的状态…`),
    ),
  )
  const targets: BatchTarget[] = []
  for (const pkg of candidates) {
    const derived = desiredBinding(pkg)
    targets.push({
      name: pkg.name,
      published: await existsQuiet(client, pkg.name),
      desired: derived?.config,
      repository: derived?.repository,
    })
  }

  const picked = await pickTargets(targets)
  if (picked.length === 0) {
    console.log(color.dim(t('Nothing selected.', '未选择。')))
    return
  }

  const bindable = picked.filter(tgt => tgt.desired).length
  if (bindable === 0) {
    process.stderr.write(
      color.warn(
        t(
          'None of the selected packages has a repository to bind.',
          '所选包都没有可绑定的 repository。',
        ),
      ) + '\n',
    )
    return
  }

  console.log(
    t(
      `Will configure ${bindable} package(s): first-publish placeholder if unpublished, then bind.`,
      `将配置 ${bindable} 个包:未发布则首发占位,然后绑定。`,
    ),
  )
  const proceed = await confirmGuarded(
    t("Proceed? You'll enter your OTP once.", '继续?只需输入一次 OTP。'),
  )
  if (!proceed) return

  const box: OtpBox = { otp: await promptOtp() }
  const writer = Writer.withOtp(client, box.otp)
  const rows: SummaryRow[] = []

  for (const tgt of picked) {
    console.log(`── ${tgt.name} ──`)
    const outcome = await configureOne(tgt, writer, box)
    rows.push({
      name: tgt.name,
      outcome,
      binding: tgt.desired ? describeBinding(tgt.desired) : undefined,
    })
  }

  console.log()
  printSummary(rows)
}

async function dispatch(
  action: Exclude<Action, 'quit'>,
  client: Client,
  pkgName: string | undefined,
  snap: Snapshot,
): Promise<void> {
  switch (action) {
    case 'audit': {
      await runAudit({ dir: ['.'], json: false, limit: 200 })
      break
    }
    case 'batch': {
      const dir = await promptLine(t('Directory to scan for packages', '要扫描的目录'), '.')
      await configureFromDir(client, dir)
      break
    }
    case 'bind': {
      await bind(client, pkgName, snap)
      break
    }
    case 'genci': {
      await genCi()
      break
    }
    case 'provision': {
      await runProvision(defaultProvisionArgs(), client)
      break
    }
    case 'publish': {
      await publishAction(client, pkgName, snap)
      break
    }
    case 'revoke': {
      await revoke(client, pkgName, snap)
      break
    }
    case 'scan': {
      await runScan({ dir: ['.'], limit: 200 })
      const pick = await confirm(
        t('Select some of these to configure now?', '现在从当前目录勾选一些包来配置?'),
      )
      if (pick) await configureFromDir(client, '.')
      break
    }
    case 'status': {
      await showStatus(client, pkgName, snap)
      break
    }
    case 'wizard': {
      await runWizard(defaultWizardArgs())
      await refresh(client, pkgName, snap)
      break
    }
  }
}

/** Unauthenticated existence probe; network errors count as "not published". */
async function existsQuiet(client: Client, name: string): Promise<boolean> {
  try {
    return await client.packageExists(name)
  } catch {
    return false
  }
}

async function genCi(): Promise<void> {
  const workflow = await promptValidated(
    t('CI workflow filename', 'CI workflow 文件名'),
    DEFAULT_WORKFLOW,
    validateWorkflowFile,
  )
  ensureWorkflowFile('.', workflow)
}

/** Multi-select prompt over batch targets, labeled with repo + publish status. */
async function pickTargets(targets: BatchTarget[]): Promise<BatchTarget[]> {
  const choices = targets.map((tgt, i) => {
    const pubS = tgt.published ? t('published', '已发布') : t('unpublished', '未发布')
    const skipS = t('(no repository / ignored — will skip)', '(无 repository 或已 ignore,将跳过)')
    const label = tgt.desired
      ? `${tgt.name}  → ${tgt.repository} · ${pubS}`
      : `${tgt.name}  · ${pubS} ${skipS}`
    return { name: label, value: i, checked: true }
  })
  const picked = await checkboxPrompt<number>(
    t(
      'Select packages to configure (space toggles, enter confirms)',
      '勾选要配置的包(空格切换,回车确认)',
    ),
    choices,
  )
  return picked.map(i => targets[i]).filter(tgt => tgt !== undefined)
}

function printHeader(name: string | undefined, snap: Snapshot): void {
  if (!name) return
  const pubS = snap.published
    ? color.ok(t('published', '已发布'))
    : color.dim(t('not published', '未发布'))
  const parts = [color.accent(name), pubS, bindingPart(snap)]
  console.log(parts.join(color.dim(' · ')))
}

function promptAction(hasPkg: boolean): Promise<Action> {
  const pkgItems: Array<{ name: string; value: Action }> = [
    { name: t('View status', '查看状态(是否发布 + 当前绑定)'), value: 'status' },
    { name: t('One-shot setup wizard', '一键配置(完整向导)'), value: 'wizard' },
    { name: t('Create / change binding', '创建 / 修改绑定'), value: 'bind' },
    { name: t('Revoke binding', '撤销绑定'), value: 'revoke' },
    { name: t('Generate / update CI workflow', '生成 / 更新 CI workflow 模板'), value: 'genci' },
    { name: t('Publish placeholder version', '发布占位版(首发)'), value: 'publish' },
  ]
  const items: Array<{ name: string; value: Action }> = [
    ...(hasPkg ? pkgItems : []),
    {
      name: t(
        'Batch by package name: placeholder publish + bind / rebind (no local package needed)',
        '按包名批量:占位发布 + 绑定 / 改绑仓库(无需本地目录)',
      ),
      value: 'provision',
    },
    { name: t('Batch setup (scan a dir, one OTP)', '批量配置(扫描目录,一次 OTP)'), value: 'batch' },
    { name: t('Scan (batch)', '扫描 scan(批量)'), value: 'scan' },
    { name: t('Audit (batch)', '审计 audit(批量)'), value: 'audit' },
    { name: t('Quit', '退出'), value: 'quit' },
  ]
  return selectPrompt(t('Choose an action', '选择操作'), items)
}

async function publishAction(
  client: Client,
  name: string | undefined,
  snap: Snapshot,
): Promise<void> {
  if (!name) return
  if (snap.published) {
    console.log(color.dim(t('Already published.', '已发布,无需再发。')))
    return
  }
  if (await confirm(t('Publish a minimal placeholder version now?', '现在发布最小占位版本吗?'))) {
    publishPlaceholder(name, await promptPublishOtp())
    await refresh(client, name, snap)
  }
}

async function refresh(client: Client, name: string | undefined, snap: Snapshot): Promise<void> {
  if (!name) return
  snap.published = await existsQuiet(client, name)
  // Binding state may have changed; mark unknown until the next explicit fetch.
  snap.bindingKnown = false
  snap.binding = undefined
}

async function revoke(client: Client, name: string | undefined, snap: Snapshot): Promise<void> {
  if (!name) return
  const writer = new Writer(client)
  const [current] = await writer.list(name)
  if (!current) {
    console.log(color.dim(t('No binding to revoke.', '没有可撤销的绑定。')))
    return
  }
  console.log(
    t(`current binding: ${describeBinding(current)}`, `当前绑定:${describeBinding(current)}`),
  )
  if (!(await confirm(t('Revoke this binding?', '撤销这个绑定?')))) return
  await writer.revoke(name, requireId(current, name))
  console.log(color.ok(t('✓ revoked.', '✓ 已撤销。')))
  snap.binding = undefined
  snap.bindingKnown = true
}

async function showStatus(client: Client, name: string | undefined, snap: Snapshot): Promise<void> {
  if (!name) return
  snap.published = await client.packageExists(name)
  console.log(
    snap.published
      ? t('→ registry: published', '→ registry:已发布')
      : t('→ registry: not published', '→ registry:未发布'),
  )
  if (snap.published) {
    const [binding] = await new Writer(client).list(name)
    if (binding) {
      const desc = describeBinding(binding)
      console.log(color.ok(t(`→ current binding: ${desc}`, `→ 当前绑定:${desc}`)))
    } else {
      console.log(color.dim(t('→ no trust binding', '→ 无可信任发布绑定')))
    }
    snap.binding = binding
    snap.bindingKnown = true
  }
}
