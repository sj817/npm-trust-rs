//! `npt audit` — CI-friendly drift check (returns non-zero exit code on drift).

import { t } from '../i18n'
import { discoverAll } from './util'
import { assess, describeBinding, resolveClient, statusLabel } from '../engine'

import type { PackagePlan } from '../engine'

export interface AuditArgs {
  dir: string[]
  environment?: string
  json: boolean
  limit: number
  org?: string
  workflow?: string
}

/** Returns the process exit code: 1 on drift, 0 when clean. */
export async function runAudit(args: AuditArgs): Promise<number> {
  const dirs = args.dir.length > 0 ? args.dir : ['.']
  const packages = await discoverAll(dirs, args.org, args.limit)

  const { client, valid } = await resolveClient(true)
  const plans = await assess(client, valid, packages, args.workflow, args.environment)
  const drifted = plans.filter(p => isDrift(p))

  if (args.json) {
    const out = {
      drift: drifted.length > 0,
      drift_count: drifted.length,
      packages: plans.map(p => ({
        name: p.name,
        published: p.published,
        status: statusLabel(p.status),
        desired: p.desired ? describeBinding(p.desired) : null,
        actual: p.actual ? describeBinding(p.actual) : null,
      })),
    }
    console.log(JSON.stringify(out, null, 2))
  } else if (drifted.length === 0) {
    console.log(
      t(
        `✓ audit clean — all expected bindings match (${plans.length} packages).`,
        `✓ 审计通过 —— 所有期望的绑定均一致(共 ${plans.length} 个包)。`,
      ),
    )
  } else {
    console.log(
      t(`✗ audit found ${drifted.length} drift(s):`, `✗ 审计发现 ${drifted.length} 处漂移:`),
    )
    for (const p of drifted) {
      const want = p.desired ? describeBinding(p.desired) : '-'
      const have = p.actual ? describeBinding(p.actual) : statusLabel(p.status)
      console.log(
        t(`  - ${p.name}: want ${want}, have ${have}`, `  - ${p.name}:期望 ${want},实际 ${have}`),
      )
    }
  }

  return drifted.length > 0 ? 1 : 0
}

function isDrift(p: PackagePlan): boolean {
  return (
    p.status === 'drift' ||
    p.status === 'missing' ||
    // An unreadable trust list is not a clean audit. The registry requires an OTP
    // to read it, so `unknown` is what a token-only CI run sees for every package;
    // treating it as clean turns the check into an unconditional pass.
    p.status === 'unknown' ||
    (p.status === 'unpublished' && p.desired !== undefined)
  )
}
