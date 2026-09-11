//! Naming rules for batch placeholder provisioning: how a primary package name
//! (or a bare prefix) expands into per-platform sub-package names.
//!
//! Nothing here touches the network or the filesystem — it is pure string work,
//! so the matrix a run is about to publish can be previewed (and unit-tested)
//! before a single `npm publish` fires.

import { t } from './i18n'

/** Which kinds of packages a provisioning run reserves. */
export type ArtifactKind = 'platform' | 'primary'

/** How the platform sub-package prefix is derived from the primary name. */
export type NamingScheme = 'custom' | 'scoped' | 'suffix'

/** Vocabulary for the `<os>-<arch>` token appended to the prefix. */
export type PlatformNaming = 'go' | 'node' | 'short'

/** One OS/CPU (plus libc flavour) slot in the platform matrix. */
export interface PlatformTarget {
  arch: 'arm64' | 'x64'
  /** Only meaningful on linux; `undefined` means the glibc build. */
  libc?: 'musl'
  os: 'darwin' | 'linux' | 'win32'
}

/** Base word for the `scoped` scheme: `@scope/native-<os>-<arch>`. */
export const DEFAULT_BASE_WORD = 'native'

/** npm's hard limit on a package name (scope included). */
export const MAX_NAME_LENGTH = 214

/** Every slot the matrix prompt offers, in display order. */
export const ALL_TARGETS: PlatformTarget[] = [
  { os: 'linux', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'darwin', arch: 'arm64' },
  { os: 'win32', arch: 'x64' },
  { os: 'win32', arch: 'arm64' },
  { os: 'linux', arch: 'x64', libc: 'musl' },
  { os: 'linux', arch: 'arm64', libc: 'musl' },
]

/**
 * Pre-checked slots: the six glibc/msvc combinations almost every native addon
 * ships. musl builds are opt-in — they need a separate toolchain.
 */
export const DEFAULT_TARGET_IDS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
])

const OS_TOKENS: Record<PlatformNaming, Record<PlatformTarget['os'], string>> = {
  go: { darwin: 'darwin', linux: 'linux', win32: 'windows' },
  node: { darwin: 'darwin', linux: 'linux', win32: 'win32' },
  short: { darwin: 'mac', linux: 'linux', win32: 'win' },
}

const ARCH_TOKENS: Record<PlatformNaming, Record<PlatformTarget['arch'], string>> = {
  go: { arm64: 'arm64', x64: 'amd64' },
  node: { arm64: 'arm64', x64: 'x64' },
  short: { arm64: 'arm64', x64: 'x64' },
}

/** Segment charset npm accepts inside a (scoped) name. */
const SEGMENT = /^[a-z0-9\-._~]+$/

/**
 * Derive the platform prefix from the primary name. (`custom` never reaches
 * here — that scheme takes the prefix straight from the user.)
 *
 * - `scoped`: collapse into one scope — `axios` → `@axios/native-…`
 * - `suffix`: reuse the primary name  — `@shotkit/node` → `@shotkit/node-…`
 */
export function derivePrefix(
  primary: string,
  scheme: Exclude<NamingScheme, 'custom'>,
  baseWord: string,
): string {
  if (scheme === 'suffix') return primary
  const scope = primary.startsWith('@') ? primary.slice(1, primary.indexOf('/')) : primary
  return `@${scope}/${baseWord}`
}

/**
 * Whether an `optionalDependencies` entry of `primary` looks like one of its own
 * platform sub-packages, so the registry-derived list can be pre-ticked without
 * dragging in `fsevents` and friends. Scoped primaries claim their whole scope
 * (`@shotkit/node` → `@shotkit/linux-x64`); bare ones claim `<name>-…` and the
 * `@<name>/…` scope (`esbuild` → `@esbuild/linux-x64`).
 */
export function isPlatformSibling(primary: string, candidate: string): boolean {
  const scopeOf = (name: string): string | undefined =>
    name.startsWith('@') ? name.slice(1, name.indexOf('/')) : undefined
  const primaryScope = scopeOf(primary)
  const candidateScope = scopeOf(candidate)
  if (candidateScope !== undefined) {
    return candidateScope === (primaryScope ?? primary)
  }
  return primaryScope === undefined && candidate.startsWith(`${primary}-`)
}

/** `<prefix>-<os>-<arch>[-musl]`. */
export function platformPackageName(
  prefix: string,
  target: PlatformTarget,
  naming: PlatformNaming,
): string {
  return `${prefix}-${platformSuffix(target, naming)}`
}

/** The `<os>-<arch>[-musl]` token on its own, in the chosen vocabulary. */
export function platformSuffix(target: PlatformTarget, naming: PlatformNaming): string {
  const base = `${OS_TOKENS[naming][target.os]}-${ARCH_TOKENS[naming][target.arch]}`
  return target.libc ? `${base}-${target.libc}` : base
}

/** Stable identity for a matrix slot (node vocabulary), used as a choice value. */
export function targetId(target: PlatformTarget): string {
  return platformSuffix(target, 'node')
}

/** A one-line sample of what a vocabulary produces, for the style prompt. */
export function vocabularySample(naming: PlatformNaming): string {
  return ALL_TARGETS.slice(0, 6)
    .filter((_, i) => i % 2 === 0)
    .map(target => platformSuffix(target, naming))
    .join(' · ')
}

/** Validate the word plugged into the `scoped` scheme (`native` by default). */
export function validateBaseWord(input: string): string {
  const s = input.trim().toLowerCase()
  if (s === '') throw new Error(t('a base word is required.', '基础词不能为空。'))
  if (!SEGMENT.test(s) || s.startsWith('.') || s.startsWith('_')) {
    throw new Error(
      t(
        'use lowercase letters, digits, `-`, `.`, `_` or `~` only.',
        '只能使用小写字母、数字和 - . _ ~ 。',
      ),
    )
  }
  return s
}

/**
 * Validate an npm package name, mirroring the subset of `validate-npm-package-name`
 * that matters for a fresh publish (new names cannot use the legacy escapes that
 * older packages are grandfathered into).
 */
export function validatePackageName(input: string): string {
  const s = input.trim()
  if (s === '') throw new Error(t('a package name is required.', '包名不能为空。'))
  if (s.length > MAX_NAME_LENGTH) {
    throw new Error(
      t(
        `name is longer than ${MAX_NAME_LENGTH} characters.`,
        `包名超过 ${MAX_NAME_LENGTH} 个字符。`,
      ),
    )
  }
  if (s !== s.toLowerCase()) {
    throw new Error(t('package names must be lowercase.', '包名必须全小写。'))
  }

  let bare = s
  if (s.startsWith('@')) {
    const slash = s.indexOf('/')
    if (slash === -1) {
      throw new Error(
        t('scoped names look like `@scope/name`.', '带 scope 的包名形如 @scope/name。'),
      )
    }
    const scope = s.slice(1, slash)
    if (!SEGMENT.test(scope)) {
      throw new Error(t(`invalid scope \`@${scope}\`.`, `scope \`@${scope}\` 不合法。`))
    }
    bare = s.slice(slash + 1)
  }
  if (!SEGMENT.test(bare) || bare.startsWith('.') || bare.startsWith('_')) {
    throw new Error(
      t(
        'use lowercase letters, digits, `-`, `.`, `_` or `~` only (and no leading `.`/`_`).',
        '只能使用小写字母、数字和 - . _ ~ ,且不能以 . 或 _ 开头。',
      ),
    )
  }
  return s
}

/**
 * Validate a platform prefix: a valid package name that also leaves room for the
 * `-<os>-<arch>` token and does not already end in a separator.
 */
export function validatePrefix(input: string): string {
  const s = validatePackageName(input)
  if (s.endsWith('-') || s.endsWith('.') || s.endsWith('_')) {
    throw new Error(
      t(
        'drop the trailing separator — the `-<os>-<arch>` suffix adds its own.',
        '结尾不要带分隔符 —— 后面会自动拼 -<os>-<arch>。',
      ),
    )
  }
  // Longest token any vocabulary can append, so the prompt rejects a too-long
  // prefix instead of failing halfway through the batch.
  const longest = Math.max(
    ...ALL_TARGETS.map(target =>
      Math.max(
        ...(['go', 'node', 'short'] as PlatformNaming[]).map(
          naming => platformSuffix(target, naming).length,
        ),
      ),
    ),
  )
  if (s.length + 1 + longest > MAX_NAME_LENGTH) {
    throw new Error(
      t('prefix leaves no room for the platform suffix.', '前缀过长,拼上平台后缀会超长。'),
    )
  }
  return s
}
