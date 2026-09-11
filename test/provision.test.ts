//! The provisioning flow end-to-end with the prompts scripted: the answers a
//! user gives must compose into exactly the name list the plan prints.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runProvision } from '../src/provision'

import type * as EngineModule from '../src/engine'
import type { Client, Manifest } from '../src/registry/index'

vi.mock('../src/prompts', () => ({
  checkboxPrompt: vi.fn(),
  confirm: vi.fn(),
  confirmGuarded: vi.fn(),
  promptOtp: vi.fn(),
  promptValidated: vi.fn(),
  selectPrompt: vi.fn(),
}))

vi.mock('../src/engine', async importOriginal => {
  const actual = await importOriginal<typeof EngineModule>()
  return { ...actual, resolveClient: vi.fn() }
})

const prompts = await import('../src/prompts')
const engine = await import('../src/engine')

/**
 * Every name the registry reports as taken; everything else is free. A name with
 * a manifest also answers `GET /<name>/latest` (and counts as published).
 */
function scriptRegistry(published: string[], manifests: Record<string, Manifest> = {}): void {
  const client = {
    packageExists: (name: string) =>
      Promise.resolve(published.includes(name) || Object.hasOwn(manifests, name)),
    latestManifest: (name: string) => Promise.resolve(manifests[name]),
  } as unknown as Client
  vi.mocked(engine.resolveClient).mockResolvedValue({ client, valid: false })
}

/**
 * Script the prompts in the order the flow asks them. `promptValidated` runs the
 * real validator on each answer, so a malformed script fails the test.
 */
function scriptPrompts(opts: {
  checkboxes: unknown[][]
  lines: string[]
  selects: unknown[]
}): void {
  const lines = [...opts.lines]
  const checkboxes = [...opts.checkboxes]
  const selects = [...opts.selects]

  vi.mocked(prompts.promptValidated).mockImplementation((_msg, _dflt, validate) => {
    const next = lines.shift()
    if (next === undefined) throw new Error('unexpected promptValidated call')
    return Promise.resolve(validate(next))
  })
  vi.mocked(prompts.checkboxPrompt).mockImplementation(() => {
    const next = checkboxes.shift()
    if (next === undefined) throw new Error('unexpected checkboxPrompt call')
    return Promise.resolve(next as never)
  })
  vi.mocked(prompts.selectPrompt).mockImplementation(() => {
    const next = selects.shift()
    if (next === undefined) throw new Error('unexpected selectPrompt call')
    return Promise.resolve(next as never)
  })
}

/** picocolors keeps colour on under vitest; assertions want the bare text. */
function stripAnsi(s: string): string {
  return s.replaceAll(/\u{1B}\[[\d;]*m/gu, '')
}

/** Run a dry-run provision and return everything it printed. */
async function capture(): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(stripAnsi(args.join(' ')))
  })
  try {
    await runProvision({ dryRun: true, workflow: undefined, environment: undefined })
  } finally {
    spy.mockRestore()
  }
  return lines.join('\n')
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('runProvision (dry run)', () => {
  it('derives a scoped platform matrix from the primary name', async () => {
    scriptRegistry([])
    scriptPrompts({
      // kinds, then the platform matrix (indices into ALL_TARGETS)
      checkboxes: [
        ['primary', 'platform'],
        [0, 4],
      ],
      // primary name, scope base word, repository, workflow
      lines: ['@shotkit/node', 'native', 'sj817/shotkit', 'publish.yml'],
      // naming scheme, suffix vocabulary
      selects: ['scoped', 'node'],
    })

    const out = await capture()
    expect(out).toContain('@shotkit/node ')
    expect(out).toContain('@shotkit/native-linux-x64')
    expect(out).toContain('@shotkit/native-win32-x64')
    expect(out).toContain('github:sj817/shotkit@publish.yml')
    // 1 primary + 2 platforms, and no slot that was not selected
    expect(out).not.toContain('darwin')
    expect(prompts.confirm).not.toHaveBeenCalled()
    expect(prompts.confirmGuarded).not.toHaveBeenCalled()
    expect(prompts.promptOtp).not.toHaveBeenCalled()
  })

  it('reuses the primary name as the prefix with the short vocabulary', async () => {
    scriptRegistry([])
    scriptPrompts({
      checkboxes: [
        ['primary', 'platform'],
        [2, 3],
      ],
      lines: ['axios', 'sj817/axios', 'publish.yml'],
      selects: ['suffix', 'short'],
    })

    const out = await capture()
    expect(out).toContain('axios-mac-x64')
    expect(out).toContain('axios-mac-arm64')
  })

  it("takes the platform list from a published primary's optionalDependencies", async () => {
    scriptRegistry([], {
      '@shotkit/shotium': {
        name: '@shotkit/shotium',
        version: '0.7.2',
        optionalDependencies: {
          '@shotkit/shotium-linux-x64': '0.7.2',
          '@shotkit/shotium-win32-x64': '0.7.2',
          fsevents: '^2.3.0',
        },
        repository: { type: 'git', url: 'git+https://github.com/sj817/shotium.git' },
      },
    })
    scriptPrompts({
      // kinds, then the optionalDependencies picked by name
      checkboxes: [
        ['primary', 'platform'],
        ['@shotkit/shotium-linux-x64', '@shotkit/shotium-win32-x64'],
      ],
      // primary name, repository, workflow — no prefix / base word asked
      lines: ['@shotkit/shotium', 'sj817/shotium', 'publish.yml'],
      // platform source
      selects: ['registry'],
    })

    const out = await capture()
    expect(out).toContain('@shotkit/shotium-linux-x64')
    expect(out).toContain('@shotkit/shotium-win32-x64')
    expect(out).not.toContain('fsevents')
    expect(out).toContain('github:sj817/shotium@publish.yml')
    // the manifest's repository seeds the repo prompt
    expect(prompts.promptValidated).toHaveBeenCalledWith(
      expect.any(String),
      'sj817/shotium',
      expect.any(Function),
    )
    // siblings are pre-ticked, unrelated optional deps are not
    const [, choices] = vi.mocked(prompts.checkboxPrompt).mock.calls[1] ?? []
    expect(choices).toEqual([
      { name: '@shotkit/shotium-linux-x64', value: '@shotkit/shotium-linux-x64', checked: true },
      { name: '@shotkit/shotium-win32-x64', value: '@shotkit/shotium-win32-x64', checked: true },
      { name: 'fsevents', value: 'fsevents', checked: false },
    ])
  })

  it('falls back to the naming rules when the user declines the registry list', async () => {
    scriptRegistry([], {
      axios: {
        name: 'axios',
        version: '1.0.0',
        optionalDependencies: { '@axios/linux-x64': '1.0.0' },
      },
    })
    scriptPrompts({
      checkboxes: [
        ['primary', 'platform'],
        [0, 1],
      ],
      lines: ['axios', 'sj817/axios', 'publish.yml'],
      // platform source, then naming scheme + vocabulary as usual
      selects: ['rules', 'suffix', 'node'],
    })

    const out = await capture()
    expect(out).toContain('axios-linux-x64')
    expect(out).toContain('axios-linux-arm64')
    expect(out).not.toContain('@axios/linux-x64')
  })

  it('asks for a bare prefix when only platform packages are selected', async () => {
    scriptRegistry(['@shotkit/node-linux-x64'])
    scriptPrompts({
      checkboxes: [['platform'], [0, 1]],
      lines: ['@shotkit/node', 'sj817/shotkit', 'release.yaml'],
      selects: ['node'],
    })

    const out = await capture()
    expect(out).toContain('@shotkit/node-linux-x64')
    expect(out).toContain('@shotkit/node-linux-arm64')
    expect(out).toContain('github:sj817/shotkit@release.yaml')
    // the taken name is planned as bind-only, not as a first publish
    expect(out).toMatch(/@shotkit\/node-linux-x64\s+\S+\s+(published|已发布)/)
  })
})
