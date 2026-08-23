//! Credential resolution from `~/.npmrc` and the environment.

import path from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'

export const DEFAULT_REGISTRY_HOST = '//registry.npmjs.org/'

export interface Credential {
  source: CredentialSource
  token: string
}

export type CredentialSource = { kind: 'env' } | { kind: 'npmrc'; path: string }

/** Human label for a credential source (a path, or `$NPM_TOKEN`). */
export function credentialSourceLabel(s: CredentialSource): string {
  return s.kind === 'npmrc' ? s.path : '$NPM_TOKEN'
}

/**
 * Resolve an auth token, in priority order:
 *   1. `//registry.npmjs.org/:_authToken` in the user `.npmrc`
 *   2. `$NPM_TOKEN` (trimmed, non-empty)
 *   3. none
 */
export function resolveToken(): Credential | undefined {
  const path = userNpmrcPath()
  if (path) {
    let contents: string | undefined
    try {
      contents = readFileSync(path, 'utf8')
    } catch {
      contents = undefined
    }
    if (contents !== undefined) {
      const tok = tokenFromNpmrcStr(contents, DEFAULT_REGISTRY_HOST)
      if (tok) return { token: tok, source: { kind: 'npmrc', path } }
    }
  }
  const env = process.env.NPM_TOKEN?.trim()
  if (env) return { token: env, source: { kind: 'env' } }
  return undefined
}

/**
 * Extract `<registryHost>:_authToken` from `.npmrc` contents. Skips blank / `#` /
 * `;` lines, matches the key exactly, unquotes, and expands `${VAR}` (any unset
 * referenced var makes the whole value unusable → undefined).
 */
export function tokenFromNpmrcStr(contents: string, registryHost: string): string | undefined {
  const key = `${registryHost}:_authToken`
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq).trim() !== key) continue
    const expanded = expandEnv(unquote(line.slice(eq + 1).trim()))
    if (expanded && expanded.length > 0) return expanded
  }
  return undefined
}

/** Path of the user `.npmrc`: `$NPM_CONFIG_USERCONFIG` or `~/.npmrc`. */
export function userNpmrcPath(): string | undefined {
  const override = process.env.NPM_CONFIG_USERCONFIG
  if (override && override.length > 0) return override
  const home = homedir()
  return home ? path.join(home, '.npmrc') : undefined
}

/** Expand every `${VAR}`; if any referenced var is unset, return undefined. */
function expandEnv(value: string): string | undefined {
  if (!value.includes('${')) return value
  let result = ''
  let i = 0
  while (i < value.length) {
    const start = value.indexOf('${', i)
    if (start === -1) {
      result += value.slice(i)
      break
    }
    result += value.slice(i, start)
    const end = value.indexOf('}', start + 2)
    if (end === -1) {
      result += value.slice(start)
      break
    }
    const v = process.env[value.slice(start + 2, end)]
    if (v === undefined) return undefined
    result += v
    i = end + 1
  }
  return result
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s[0]
    const last = s.at(-1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1)
    }
  }
  return s
}
