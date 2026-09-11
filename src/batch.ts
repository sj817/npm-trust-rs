//! Shared batch machinery: reconcile many packages under a single OTP —
//! first-publish a placeholder when the name is still free, then bind it.

import { t } from './i18n'
import * as color from './color'
import { errMsg } from './commands/util'
import { describeBinding } from './engine'
import { publishPlaceholder } from './wizard'
import { promptOtpOptional } from './prompts'
import { sameBinding } from './registry/index'

import type { Writer } from './engine'
import type { TrustConfig } from './registry/index'

/** One batch candidate: package name + registry state + the binding we want. */
export interface BatchTarget {
  desired?: TrustConfig
  name: string
  published: boolean
  repository?: string
}

/** What {@link configureOne} did to one target, for the closing summary. */
export interface Outcome {
  /** Short column text: what happened, or why it did not. */
  label: string
  ok: boolean
  /** A 0.0.1 placeholder went out in this run (even if the bind then failed). */
  placeholder: boolean
  /** Registry state after the run. */
  published: boolean
}

/** Shared mutable OTP for a batch (re-entered once when the ~5-min window expires). */
export interface OtpBox {
  otp: string
}

/** A finished target, ready for {@link printSummary}. */
export interface SummaryRow {
  /** Trailing `→ binding` (batch-from-dir, where each package has its own). */
  binding?: string
  /** Pre-padded kind column (provision: primary / platform). */
  kind?: string
  name: string
  outcome: Outcome
}

/** Configure a single target: placeholder-publish if needed, then bind. */
export async function configureOne(
  tgt: BatchTarget,
  writer: Writer,
  box: OtpBox,
): Promise<Outcome> {
  const failed = (label: string, placeholder: boolean): Outcome => ({
    ok: false,
    placeholder,
    published: tgt.published || placeholder,
    label,
  })

  if (!tgt.desired) {
    process.stderr.write(
      color.warn(
        t(
          '  skipped: package.json has no repository.',
          '  跳过:package.json 没有 repository 字段。',
        ),
      ) + '\n',
    )
    return failed(t('skipped: no repository', '跳过:无 repository'), false)
  }
  const name = tgt.name

  const placeholder = !tgt.published
  if (placeholder && !(await publishWithRetry(name, writer, box))) {
    return failed(t('publish failed', '发布失败'), false)
  }

  let current: TrustConfig | undefined
  try {
    const configs = await writer.list(name)
    current = configs[0]
  } catch (error) {
    process.stderr.write(color.warn(`  list failed: ${errMsg(error)}`) + '\n')
    return failed(unbound(t('list failed', '读取绑定失败'), placeholder), placeholder)
  }
  try {
    let label: string
    if (current && sameBinding(tgt.desired, current)) {
      label = t('already bound', '已正确绑定')
    } else if (current) {
      await writer.revoke(name, requireId(current, name))
      await writer.create(name, tgt.desired)
      label = t('rebound', '已改绑')
    } else {
      await writer.create(name, tgt.desired)
      label = t('bound', '已绑定')
    }
    console.log(color.ok(`  ✓ ${label}: ${describeBinding(tgt.desired)}`))
    return {
      ok: true,
      placeholder,
      published: true,
      label: placeholder ? t(`placeholder 0.0.1 + ${label}`, `首发占位 0.0.1 + ${label}`) : label,
    }
  } catch (error) {
    process.stderr.write(color.warn(`  bind failed: ${errMsg(error)}`) + '\n')
    return failed(unbound(t('bind failed', '绑定失败'), placeholder), placeholder)
  }
}

/**
 * Closing table — one line per target, then the tally. A placeholder that went
 * out before its bind failed is called out: the name is reserved but unbound.
 */
export function printSummary(rows: SummaryRow[]): { fail: number; ok: number } {
  const width = Math.max(...rows.map(row => row.name.length))
  const publishedW = Math.max(publishedLabel(true).length, publishedLabel(false).length)
  for (const row of rows) {
    const cells = [
      color.accent(row.name.padEnd(width)),
      row.kind === undefined ? undefined : color.dim(row.kind),
      publishedLabel(row.outcome.published).padEnd(publishedW),
      row.outcome.ok ? row.outcome.label : color.warn(row.outcome.label),
      row.binding !== undefined && row.outcome.ok ? color.dim(`→ ${row.binding}`) : undefined,
    ]
    console.log(`  ${cells.filter(cell => cell !== undefined).join('  ')}`)
  }
  const ok = rows.filter(row => row.outcome.ok).length
  const fail = rows.length - ok
  console.log()
  console.log(
    color.ok(
      t(
        `Done: ${ok} configured, ${fail} failed/skipped.`,
        `完成:成功 ${ok} 个,失败/跳过 ${fail} 个。`,
      ),
    ),
  )
  return { ok, fail }
}

/**
 * First-publish a placeholder, re-prompting for a fresh OTP on failure (the
 * ~5-min window may have expired mid-batch). A blank OTP skips this package.
 */
export async function publishWithRetry(
  name: string,
  writer: Writer,
  box: OtpBox,
): Promise<boolean> {
  for (;;) {
    try {
      publishPlaceholder(name, box.otp)
      return true
    } catch (error) {
      process.stderr.write(color.warn(`  publish failed: ${errMsg(error)}`) + '\n')
      const re = await promptOtpOptional(
        t('  re-enter OTP to retry (blank to skip this package)', '  重输 OTP 重试(留空跳过该包)'),
      )
      if (re === undefined) return false
      box.otp = re
      writer.setOtp(re)
    }
  }
}

/** Fail fast rather than issue `DELETE …/trust/` with an empty id. */
export function requireId(config: TrustConfig, name: string): string {
  if (!config.id) throw new Error(`registry returned a trust config without an id for ${name}`)
  return config.id
}

function publishedLabel(published: boolean): string {
  return published ? t('published', '已发布') : t('unpublished', '未发布')
}

/** Prefix a failure label with the placeholder that did land, when one did. */
function unbound(label: string, placeholder: boolean): string {
  return placeholder ? t(`placeholder 0.0.1, ${label}`, `首发占位 0.0.1,${label}`) : label
}
