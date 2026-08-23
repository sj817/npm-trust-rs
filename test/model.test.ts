//! Model serialization + `sameBinding`, porting the Rust `model.rs` unit tests.

import { describe, expect, it } from 'vitest'

import {
  githubTrust,
  gitlabTrust,
  Permission,
  permissionLabel,
  sameBinding,
} from '../src/registry/index'

// Not a deep-clone: JSON round-trip deliberately drops `undefined` members so
// assertions see exactly what would go on the wire.
// eslint-disable-next-line unicorn/prefer-structured-clone
const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v))

describe('model', () => {
  it('github serializes to the documented shape (no id, no environment)', () => {
    const cfg = githubTrust('npm/cli', 'publish.yml', undefined, [Permission.Publish])
    expect(wire(cfg)).toEqual({
      type: 'github',
      claims: { repository: 'npm/cli', workflow_ref: { file: 'publish.yml' } },
      permissions: ['createPackage'],
    })
  })

  it('includes environment only when provided', () => {
    const cfg = githubTrust('npm/cli', 'publish.yml', 'release', [Permission.Publish])
    expect((wire(cfg) as { claims: { environment?: string } }).claims.environment).toBe('release')
  })

  it('gitlab serializes with ci_config_ref_uri', () => {
    const cfg = gitlabTrust('group/proj', '.gitlab-ci.yml', undefined, [
      Permission.Publish,
      Permission.StagePublish,
    ])
    expect(wire(cfg)).toEqual({
      type: 'gitlab',
      claims: { project_path: 'group/proj', ci_config_ref_uri: { file: '.gitlab-ci.yml' } },
      permissions: ['createPackage', 'createStagedPackage'],
    })
  })

  it('permissionLabel maps wire values to human labels', () => {
    expect(permissionLabel(Permission.Publish)).toBe('publish')
    expect(permissionLabel(Permission.StagePublish)).toBe('stage publish')
  })

  it('sameBinding is order-insensitive on permissions and ignores id', () => {
    const a = githubTrust('o/r', 'publish.yml', undefined, [
      Permission.Publish,
      Permission.StagePublish,
    ])
    const b = githubTrust('o/r', 'publish.yml', undefined, [
      Permission.StagePublish,
      Permission.Publish,
    ])
    b.id = 'server-assigned'
    expect(sameBinding(a, b)).toBe(true)

    const c = githubTrust('other/repo', 'publish.yml', undefined, [Permission.Publish])
    expect(sameBinding(a, c)).toBe(false)
  })
})
