//! `npt scan` — read-only inventory of packages and their trust bindings.

import { t } from '../i18n'
import { discoverAll } from './util'
import { assess, describeBinding, resolveClient, statusLabel } from '../engine'

import type { PackagePlan } from '../engine'

export interface ScanArgs {
  dir: string[]
  environment?: string
  limit: number
  org?: string
  workflow?: string
}

export function printTable(plans: PackagePlan[]): void {
  if (plans.length === 0) {
    console.log(t('No public packages found.', '未找到公开包。'))
    return
  }
  const nameW = Math.max(7, ...plans.map(p => p.name.length))
  console.log(
    `${'PACKAGE'.padEnd(nameW)}  ${'PUBLISHED'.padEnd(9)}  ${'STATUS'.padEnd(20)}  TARGET / CURRENT`,
  )
  for (const p of plans) {
    const target = p.actual
      ? describeBinding(p.actual)
      : p.desired
        ? `want ${describeBinding(p.desired)}`
        : p.repository
          ? `repo ${p.repository}`
          : '-'
    console.log(
      `${p.name.padEnd(nameW)}  ${(p.published ? 'yes' : 'no').padEnd(9)}  ${statusLabel(p.status).padEnd(20)}  ${target}`,
    )
  }
}

export async function runScan(args: ScanArgs): Promise<void> {
  // Explicit dirs win; with --org, GitHub-only; otherwise default to `.`.
  const dirs = args.dir.length > 0 ? args.dir : args.org ? [] : ['.']
  const packages = await discoverAll(dirs, args.org, args.limit)

  const { client, valid } = await resolveClient(false)
  const plans = await assess(client, valid, packages, args.workflow, args.environment)
  printTable(plans)
}
