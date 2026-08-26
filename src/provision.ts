//! Batch placeholder provisioning.
//!
//! Reserves a primary package and/or its per-platform sub-packages on the
//! registry and binds every one of them to the same GitHub repository, under a
//! single OTP. Unlike the directory-scanning batch flow, nothing has to exist
//! locally: the names are composed from what the user answers here.

import { t } from './i18n'
import * as color from './color'
import { PkgJson } from './pkgjson'
import { configureOne } from './batch'
import { validateOwnerRepo } from './discover'
import { githubTrust, Permission } from './registry/index'
import { checkboxPrompt, confirm, promptOtp, promptValidated, selectPrompt } from './prompts'
import {
  DEFAULT_WORKFLOW,
  describeBinding,
  resolveClient,
  validateWorkflowFile,
  Writer,
} from './engine'
import {
  ALL_TARGETS,
  DEFAULT_BASE_WORD,
  DEFAULT_TARGET_IDS,
  derivePrefix,
  platformPackageName,
  platformSuffix,
  targetId,
  validateBaseWord,
  validatePackageName,
  validatePrefix,
  vocabularySample,
} from './naming'

import type { BatchTarget, OtpBox } from './batch'
import type { Client, TrustConfig } from './registry/index'
import type { ArtifactKind, NamingScheme, PlatformNaming, PlatformTarget } from './naming'

export interface ProvisionArgs {
  dryRun: boolean
  environment?: string
  workflow?: string
}

/** A name the run will reserve, tagged with the slot it fills. */
interface PlannedName {
  kind: ArtifactKind
  name: string
}

/** A planned name once its registry state is known. */
interface ProvisionTarget extends BatchTarget {
  kind: ArtifactKind
}

export function defaultProvisionArgs(): ProvisionArgs {
  return { workflow: undefined, environment: undefined, dryRun: false }
}

export async function runProvision(args: ProvisionArgs, existing?: Client): Promise<void> {
  console.log(
    color.title(
      t(
        'npt — batch placeholder publish + repository binding',
        'npt — 批量占位发布 + 绑定 GitHub 仓库',
      ),
    ),
  )
  console.log()
  console.log(
    color.dim(
      t(
        'Names are typed in here, not discovered — no local package, no directory,\nnothing to check out first. Each placeholder is built in a temp dir, then deleted.',
        '包名在这里直接输入,不是扫描出来的 —— 不需要本地包、不需要目录,也不用先 clone。\n每个占位包在临时目录里生成,发布完即删。',
      ),
    ),
  )
  console.log()
  if (args.dryRun) {
    console.log(
      color.dim(
        t(
          '(dry run — nothing is published and no binding is written)',
          '(演练模式 —— 不发布、不写入绑定)',
        ),
      ),
    )
  }

  const client = await connect(args, existing)

  const kinds = await promptKinds()
  const planned = await planNames(kinds)

  const ownerRepo = await promptValidated(
    t('GitHub repository (owner/repo)', 'GitHub 仓库(owner/repo)'),
    defaultRepository(),
    validateOwnerRepo,
  )
  const workflow = await promptValidated(
    t('CI workflow filename', 'CI workflow 文件名'),
    args.workflow ?? DEFAULT_WORKFLOW,
    validateWorkflowFile,
  )
  const desired = githubTrust(ownerRepo, workflow, args.environment, [Permission.Publish])

  const targets = await inspect(client, planned, ownerRepo, desired)
  printPlan(targets, desired)

  if (args.dryRun) {
    console.log(
      color.dim(t('(dry run) stopping before any write.', '(演练)到此为止,不做任何写入。')),
    )
    return
  }
  if (!(await confirm(t("Proceed? You'll enter your OTP once.", '继续?只需输入一次 OTP。')))) return

  const box: OtpBox = { otp: await promptOtp() }
  const writer = Writer.withOtp(client, box.otp)
  let ok = 0
  let fail = 0
  for (const tgt of targets) {
    console.log(`── ${tgt.name} ──`)
    if (await configureOne(tgt, writer, box)) ok++
    else fail++
  }

  console.log(
    color.ok(
      t(
        `Done: ${ok} configured, ${fail} failed/skipped.`,
        `完成:成功 ${ok} 个,失败/跳过 ${fail} 个。`,
      ),
    ),
  )
  if (ok > 0) printNextSteps(ownerRepo, workflow)
}

/**
 * Reuse the menu's already-validated client when there is one. A dry run only
 * probes existence, which is unauthenticated, so it never demands credentials.
 */
async function connect(args: ProvisionArgs, existing: Client | undefined): Promise<Client> {
  if (existing) return existing
  const resolved = await resolveClient(!args.dryRun)
  return resolved.client
}

function defaultPrimaryName(): string | undefined {
  try {
    return PkgJson.load('.').name()
  } catch {
    return undefined
  }
}

function defaultRepository(): string | undefined {
  try {
    return PkgJson.load('.').repositoryOwnerRepo()
  } catch {
    return undefined
  }
}

/** Probe the registry for each planned name (unauthenticated, never prompts). */
async function inspect(
  client: Client,
  planned: PlannedName[],
  ownerRepo: string,
  desired: TrustConfig,
): Promise<ProvisionTarget[]> {
  console.log(
    color.dim(t(`Checking ${planned.length} name(s)…`, `正在检查 ${planned.length} 个包名的状态…`)),
  )
  const targets: ProvisionTarget[] = []
  for (const item of planned) {
    let published: boolean
    try {
      published = await client.packageExists(item.name)
    } catch {
      published = false
    }
    targets.push({ kind: item.kind, name: item.name, published, desired, repository: ownerRepo })
  }
  return targets
}

/** Ask for every name this run should reserve, primary first. */
async function planNames(kinds: Set<ArtifactKind>): Promise<PlannedName[]> {
  const planned: PlannedName[] = []
  let primary: string | undefined

  if (kinds.has('primary')) {
    primary = await promptValidated(
      t('Primary package name (the one users install)', '主包名称(用户直接安装的包)'),
      defaultPrimaryName(),
      validatePackageName,
    )
    planned.push({ kind: 'primary', name: primary })
  }

  if (kinds.has('platform')) {
    const prefix = await promptPrefix(primary)
    const naming = await promptVocabulary()
    const matrix = await promptTargets(naming)
    for (const target of matrix) {
      planned.push({ kind: 'platform', name: platformPackageName(prefix, target, naming) })
    }
  }

  // A derived prefix can only collide with the primary name in odd corner cases,
  // but dedupe anyway: publishing the same name twice in one run would fail.
  const seen = new Set<string>()
  return planned.filter(item => {
    if (seen.has(item.name)) return false
    seen.add(item.name)
    return true
  })
}

function printNextSteps(ownerRepo: string, workflow: string): void {
  console.log(color.title(t('\nNext step:', '\n下一步:')))
  console.log(
    t(
      `  Add .github/workflows/${workflow} to ${ownerRepo}'s default branch — CI\n  publishes the real contents over the 0.0.1 placeholders via OIDC (no token).`,
      `  把 .github/workflows/${workflow} 推到 ${ownerRepo} 的默认分支 —— CI 会用 OIDC\n  发布真实内容,覆盖 0.0.1 占位版(无需 token)。`,
    ),
  )
}

function printPlan(targets: ProvisionTarget[], desired: TrustConfig): void {
  console.log()
  console.log(
    t(
      `Will process ${targets.length} package(s) → ${describeBinding(desired)}`,
      `即将处理 ${targets.length} 个包 → ${describeBinding(desired)}`,
    ),
  )
  const width = Math.max(...targets.map(tgt => tgt.name.length))
  for (const tgt of targets) {
    const kind = tgt.kind === 'primary' ? t('primary ', '主包  ') : t('platform', '跨平台')
    const state = tgt.published
      ? color.warn(t('published    bind only', '已发布  仅绑定'))
      : t('unpublished  placeholder 0.0.1 + bind', '未发布  首发占位 0.0.1 + 绑定')
    console.log(`  ${color.accent(tgt.name.padEnd(width))}  ${color.dim(kind)}  ${state}`)
  }
  if (targets.some(tgt => tgt.published)) {
    console.log(
      color.dim(
        t(
          '  (already-published names are only bound — that fails unless the name is yours.)',
          '  (已发布的名字只做绑定 —— 若该名字不属于你,绑定会失败。)',
        ),
      ),
    )
  }
  console.log()
}

/** Which slots to reserve. At least one is required. */
async function promptKinds(): Promise<Set<ArtifactKind>> {
  for (;;) {
    const picked = await checkboxPrompt<ArtifactKind>(
      t(
        'What should this run publish? (space toggles, enter confirms)',
        '这次要发布哪几类包?(空格勾选,回车确认)',
      ),
      [
        {
          name: t('Primary package — the one users install', '主包 —— 用户直接安装的入口包'),
          value: 'primary',
          checked: true,
        },
        {
          name: t(
            'Platform packages — per-OS/CPU native sub-packages',
            '跨平台包 —— 按 OS/CPU 拆分的二进制子包',
          ),
          value: 'platform',
          checked: true,
        },
      ],
    )
    if (picked.length > 0) return new Set(picked)
    process.stderr.write(color.warn(t('Select at least one.', '至少勾选一项。')) + '\n')
  }
}

/** The string the `-<os>-<arch>` token is appended to. */
async function promptPrefix(primary: string | undefined): Promise<string> {
  const prefixPrompt = (dflt: string | undefined): Promise<string> =>
    promptValidated(
      t(
        'Platform package prefix (names become <prefix>-<os>-<arch>)',
        '跨平台包前缀(将拼成 <前缀>-<os>-<arch>)',
      ),
      dflt,
      validatePrefix,
    )

  if (!primary) return prefixPrompt(undefined)

  const scoped = derivePrefix(primary, 'scoped', DEFAULT_BASE_WORD)
  const scheme = await selectPrompt<NamingScheme>(
    t('How should platform names be derived?', '跨平台子包命名方式'),
    [
      {
        name: t(
          `Collapse into one scope — ${scoped}-<os>-<arch>`,
          `收敛到同一 scope —— ${scoped}-<os>-<arch>`,
        ),
        value: 'scoped',
      },
      {
        name: t(
          `Reuse the primary name — ${primary}-<os>-<arch>`,
          `沿用主包名做前缀 —— ${primary}-<os>-<arch>`,
        ),
        value: 'suffix',
      },
      { name: t('Enter a prefix by hand', '手动输入前缀'), value: 'custom' },
    ],
  )

  if (scheme === 'custom') return prefixPrompt(primary)
  if (scheme === 'suffix') return validatePrefix(primary)

  const word = await promptValidated(
    t('Base word for the shared scope', '同 scope 下的基础词'),
    DEFAULT_BASE_WORD,
    validateBaseWord,
  )
  return validatePrefix(derivePrefix(primary, 'scoped', word))
}

/** Which OS/CPU slots the matrix covers. At least one is required. */
async function promptTargets(naming: PlatformNaming): Promise<PlatformTarget[]> {
  const choices = ALL_TARGETS.map((target, i) => ({
    name: platformSuffix(target, naming),
    value: i,
    checked: DEFAULT_TARGET_IDS.has(targetId(target)),
  }))
  for (;;) {
    const picked = await checkboxPrompt<number>(
      t(
        'Select the platform matrix (space toggles, enter confirms)',
        '勾选平台矩阵(空格切换,回车确认)',
      ),
      choices,
    )
    const targets = picked.map(i => ALL_TARGETS[i]).filter(target => target !== undefined)
    if (targets.length > 0) return targets
    process.stderr.write(
      color.warn(t('Select at least one platform.', '至少勾选一个平台。')) + '\n',
    )
  }
}

/** Which `<os>-<arch>` vocabulary the suffixes use. */
function promptVocabulary(): Promise<PlatformNaming> {
  return selectPrompt<PlatformNaming>(t('Platform suffix style', '平台后缀风格'), [
    {
      name: t(
        `Node convention — ${vocabularySample('node')}  (process.platform + process.arch)`,
        `Node 约定 —— ${vocabularySample('node')}(process.platform + process.arch)`,
      ),
      value: 'node',
    },
    {
      name: t(`Go convention — ${vocabularySample('go')}`, `Go 约定 —— ${vocabularySample('go')}`),
      value: 'go',
    },
    {
      name: t(`Short — ${vocabularySample('short')}`, `简写 —— ${vocabularySample('short')}`),
      value: 'short',
    },
  ])
}
