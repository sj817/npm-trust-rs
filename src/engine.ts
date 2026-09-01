//! Shared engine: credentials, client construction, desired-binding derivation,
//! status classification, and the OTP-aware write wrapper.

import { t } from './i18n'
import * as color from './color'
import { envOtp, promptOtp } from './prompts'
import { errMsg, sleep } from './commands/util'
import {
  Client,
  credentialSourceLabel,
  githubTrust,
  OtpRequiredError,
  Permission,
  permissionLabel,
  resolveToken,
  sameBinding,
  UnauthorizedError,
} from './registry/index'

import type { DiscoveredPackage } from './discover'
import type {
  CircleciClaims,
  GithubClaims,
  GitlabClaims,
  OtpChallenge,
  TrustConfig,
} from './registry/index'

const VERSION = '0.3.0'

/** Workflow filename convention; derives `github:<owner/repo>@<workflow>`. */
export const DEFAULT_WORKFLOW = 'publish.yml'

/** How a package's registry binding compares to what we want. */
export type BindingStatus =
  'correct' | 'drift' | 'missing' | 'no_binding' | 'unknown' | 'unpublished' | 'untracked'

/** Anything that can read a package's trust list, satisfying OTP challenges itself. */
export interface TrustReader {
  list: (pkg: string) => Promise<TrustConfig[]>
}

export interface PackagePlan {
  actual?: TrustConfig
  desired?: TrustConfig
  name: string
  published: boolean
  repository?: string
  status: BindingStatus
  workflow?: string
}

const MAX_OTP_TRIES = 3

/**
 * Gap between per-package trust reads.
 *
 * npm documents no numeric rate limit, but `npm trust` advises ~2s between
 * commands (about 80 packages inside the 5-minute 2FA window). Reads count
 * against the same budget as writes.
 */
const READ_SPACING_MS = 2000

/**
 * OTP-aware writer. Caches the OTP across calls to exploit the ~5-minute window,
 * prompting again only when the registry issues a fresh challenge.
 */
export class Writer {
  /** Pre-seed an OTP (batch flows: prompt once, reuse across many writes). */
  static withOtp(client: Client, otp: string): Writer {
    return new Writer(client, otp)
  }

  private readonly client: Client
  private otp: string | undefined

  constructor(client: Client, otp?: string) {
    this.client = client
    // NPM_OTP is the only way to satisfy a challenge where no TTY exists.
    this.otp = otp ?? envOtp()
  }

  private async handleOtp(challenge: OtpChallenge): Promise<void> {
    if (challenge.web) {
      process.stderr.write(
        t(
          `→ this operation offers browser 2FA. Open:\n    ${challenge.web.authUrl}`,
          `→ 此操作支持浏览器 2FA。请打开:\n    ${challenge.web.authUrl}`,
        ) + '\n',
      )
    }
    this.otp = await promptOtp()
  }

  async create(pkg: string, cfg: TrustConfig): Promise<void> {
    for (let otpTries = 0; ; otpTries++) {
      try {
        await this.client.createTrust(pkg, cfg, this.otp)
        return
      } catch (error) {
        if (error instanceof OtpRequiredError && otpTries < MAX_OTP_TRIES) {
          await this.handleOtp(error.challenge)
          continue
        }
        throw error
      }
    }
  }

  async list(pkg: string): Promise<TrustConfig[]> {
    for (let otpTries = 0; ; otpTries++) {
      try {
        return await this.client.listTrust(pkg, this.otp)
      } catch (error) {
        if (error instanceof OtpRequiredError && otpTries < MAX_OTP_TRIES) {
          await this.handleOtp(error.challenge)
          continue
        }
        throw error
      }
    }
  }

  async revoke(pkg: string, id: string): Promise<void> {
    for (let otpTries = 0; ; otpTries++) {
      try {
        await this.client.revokeTrust(pkg, id, this.otp)
        return
      } catch (error) {
        if (error instanceof OtpRequiredError && otpTries < MAX_OTP_TRIES) {
          await this.handleOtp(error.challenge)
          continue
        }
        throw error
      }
    }
  }

  /** Replace the cached OTP (e.g. after the window expired and the user re-entered). */
  setOtp(otp: string): void {
    this.otp = otp
  }
}

/** Assess a set of packages into plans (skips private; never prompts for OTP). */
export async function assess(
  client: Client,
  haveCreds: boolean,
  packages: DiscoveredPackage[],
  workflowOverride?: string,
  environment?: string,
  reader?: TrustReader,
): Promise<PackagePlan[]> {
  const plans: PackagePlan[] = []
  let readTrust = false
  for (const pkg of packages) {
    if (pkg.private) continue
    // npm's own `npm trust` docs put the rate-limit budget at roughly one command
    // every 2s. Writes were already spaced; reads were not, so scanning a handful
    // of packages emptied the budget before a single write went out and the whole
    // run 429'd. Space the reads on the same interval.
    if (readTrust) await sleep(READ_SPACING_MS)
    let published: boolean
    try {
      published = await client.packageExists(pkg.name)
    } catch {
      published = false
    }
    const desired = desiredBinding(pkg, workflowOverride, environment)

    // When the trust list is unreadable (OTP challenge, expired token, network
    // error), the status must be `unknown` — reporting `missing` would make
    // audit flag false drift and sync plan a create that 409s.
    //
    // The registry demands an OTP to READ this list, not only to write it, so an
    // unreadable list is the ordinary case rather than an edge one. Callers that can
    // satisfy a challenge (sync, the menu) pass a `reader` — a Writer, which retries
    // with an OTP. Everyone else reads with whatever NPM_OTP provides.
    let actual: TrustConfig | undefined
    let readable = haveCreds
    if (published && haveCreds) {
      try {
        readTrust = true
        const configs = reader
          ? await reader.list(pkg.name)
          : await client.listTrust(pkg.name, envOtp())
        actual = configs[0]
      } catch (error) {
        readable = false
        // An OTP challenge used to be swallowed here. It is the likeliest failure on
        // this path, and saying nothing about it is what let `unknown` masquerade as
        // "already correct" all the way out to audit's exit code.
        const hint =
          error instanceof OtpRequiredError || error instanceof UnauthorizedError
            ? t(
                ' — needs a 2FA/OTP (set NPM_OTP, or run sync in a terminal)',
                ' —— 需要 2FA/OTP(设置 NPM_OTP,或在终端里运行 sync)',
              )
            : ''
        const why = t(
          `⚠ could not read trust for ${pkg.name}: ${errMsg(error)}${hint}`,
          `⚠ 无法读取 ${pkg.name} 的绑定:${errMsg(error)}${hint}`,
        )
        process.stderr.write(color.warn(why) + '\n')
      }
    }

    plans.push({
      name: pkg.name,
      published,
      desired: desired?.config,
      actual,
      status: classify(published, readable, desired?.config, actual),
      repository: desired?.repository ?? pkg.repository,
      workflow: desired?.workflow,
    })
  }
  return plans
}

/** The GitHub `owner/repo` a config binds to, if it is a GitHub binding. */
export function bindingRepo(cfg: TrustConfig): string | undefined {
  return cfg.type === 'github' ? (cfg.claims as GithubClaims).repository : undefined
}

/** Classify a package given existence, desired, and actual bindings. */
export function classify(
  published: boolean,
  haveCreds: boolean,
  desired: TrustConfig | undefined,
  actual: TrustConfig | undefined,
): BindingStatus {
  if (!published) return 'unpublished'
  if (!haveCreds) return 'unknown'
  if (actual) {
    if (desired && sameBinding(desired, actual)) return 'correct'
    if (desired) return 'drift'
    return 'untracked'
  }
  if (desired) return 'missing'
  return 'no_binding'
}

/** Human, one-line description of a binding. */
export function describeBinding(cfg: TrustConfig): string {
  const perms = cfg.permissions.map(p => permissionLabel(p)).join('+')
  if (cfg.type === 'github') {
    const c = cfg.claims as GithubClaims
    const env = c.environment ? ` env=${c.environment}` : ''
    return `github:${c.repository}@${c.workflow_ref.file}${env} [${perms}]`
  }
  if (cfg.type === 'gitlab') {
    const c = cfg.claims as GitlabClaims
    return `gitlab:${c.project_path}@${c.ci_config_ref_uri.file} [${perms}]`
  }
  const c = cfg.claims as CircleciClaims
  return `circleci:${c['oidc.circleci.com/vcs-origin']} [${perms}]`
}

/** Derive the binding we want for a package (or undefined without a repository). */
export function desiredBinding(
  pkg: DiscoveredPackage,
  workflowOverride?: string,
  environment?: string,
): undefined | { config: TrustConfig; repository: string; workflow: string } {
  const repository = pkg.repository
  if (!repository) return undefined
  const workflow = workflowOverride ?? DEFAULT_WORKFLOW
  const config = githubTrust(repository, workflow, environment, [Permission.Publish])
  return { config, repository, workflow }
}

/** Node's npm is `npm.cmd` on Windows; run it through `cmd /C` so it resolves. */
export function npmCommand(): { cmd: string; prefix: string[] } {
  if (process.platform === 'win32') return { cmd: 'cmd', prefix: ['/C', 'npm'] }
  return { cmd: 'npm', prefix: [] }
}

/**
 * Build a client and, if credentials exist, validate them via `whoami`.
 * Returns `{ client, valid }`. When `require` is true, missing/invalid creds throw.
 */
export async function resolveClient(require: boolean): Promise<{ client: Client; valid: boolean }> {
  const cred = resolveToken()
  const client = new Client({ token: cred?.token, userAgent: `npm-trust-rs/${VERSION} npt` })

  if (cred) {
    process.stderr.write(
      t('→ verifying npm login (GET /-/whoami)…\n', '→ 正在验证 npm 登录(GET /-/whoami)…\n'),
    )
    const src = credentialSourceLabel(cred.source)
    try {
      const who = await client.whoami()
      process.stderr.write(
        color.ok(
          t(
            `→ authenticated as ${who.username} (via ${src})`,
            `→ 已登录:${who.username}(来自 ${src})`,
          ),
        ) + '\n',
      )
      return { client, valid: true }
    } catch (error) {
      // Registry-layer errors are English by design; re-word the common 401 here.
      const msg =
        error instanceof UnauthorizedError
          ? t(
              errMsg(error),
              '未授权(401)\n  → token 缺失、过期或缺少账户级 2FA。请运行 npm login,或将 NPM_TOKEN 设为带 2FA 的账户 token。',
            )
          : errMsg(error)
      process.stderr.write(
        color.warn(
          t(`⚠ credentials from ${src} did not validate: ${msg}`, `⚠ 凭据(${src})验证失败:${msg}`),
        ) + '\n',
      )
      if (require) throw new Error(t('invalid credentials', '凭据无效'))
      return { client, valid: false }
    }
  }

  if (require) {
    throw new Error(
      t(
        'no npm credentials found.\n  → Add //registry.npmjs.org/:_authToken to ~/.npmrc, set NPM_TOKEN, or run npm login.',
        '未找到 npm 凭据。\n  → 在 ~/.npmrc 添加 //registry.npmjs.org/:_authToken,或设置 NPM_TOKEN,或运行 npm login。',
      ),
    )
  }
  process.stderr.write(
    t(
      '→ no credentials; running read-only (existence checks only)\n',
      '→ 无凭据;只读模式(仅做存在性检查)\n',
    ),
  )
  return { client, valid: false }
}

export function statusLabel(s: BindingStatus): string {
  switch (s) {
    case 'correct': {
      return 'correct'
    }
    case 'drift': {
      return 'DRIFT'
    }
    case 'missing': {
      return 'missing'
    }
    case 'no_binding': {
      return 'no binding (no repo)'
    }
    case 'unknown': {
      return 'unknown (unreadable)'
    }
    case 'unpublished': {
      return 'unpublished'
    }
    case 'untracked': {
      return 'untracked'
    }
  }
}

/** A workflow reference must be a bare `*.yml` / `*.yaml` filename, not a path. */
export function validateWorkflowFile(input: string): string {
  const s = input.trim()
  if (!(s.endsWith('.yml') || s.endsWith('.yaml'))) {
    throw new Error(
      t('workflow file must end in .yml or .yaml.', 'workflow 文件名必须以 .yml 或 .yaml 结尾。'),
    )
  }
  if (s.includes('/') || s.includes('\\')) {
    throw new Error(t('must be a bare filename, not a path.', '必须是纯文件名,不能是路径。'))
  }
  return s
}
