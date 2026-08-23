//! Minimal bilingual (EN/ZH) UI strings. Language is detected once.
//!
//! Design: user-facing prompts/guidance are localized; low-level error messages
//! from the registry client stay English.

export type Lang = 'en' | 'zh'

const cache: { lang?: Lang } = {}

export function isZh(): boolean {
  return lang() === 'zh'
}

export function lang(): Lang {
  cache.lang ??= detect()
  return cache.lang
}

/** Pick the EN or ZH string for the current language. */
export function t(en: string, zh: string): string {
  return isZh() ? zh : en
}

function detect(): Lang {
  const override = process.env.NPT_LANG?.toLowerCase()
  if (override) {
    if (override.startsWith('zh')) return 'zh'
    if (override.startsWith('en')) return 'en'
  }
  return systemLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function systemLocale(): string {
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
  if (env) return env
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return ''
  }
}
