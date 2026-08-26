//! The provisioning flow end-to-end with the prompts scripted: the answers a
//! user gives must compose into exactly the name list the plan prints.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runProvision } from '../src/provision'

import type * as EngineModule from '../src/engine'
import type { Client } from '../src/registry/index'

vi.mock('../src/prompts', () => ({
  checkboxPrompt: vi.fn(),
  confirm: vi.fn(),
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

/** Every name the registry reports as taken; everything else is free. */
function scriptRegistry(published: string[]): void {
  const client = {
    packageExists: (name: string) => Promise.resolve(published.includes(name)),
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
    expect(out).toContain('axios-mac-amd64')
    expect(out).toContain('axios-mac-arm64')
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
