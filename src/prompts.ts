//! Interactive prompt helpers (built on @inquirer/prompts), mirroring the Rust
//! CLI's dialoguer-based flows: line input, validated input, confirm, and OTP.

import { checkbox, input, confirm as inqConfirm, select } from '@inquirer/prompts'

import { t } from './i18n'

const OTP_MIN = 6
const OTP_MAX = 8

export interface Choice<T> {
  name: string
  value: T
}

/** Multi-select (space toggles). `checked` controls the initial state per item. */
export function checkboxPrompt<T>(
  message: string,
  choices: Array<Choice<T> & { checked?: boolean }>,
): Promise<T[]> {
  requireTty()
  return checkbox({ message, choices, pageSize: 20 })
}

/** Yes/no confirm (default No). `assumeYes` short-circuits to true. */
export function confirm(message: string, assumeYes = false): Promise<boolean> {
  if (assumeYes) return Promise.resolve(true)
  requireTty()
  return inqConfirm({ message, default: false })
}

/** Plain line input with an optional default; returns the trimmed answer. */
export async function promptLine(message: string, dflt?: string): Promise<string> {
  requireTty()
  const answer = await input({ message, default: dflt })
  return answer.trim()
}

/**
 * A one-time password supplied out of band via `NPM_OTP`.
 *
 * The registry demands an OTP for *reads* of the trust API as well as writes, so
 * without this there is no way to run any trust operation where no TTY exists
 * (CI, an agent shell, a piped invocation).
 */
export function envOtp(): string | undefined {
  const v = process.env.NPM_OTP?.trim()
  return v === undefined || v === '' ? undefined : v
}

/** Prompt for a one-time password (digits only, 6–8 long). */
export async function promptOtp(): Promise<string> {
  const fromEnv = envOtp()
  if (fromEnv !== undefined) return fromEnv
  requireTty()
  const otp = await input({
    message: t(
      'This operation requires a one-time password (2FA/OTP). Enter OTP',
      '此操作需要一次性密码(2FA/OTP),请输入 OTP',
    ),
    validate: v => otpError(v.trim()) ?? true,
  })
  return otp.trim()
}

/** Like {@link promptOtp} but a blank line returns undefined (skip in batch flows). */
export async function promptOtpOptional(message: string): Promise<string | undefined> {
  const fromEnv = envOtp()
  if (fromEnv !== undefined) return fromEnv
  requireTty()
  const val = await input({
    message,
    validate: v => {
      const s = v.trim()
      if (s === '') return true
      return otpError(s) ?? true
    },
  })
  const s = val.trim()
  return s === '' ? undefined : s
}

/**
 * Prompt, then run `validate` (which returns a normalized value or throws). Invalid
 * input is rejected inline and re-asked. Returns the normalized value.
 */
export async function promptValidated(
  message: string,
  dflt: string | undefined,
  validate: (s: string) => string,
): Promise<string> {
  requireTty()
  const answer = await input({
    message,
    default: dflt,
    validate: val => {
      try {
        validate(val.trim())
        return true
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  })
  return validate(answer.trim())
}

/** Bail early (with a friendly message) when there is no interactive terminal. */
export function requireTty(): void {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      'an interactive terminal is required here. Re-run in a terminal ' +
        '(2FA/OTP cannot be bypassed for trust writes; use scan/audit for CI).',
    )
  }
}

/** Single-select menu. */
export function selectPrompt<T>(message: string, choices: Choice<T>[]): Promise<T> {
  requireTty()
  return select({ message, choices, pageSize: 20 })
}

function otpError(s: string): string | undefined {
  if (!/^\d*$/.test(s)) return t('OTP must contain digits only.', 'OTP 只能是数字。')
  if (s.length < OTP_MIN || s.length > OTP_MAX) {
    return t('OTP must be 6–8 digits.', 'OTP 必须是 6–8 位数字。')
  }
  return undefined
}
