#!/usr/bin/env node
//! Fail if package-lock.json resolves anything outside the public npm registry.
//!
//! Installing behind a mirror bakes that mirror's host into every `resolved` entry.
//! npm >= 12 then refuses to install the tree (`EALLOWREMOTE`, because a non-registry
//! tarball URL counts as a "remote" dependency), and everyone else silently fetches
//! from a host they never chose. Regenerate the lockfile against npmjs instead.

import { readFileSync } from 'node:fs'

const REGISTRY = 'https://registry.npmjs.org/'

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const entries = Object.entries(lock.packages ?? {})
const bad = entries.filter(([, v]) => v.resolved && !v.resolved.startsWith(REGISTRY))

if (bad.length > 0) {
  process.stderr.write(`package-lock.json resolves ${bad.length} package(s) outside ${REGISTRY}:\n`)
  for (const [name, v] of bad) process.stderr.write(`  ${name} -> ${v.resolved}\n`)
  process.stderr.write(
    '\nRegenerate it against the public registry:\n' +
      '  rm package-lock.json && npm install --package-lock-only\n',
  )
  process.exit(1)
}

process.stdout.write(`lockfile ok: ${entries.length} entries, all on ${REGISTRY}\n`)
