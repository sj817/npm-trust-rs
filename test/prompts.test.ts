//! The guarded confirm: a stray Enter must loop back to the question, and only
//! a deliberate second answer may cancel.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { confirmGuarded } from '../src/prompts'

vi.mock('@inquirer/prompts', () => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
  select: vi.fn(),
}))

const inquirer = await import('@inquirer/prompts')

/** `requireTty()` gates every prompt; vitest's stdio is not a terminal. */
const ttyDescriptors = {
  stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
  stderr: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY'),
}

beforeAll(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })
})

afterAll(() => {
  for (const [stream, desc] of [
    [process.stdin, ttyDescriptors.stdin],
    [process.stderr, ttyDescriptors.stderr],
  ] as const) {
    if (desc) Object.defineProperty(stream, 'isTTY', desc)
    else delete (stream as { isTTY?: boolean }).isTTY
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

/** Script the confirm answers, then the cancel-menu answers, in order. */
function script(confirms: boolean[], cancels: boolean[]): void {
  const c = [...confirms]
  const s = [...cancels]
  vi.mocked(inquirer.confirm).mockImplementation(() => {
    const next = c.shift()
    if (next === undefined) throw new Error('unexpected confirm call')
    return Promise.resolve(next) as never
  })
  vi.mocked(inquirer.select).mockImplementation(() => {
    const next = s.shift()
    if (next === undefined) throw new Error('unexpected select call')
    return Promise.resolve(next) as never
  })
}

describe('confirmGuarded', () => {
  it('returns true on a plain Yes without a second question', async () => {
    script([true], [])
    expect(await confirmGuarded('go?')).toBe(true)
    expect(inquirer.select).not.toHaveBeenCalled()
  })

  it('re-asks after No when the cancel menu answers "go back"', async () => {
    // Enter (No) → Enter (go back, the default) → deliberate Yes
    script([false, true], [false])
    expect(await confirmGuarded('go?')).toBe(true)
    expect(inquirer.confirm).toHaveBeenCalledTimes(2)
    expect(inquirer.select).toHaveBeenCalledTimes(1)
  })

  it('offers "go back" as the first (default) choice', async () => {
    script([false, true], [false])
    await confirmGuarded('go?')
    const [opts] = vi.mocked(inquirer.select).mock.calls[0] ?? []
    const choices = (opts as unknown as { choices: Array<{ value: boolean }> }).choices
    expect(choices.map(c => c.value)).toEqual([false, true])
  })

  it('cancels only when the second question is answered Yes', async () => {
    script([false], [true])
    expect(await confirmGuarded('go?')).toBe(false)
  })

  it('short-circuits with assumeYes', async () => {
    script([], [])
    expect(await confirmGuarded('go?', true)).toBe(true)
    expect(inquirer.confirm).not.toHaveBeenCalled()
  })
})
