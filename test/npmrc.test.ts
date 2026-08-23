//! `.npmrc` token extraction, porting the Rust `npmrc.rs` unit tests.

import { afterEach, describe, expect, it } from 'vitest'

import { tokenFromNpmrcStr } from '../src/registry/index'

const HOST = '//registry.npmjs.org/'

afterEach(() => {
  delete process.env.NPM_TRUST_TEST_TOK
})

describe('tokenFromNpmrcStr', () => {
  it('reads a plain token', () => {
    expect(tokenFromNpmrcStr(`${HOST}:_authToken=abc123`, HOST)).toBe('abc123')
  })

  it('ignores comments and other-host keys', () => {
    const contents = [
      '# a comment',
      '; another comment',
      '//other.org/:_authToken=WRONG',
      `${HOST}:_authToken=right`,
    ].join('\n')
    expect(tokenFromNpmrcStr(contents, HOST)).toBe('right')
  })

  it('strips surrounding quotes', () => {
    expect(tokenFromNpmrcStr(`${HOST}:_authToken="quoted"`, HOST)).toBe('quoted')
    expect(tokenFromNpmrcStr(`${HOST}:_authToken='quoted'`, HOST)).toBe('quoted')
  })

  // eslint-disable-next-line no-template-curly-in-string -- literal `${VAR}` syntax is the subject under test
  it('expands ${VAR} from the environment', () => {
    process.env.NPM_TRUST_TEST_TOK = 'from-env'
    expect(tokenFromNpmrcStr(`${HOST}:_authToken=\${NPM_TRUST_TEST_TOK}`, HOST)).toBe('from-env')
  })

  it('returns undefined when a referenced var is unset', () => {
    expect(
      tokenFromNpmrcStr(`${HOST}:_authToken=\${DEFINITELY_UNSET_VAR_XYZ}`, HOST),
    ).toBeUndefined()
  })

  it('returns undefined when the key is absent', () => {
    expect(tokenFromNpmrcStr('registry=https://example.com', HOST)).toBeUndefined()
  })
})
