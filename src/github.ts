//! GitHub REST helpers — anonymous by default, no `gh` CLI dependency.
//! A `GITHUB_TOKEN` / `GH_TOKEN` env var, when present, raises the rate limit
//! (60 → 5000 req/h) and makes private repos visible.

const API = 'https://api.github.com'
const TIMEOUT_MS = 15_000

/** Fetch a repo's root `package.json` (parsed); undefined if absent/unreadable. */
export async function fetchRepoPackageJson(
  ownerRepo: string,
): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(`${API}/repos/${ownerRepo}/contents/package.json`, {
    // vnd.github.raw returns the file body directly (no base64 envelope).
    headers: headers('application/vnd.github.raw+json'),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) return undefined // 404 no package.json; 403/451 not accessible
  try {
    return JSON.parse(await res.text()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * List `owner/repo` names for a user or org (`/users/…/repos` serves both),
 * newest-updated first, up to `limit`.
 */
export async function listRepos(owner: string, limit: number): Promise<string[]> {
  const names: string[] = []
  for (let page = 1; names.length < limit; page++) {
    const perPage = Math.min(100, limit - names.length)
    const url = `${API}/users/${owner}/repos?per_page=${perPage}&page=${page}&sort=updated`
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.status === 404) throw new Error(`GitHub user/org \`${owner}\` not found`)
    if (!res.ok) throw new Error(`GitHub API returned ${res.status} listing repos for ${owner}`)
    const batch = (await res.json()) as Array<{ full_name?: string }>
    for (const r of batch) if (typeof r.full_name === 'string') names.push(r.full_name)
    if (batch.length < perPage) break // last page
  }
  return names
}

/** Repo existence check: 200 → true, 404 → false, anything else throws. */
export async function repoExists(ownerRepo: string): Promise<boolean> {
  const res = await fetch(`${API}/repos/${ownerRepo}`, {
    headers: headers(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (res.status === 200) return true
  if (res.status === 404) return false
  throw new Error(`GitHub API returned ${res.status} for ${ownerRepo}`)
}

function headers(accept = 'application/vnd.github+json'): Record<string, string> {
  const h: Record<string, string> = { 'user-agent': 'npt/0.2.0', accept }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) h['authorization'] = `Bearer ${token}`
  return h
}
