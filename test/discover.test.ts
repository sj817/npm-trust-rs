//! Repository normalization + owner/repo validation, porting `discover.rs` tests.

import { describe, expect, it } from 'vitest'

import { normalizeGithub, parseRepository, validateOwnerRepo } from '../src/discover'

describe('normalizeGithub', () => {
  it('parses various repository forms to owner/repo', () => {
    const cases: Array<[string, string]> = [
      ['git+https://github.com/npm/cli.git', 'npm/cli'],
      ['https://github.com/npm/cli', 'npm/cli'],
      ['git@github.com:npm/cli.git', 'npm/cli'],
      ['github:npm/cli', 'npm/cli'],
      ['npm/cli', 'npm/cli'],
    ]
    for (const [input, want] of cases) {
      expect(normalizeGithub(input)).toBe(want)
    }
    expect(normalizeGithub('https://gitlab.com/a/b')).toBeUndefined()
  })

  it('parses the object repository field', () => {
    expect(parseRepository({ type: 'git', url: 'git+https://github.com/o/r.git' })).toBe('o/r')
  })
})

describe('validateOwnerRepo', () => {
  it('accepts bare and URL forms', () => {
    expect(validateOwnerRepo('npm/cli')).toBe('npm/cli')
    expect(validateOwnerRepo('https://github.com/npm/cli')).toBe('npm/cli')
    expect(validateOwnerRepo('git@github.com:npm/cli.git')).toBe('npm/cli')
  })

  it('rejects malformed inputs', () => {
    for (const bad of ['', 'just-owner', 'a/b/c/d/e', 'own er/repo', 'owner/']) {
      expect(() => validateOwnerRepo(bad)).toThrow()
    }
  })
})
