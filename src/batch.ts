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

/** Shared mutable OTP for a batch (re-entered once when the ~5-min window expires). */
export interface OtpBox {
  otp: string
}

/** Configure a single target: placeholder-publish if needed, then bind. */
export async function configureOne(
  tgt: BatchTarget,
  writer: Writer,
  box: OtpBox,
): Promise<boolean> {
  if (!tgt.desired) {
    process.stderr.write(
      color.warn(
        t(
          '  skipped: package.json has no repository.',
          '  跳过:package.json 没有 repository 字段。',
        ),
      ) + '\n',
    )
    return false
  }
  const name = tgt.name

  if (!tgt.published && !(await publishWithRetry(name, writer, box))) return false

  let current: TrustConfig | undefined
  try {
    const configs = await writer.list(name)
    current = configs[0]
  } catch (error) {
    process.stderr.write(color.warn(`  list failed: ${errMsg(error)}`) + '\n')
    return false
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
    return true
  } catch (error) {
    process.stderr.write(color.warn(`  bind failed: ${errMsg(error)}`) + '\n')
    return false
  }
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
