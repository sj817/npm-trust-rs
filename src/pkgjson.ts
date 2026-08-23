//! Read/modify a package.json while preserving key order (JS objects keep
//! insertion order, so parse→mutate→stringify round-trips field order).

import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

import { parseRepository } from './discover'

export class PkgJson {
  static load(dir: string): PkgJson {
    const file = path.join(dir, 'package.json')
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(`reading ${file} — is this a package directory? (${msg})`)
    }
    return new PkgJson(file, JSON.parse(text) as Record<string, unknown>)
  }

  private readonly value: Record<string, unknown>
  readonly path: string

  constructor(path: string, value: Record<string, unknown>) {
    this.path = path
    this.value = value
  }

  isPrivate(): boolean {
    return this.value.private === true
  }

  name(): string | undefined {
    return typeof this.value.name === 'string' ? this.value.name : undefined
  }

  repositoryOwnerRepo(): string | undefined {
    return parseRepository(this.value.repository)
  }

  save(): void {
    writeFileSync(this.path, JSON.stringify(this.value, null, 2) + '\n')
  }

  setRepository(ownerRepo: string): void {
    this.value.repository = {
      type: 'git',
      url: `git+https://github.com/${ownerRepo}.git`,
    }
  }
}
