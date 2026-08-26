//! Placeholder-provisioning naming rules: prefix derivation, platform suffix
//! vocabularies, and the package-name validators the prompts lean on.

import { describe, expect, it } from 'vitest'

import {
  ALL_TARGETS,
  DEFAULT_BASE_WORD,
  DEFAULT_TARGET_IDS,
  derivePrefix,
  MAX_NAME_LENGTH,
  platformPackageName,
  platformSuffix,
  targetId,
  validateBaseWord,
  validatePackageName,
  validatePrefix,
} from '../src/naming'

import type { PlatformNaming, PlatformTarget } from '../src/naming'

const LINUX_X64: PlatformTarget = { os: 'linux', arch: 'x64' }
const WIN_ARM: PlatformTarget = { os: 'win32', arch: 'arm64' }
const MUSL: PlatformTarget = { os: 'linux', arch: 'x64', libc: 'musl' }

describe('platformSuffix', () => {
  it('renders each vocabulary', () => {
    const cases: Array<[PlatformNaming, PlatformTarget, string]> = [
      ['node', LINUX_X64, 'linux-x64'],
      ['node', WIN_ARM, 'win32-arm64'],
      ['go', LINUX_X64, 'linux-amd64'],
      ['go', WIN_ARM, 'windows-arm64'],
      ['short', { os: 'darwin', arch: 'arm64' }, 'mac-arm64'],
      ['short', WIN_ARM, 'win-arm64'],
    ]
    for (const [naming, target, want] of cases) {
      expect(platformSuffix(target, naming)).toBe(want)
    }
  })

  it('marks musl builds in every vocabulary', () => {
    expect(platformSuffix(MUSL, 'node')).toBe('linux-x64-musl')
    expect(platformSuffix(MUSL, 'short')).toBe('linux-amd64-musl')
  })
})

describe('derivePrefix', () => {
  it('collapses into one scope', () => {
    expect(derivePrefix('axios', 'scoped', DEFAULT_BASE_WORD)).toBe('@axios/native')
    expect(derivePrefix('@shotkit/node', 'scoped', DEFAULT_BASE_WORD)).toBe('@shotkit/native')
    expect(derivePrefix('@shotkit/node', 'scoped', 'binary')).toBe('@shotkit/binary')
  })

  it('reuses the primary name', () => {
    expect(derivePrefix('axios', 'suffix', DEFAULT_BASE_WORD)).toBe('axios')
    expect(derivePrefix('@shotkit/node', 'suffix', DEFAULT_BASE_WORD)).toBe('@shotkit/node')
  })
})

describe('platformPackageName', () => {
  it('composes the full matrix name', () => {
    expect(platformPackageName('@shotkit/node', LINUX_X64, 'node')).toBe('@shotkit/node-linux-x64')
    expect(platformPackageName('@axios/native', WIN_ARM, 'short')).toBe('@axios/native-win-arm64')
  })
})

describe('the default matrix', () => {
  it('pre-checks the six non-musl slots', () => {
    const checked = ALL_TARGETS.filter(target => DEFAULT_TARGET_IDS.has(targetId(target)))
    expect(checked).toHaveLength(6)
    expect(checked.every(target => target.libc === undefined)).toBe(true)
  })

  it('gives every slot a distinct id', () => {
    expect(new Set(ALL_TARGETS.map(target => targetId(target))).size).toBe(ALL_TARGETS.length)
  })
})

describe('validatePackageName', () => {
  it('accepts plain and scoped names', () => {
    expect(validatePackageName(' axios ')).toBe('axios')
    expect(validatePackageName('@shotkit/node')).toBe('@shotkit/node')
    expect(validatePackageName('some.pkg_name-1')).toBe('some.pkg_name-1')
  })

  it('rejects malformed names', () => {
    for (const bad of ['', 'Axios', '@shotkit', 'has space', '.leading', '_leading', 'a/b']) {
      expect(() => validatePackageName(bad)).toThrow()
    }
    expect(() => validatePackageName('a'.repeat(MAX_NAME_LENGTH + 1))).toThrow()
  })
})

describe('validatePrefix', () => {
  it('rejects a trailing separator', () => {
    expect(() => validatePrefix('@shotkit/node-')).toThrow()
  })

  it('rejects a prefix with no room left for the suffix', () => {
    expect(() => validatePrefix('a'.repeat(MAX_NAME_LENGTH - 4))).toThrow()
  })
})

describe('validateBaseWord', () => {
  it('lowercases and accepts a bare segment', () => {
    expect(validateBaseWord(' Native ')).toBe('native')
  })

  it('rejects anything with a scope or slash', () => {
    for (const bad of ['', '@native', 'na/tive', '_native']) {
      expect(() => validateBaseWord(bad)).toThrow()
    }
  })
})
