//! `npt sync` — reconcile bindings toward the desired state (create/revoke,
//! first-publish). One OTP-aware `Writer` handles all writes.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { t } from '../i18n'
import { confirmGuarded } from '../prompts'
import { discoverAll, sleep } from './util'
import { DEFAULT_REGISTRY } from '../registry/index'
import { promptPublishOtp, publishPlaceholder } from '../wizard'
import { assess, describeBinding, npmCommand, resolveClient, Writer } from '../engine'

import type { PackagePlan } from '../engine'
import type { DiscoveredPackage } from '../discover'
import type { TrustConfig } from '../registry/index'

const WRITE_SPACING_MS = 2000

export interface SyncArgs {
  dir: string[]
  dryRun: boolean
  environment?: string
  limit: number
  noPublish: boolean
  org?: string
  placeholder: boolean
  workflow?: string
  yes: boolean
}

type Action =
  | { desired: TrustConfig; kind: 'create'; name: string }
  | { desired: TrustConfig; kind: 'reconcile'; name: string; oldId: string }
  | { dir?: string; kind: 'publish'; name: string; placeholder: boolean }
  | { kind: 'warnMissingWorkflow'; name: string; workflow: string }

/** Returns the process exit code: 1 when the current state could not be read. */
export async function runSync(args: SyncArgs): Promise<number> {
  const dirs = args.dir.length > 0 ? args.dir : ['.']
  const packages = await discoverAll(dirs, args.org, args.limit)
  const byName = new Map(packages.map(p => [p.name, p]))

  const { client, valid } = await resolveClient(true)
  // One writer for both halves: it reads the trust list (answering the OTP
  // challenge the registry issues even for reads) and performs the writes, so a
  // single OTP covers the whole run inside the registry's ~5-minute window.
  const writer = new Writer(client)
  const plans = await assess(client, valid, packages, args.workflow, args.environment, writer)

  const actions = plans.flatMap(p => planActions(p, byName.get(p.name), args))
  const unknown = plans.filter(p => p.status === 'unknown')
  if (actions.length === 0) {
    // "Nothing to do" is only true if we could actually see the current state.
    // Saying it while some packages were unreadable reports success for work that
    // was never even considered.
    if (unknown.length > 0) {
      console.log(
        t(
          `Cannot tell — the trust list for ${unknown.length} package(s) was unreadable, so nothing was planned:`,
          `无法判断 —— 有 ${unknown.length} 个包的绑定读不出来,因此没有生成任何计划:`,
        ),
      )
      for (const p of unknown) console.log(`  - ${p.name}`)
      console.log(
        t(
          'Reading the trust API needs a 2FA/OTP. Re-run in a terminal, or set NPM_OTP.',
          '读取 trust API 需要 2FA/OTP。请在终端里重新运行,或设置 NPM_OTP。',
        ),
      )
      return 1
    }
    console.log(
      t(
        'Nothing to do — all packages already in the desired state.',
        '无需操作 —— 所有包均已处于目标状态。',
      ),
    )
    return 0
  }

  console.log('\n' + t('Planned actions:', '计划执行:'))
  for (const a of actions) console.log(`  - ${describeAction(a)}`)
  console.log()

  if (args.dryRun) {
    console.log(t('(dry run — no changes made)', '(演练模式 —— 未做任何更改)'))
    return 0
  }
  // Reaching this point may already have cost an OTP (trust reads); a stray
  // Enter must not throw that away.
  if (!(await confirmGuarded(t('Proceed with these actions?', '执行以上操作?'), args.yes))) {
    console.log(t('Aborted.', '已中止。'))
    return 0
  }

  await executeActions(actions, writer)
  console.log('\n' + t('✓ sync complete.', '✓ 同步完成。'))
  return 0
}

/** Fail fast rather than issue `DELETE …/trust/` with an empty id. */
function bindingId(actual: TrustConfig, name: string): string {
  if (!actual.id) throw new Error(`registry returned a trust config without an id for ${name}`)
  return actual.id
}

function describeAction(a: Action): string {
  switch (a.kind) {
    case 'create': {
      return t(
        `create binding ${a.name} → ${describeBinding(a.desired)}`,
        `创建绑定 ${a.name} → ${describeBinding(a.desired)}`,
      )
    }
    case 'publish': {
      return a.placeholder
        ? t(`publish ${a.name} (placeholder version)`, `发布 ${a.name}(占位版本)`)
        : t(`publish ${a.name}`, `发布 ${a.name}`)
    }
    case 'reconcile': {
      return t(
        `reconcile ${a.name}: revoke ${a.oldId} + create ${describeBinding(a.desired)}`,
        `调整 ${a.name}:撤销 ${a.oldId} 并创建 ${describeBinding(a.desired)}`,
      )
    }
    case 'warnMissingWorkflow': {
      return t(
        `warn ${a.name}: missing workflow ${a.workflow}`,
        `警告 ${a.name}:缺少 workflow ${a.workflow}`,
      )
    }
  }
}

async function executeAction(
  a: Action,
  writer: Writer,
  spaceWrites: () => Promise<void>,
  publishOtp: () => Promise<string | undefined>,
): Promise<void> {
  switch (a.kind) {
    case 'create': {
      await spaceWrites()
      console.log(
        t(
          `→ creating binding for ${a.name}: ${describeBinding(a.desired)}`,
          `→ 正在为 ${a.name} 创建绑定:${describeBinding(a.desired)}`,
        ),
      )
      await writer.create(a.name, a.desired)
      break
    }
    case 'publish': {
      publish(a.name, a.dir, a.placeholder, await publishOtp())
      break
    }
    case 'reconcile': {
      await spaceWrites()
      console.log(
        t(
          `→ revoking old binding ${a.oldId} for ${a.name}`,
          `→ 正在撤销 ${a.name} 的旧绑定 ${a.oldId}`,
        ),
      )
      await writer.revoke(a.name, a.oldId)
      await spaceWrites()
      console.log(
        t(
          `→ creating binding for ${a.name}: ${describeBinding(a.desired)}`,
          `→ 正在为 ${a.name} 创建绑定:${describeBinding(a.desired)}`,
        ),
      )
      await writer.create(a.name, a.desired)
      break
    }
    case 'warnMissingWorkflow': {
      process.stderr.write(
        t(
          `⚠ ${a.name}: workflow file .github/workflows/${a.workflow} not found in repo — ` +
            'the binding will exist but publishes will fail until you add it.',
          `⚠ ${a.name}:仓库中没有 .github/workflows/${a.workflow} —— ` +
            '绑定会创建,但在补上该文件之前发布会失败。',
        ) + '\n',
      )
      break
    }
  }
}

async function executeActions(actions: Action[], writer: Writer): Promise<void> {
  let first = true
  const spaceWrites = async (): Promise<void> => {
    if (first) {
      first = false
      return
    }
    await sleep(WRITE_SPACING_MS)
  }

  // Asked at most once, and only if a publish is actually reached: one OTP covers
  // the publishes and the trust writes that follow, inside the same ~5-min window.
  let otp: string | undefined
  let asked = false
  const publishOtp = async (): Promise<string | undefined> => {
    if (!asked) {
      asked = true
      otp = await promptPublishOtp()
      if (otp) writer.setOtp(otp)
    }
    return otp
  }

  for (const a of actions) {
    await executeAction(a, writer, spaceWrites, publishOtp)
  }
}

/** Actions needed to bring one package to the desired state. */
function planActions(p: PackagePlan, pkg: DiscoveredPackage | undefined, args: SyncArgs): Action[] {
  switch (p.status) {
    case 'drift': {
      if (!(p.actual && p.desired)) return []
      const rebind: Action = {
        kind: 'reconcile',
        name: p.name,
        oldId: bindingId(p.actual, p.name),
        desired: p.desired,
      }
      return [...workflowWarnings(p, pkg), rebind]
    }
    case 'missing': {
      if (!p.desired) return []
      const create: Action = { kind: 'create', name: p.name, desired: p.desired }
      return [...workflowWarnings(p, pkg), create]
    }
    case 'unpublished': {
      if (args.noPublish) {
        process.stderr.write(
          t(
            `skip ${p.name}: unpublished and --no-publish set`,
            `跳过 ${p.name}:未发布且指定了 --no-publish`,
          ) + '\n',
        )
        return []
      }
      const actions: Action[] = [
        { kind: 'publish', name: p.name, dir: pkg?.dir, placeholder: args.placeholder },
      ]
      if (p.desired) actions.push({ kind: 'create', name: p.name, desired: p.desired })
      return actions
    }
    default: {
      return [] // correct / unknown / no_binding / untracked
    }
  }
}

/**
 * First-publish for sync. `--placeholder` publishes a generated minimal package
 * from a temp dir (works even for gh-only sources with no local checkout);
 * otherwise runs `npm publish` in the package's real directory.
 */
function publish(name: string, dir: string | undefined, placeholder: boolean, otp?: string): void {
  if (placeholder) {
    publishPlaceholder(name, otp)
    return
  }
  if (!dir) {
    throw new Error(
      t(
        `cannot publish ${name}: no local package directory (gh-only source) — use --placeholder`,
        `无法发布 ${name}:没有本地包目录(仅来自 GitHub 扫描)—— 请使用 --placeholder`,
      ),
    )
  }
  console.log(
    t(
      `→ publishing ${name} via npm publish in ${dir}`,
      `→ 正在 ${dir} 中用 npm publish 发布 ${name}`,
    ),
  )
  const { cmd, prefix } = npmCommand()
  // Pin the registry so the publish matches where the trust API writes.
  const publishArgs = [...prefix, 'publish', '--registry', DEFAULT_REGISTRY]
  // Scoped packages default to restricted on first publish.
  if (name.startsWith('@')) publishArgs.push('--access', 'public')
  // Supplied up front so npm never issues its browser-based 2FA challenge.
  if (otp) publishArgs.push(`--otp=${otp}`)
  const res = spawnSync(cmd, publishArgs, { cwd: dir, stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`npm publish failed for ${name}`)
}

function workflowWarnings(p: PackagePlan, pkg: DiscoveredPackage | undefined): Action[] {
  if (!(pkg?.dir && p.workflow)) return []
  const wfPath = path.join(pkg.dir, '.github', 'workflows', p.workflow)
  if (existsSync(wfPath)) return []
  return [{ kind: 'warnMissingWorkflow', name: p.name, workflow: p.workflow }]
}
