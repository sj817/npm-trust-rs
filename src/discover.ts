//! Package discovery — from local directories (incl. monorepo workspaces) and,
//! optionally, from GitHub repos via the anonymous REST API.

import path from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'

import { fetchRepoPackageJson, listRepos } from './github'

/** A package.json we found and care about. */
export interface DiscoveredPackage {
  /** Local directory containing the package.json (undefined for gh-sourced). */
  dir?: string
  name: string
  private: boolean
  /** `owner/repo` parsed from the `repository` field, if any. */
  repository?: string
}

/** How many repo `package.json` fetches run at once during GitHub discovery. */
const GITHUB_FETCH_CONCURRENCY = 8

/**
 * Discover packages from a GitHub org/user by listing repos via the REST API and
 * reading each repo's root `package.json`. Anonymous; set `GITHUB_TOKEN` for a
 * higher rate limit and private-repo visibility.
 */
export async function discoverGithub(owner: string, limit: number): Promise<DiscoveredPackage[]> {
  const repos = await listRepos(owner, limit)
  const pkgs: DiscoveredPackage[] = []
  for (let i = 0; i < repos.length; i += GITHUB_FETCH_CONCURRENCY) {
    const batch = repos.slice(i, i + GITHUB_FETCH_CONCURRENCY)
    // Awaited per batch on purpose: bounded concurrency keeps the GitHub API happy.
    const found = await Promise.all(batch.map(repo => repoToDiscovered(repo)))
    for (const pkg of found) if (pkg) pkgs.push(pkg)
  }
  return pkgs
}

async function repoToDiscovered(repo: string): Promise<DiscoveredPackage | undefined> {
  const raw = await fetchRepoPackageJson(repo)
  if (!raw) return undefined
  const name = typeof raw.name === 'string' ? raw.name : undefined
  if (!name) return undefined
  return {
    name,
    repository: parseRepository(raw.repository) ?? repo,
    private: raw.private === true,
    dir: undefined,
  }
}

/** Discover packages under the given local directories (recursive). */
export function discoverLocal(dirs: string[]): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = []
  for (const dir of dirs) walk(dir, out)
  return out
}

/** Normalize common GitHub repository forms to `owner/repo` (GitHub-only). */
export function normalizeGithub(raw: string): string | undefined {
  let s = raw.trim()
  if (s.startsWith('git+')) s = s.slice(4)

  let tail: string
  if (s.startsWith('github:')) {
    tail = s.slice('github:'.length)
  } else {
    const idx = s.indexOf('github.com')
    if (idx !== -1) {
      tail = s.slice(idx + 'github.com'.length).replace(/^[:/]+/, '')
    } else if ((s.match(/\//g)?.length ?? 0) === 1 && !s.includes(':')) {
      tail = s // bare owner/repo
    } else {
      return undefined
    }
  }
  tail = tail.replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = tail.split('/').filter(p => p.length > 0)
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
}

/** Parse `owner/repo` out of npm's `repository` field (string or `{ url }`). */
export function parseRepository(value: unknown): string | undefined {
  let raw: string | undefined
  if (typeof value === 'string') {
    raw = value
  } else if (value && typeof value === 'object') {
    const url = (value as Record<string, unknown>).url
    if (typeof url === 'string') raw = url
  }
  return raw === undefined ? undefined : normalizeGithub(raw)
}

/**
 * Strictly validate and normalize a user-entered GitHub `owner/repo`. Accepts a
 * bare `owner/repo` or a full GitHub URL; throws on anything else.
 */
export function validateOwnerRepo(input: string): string {
  const normalized = normalizeGithub(input)
  if (!normalized) throw new Error('expected `owner/repo` or a GitHub URL')
  const slash = normalized.indexOf('/')
  const owner = normalized.slice(0, slash)
  if (!validSeg(owner, 39)) throw new Error(`invalid GitHub owner \`${owner}\``)
  const repo = normalized.slice(slash + 1)
  if (!validSeg(repo, 100)) throw new Error(`invalid GitHub repo \`${repo}\``)
  return normalized
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function readPkgJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function toDiscovered(raw: Record<string, unknown>, dir: string): DiscoveredPackage | undefined {
  const name = typeof raw.name === 'string' ? raw.name : undefined
  if (!name) return undefined
  return {
    name,
    repository: parseRepository(raw.repository),
    private: raw.private === true,
    dir,
  }
}

function validSeg(s: string, max: number): boolean {
  return s.length > 0 && s.length <= max && /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..'
}

function walk(dir: string, out: DiscoveredPackage[]): void {
  const pkgPath = path.join(dir, 'package.json')
  if (isFile(pkgPath)) {
    const raw = readPkgJson(pkgPath)
    if (raw) {
      const found = toDiscovered(raw, dir)
      if (found) out.push(found)
    }
  }
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    if (isDir(p)) walk(p, out)
  }
}
