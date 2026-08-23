//! Small helpers shared by the batch commands.

import { t } from '../i18n'
import { discoverGithub, discoverLocal } from '../discover'

import type { DiscoveredPackage } from '../discover'

/** Sort by name in codepoint order — deliberately not localeCompare, so the
 * order is stable across machines/locales (CI diffs stay reproducible). */
export function byteSortByName(packages: DiscoveredPackage[]): void {
  // eslint-disable-next-line unicorn/prefer-simple-sort-comparator -- localeCompare would change the order
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Drop later duplicates by name (call after {@link byteSortByName}). */
export function dedupByName(packages: DiscoveredPackage[]): DiscoveredPackage[] {
  const seen = new Set<string>()
  const out: DiscoveredPackage[] = []
  for (const p of packages) {
    if (seen.has(p.name)) continue
    seen.add(p.name)
    out.push(p)
  }
  return out
}

/**
 * The shared discovery pipeline: local dirs + optional GitHub org/user, sorted
 * and deduped. A GitHub failure warns and continues with local results.
 */
export async function discoverAll(
  dirs: string[],
  org: string | undefined,
  limit: number,
): Promise<DiscoveredPackage[]> {
  const packages = dirs.length > 0 ? discoverLocal(dirs) : []
  if (org) {
    try {
      packages.push(...(await discoverGithub(org, limit)))
    } catch (error) {
      process.stderr.write(
        t(`⚠ GitHub discovery skipped: ${errMsg(error)}`, `⚠ 已跳过 GitHub 扫描:${errMsg(error)}`) +
          '\n',
      )
    }
  }
  byteSortByName(packages)
  return dedupByName(packages)
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const sleep = (ms: number): Promise<void> =>
  new Promise(r => {
    setTimeout(r, ms)
  })
