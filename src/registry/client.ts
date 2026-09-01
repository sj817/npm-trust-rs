//! HTTP client for the npm registry Trusted Publishing API (`docs/api.md`).
//!
//! Talks to the same endpoints the npm CLI does, over native `fetch`.

import {
  ConflictError,
  DecodeError,
  ForbiddenError,
  IpBlockedError,
  isRetryable,
  NetworkError,
  NotFoundError,
  OtpRequiredError,
  RateLimitedError,
  RegistryError,
  UnauthorizedError,
} from './errors'

import type { TrustConfig, Whoami } from './model'
import type { NptError, OtpChallenge, WebOtp } from './errors'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

const CLIENT_VERSION = '0.3.0'
const TIMEOUT_MS = 30_000

export interface ClientOptions {
  baseUrl?: string
  /** Retries for network errors / 429 / 5xx. Default 3. */
  maxRetries?: number
  /** Bearer token. Omit for unauthenticated use (existence checks still work). */
  token?: string
  userAgent?: string
}

const sleep = (ms: number): Promise<void> =>
  new Promise(r => {
    setTimeout(r, ms)
  })

export class Client {
  /** Replace only the FIRST `/` with `%2f` (scoped names: `@s/p` → `@s%2fp`). */
  static escapedName(name: string): string {
    return name.replace('/', '%2f')
  }

  private readonly baseUrl: string
  private readonly maxRetries: number
  private readonly token: string | undefined
  private readonly userAgent: string

  constructor(opts: ClientOptions = {}) {
    let base = opts.baseUrl ?? DEFAULT_REGISTRY
    if (!base.endsWith('/')) base += '/'
    this.baseUrl = base
    this.token = opts.token
    this.userAgent = opts.userAgent ?? `npm-trust-ts/${CLIENT_VERSION}`
    this.maxRetries = opts.maxRetries ?? 3
  }

  private headers(otp: string | undefined, hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = { 'user-agent': this.userAgent }
    if (this.token) h['authorization'] = `Bearer ${this.token}`
    if (otp) h['npm-otp'] = otp
    if (hasBody) h['content-type'] = 'application/json'
    return h
  }

  private async json<T>(res: Response): Promise<T> {
    const text = await res.text()
    try {
      return JSON.parse(text) as T
    } catch (error) {
      throw new DecodeError(`${errMessage(error)}: ${text}`)
    }
  }

  private async send(
    method: string,
    path: string,
    opts: { body?: unknown; otp?: string } = {},
  ): Promise<Response> {
    let attempt = 0
    for (;;) {
      let res: Response
      try {
        res = await fetch(this.url(path), {
          method,
          headers: this.headers(opts.otp, opts.body !== undefined),
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        // Only GETs are safe to replay after a transport error: a timed-out
        // POST/DELETE may have been applied server-side already.
        if (method === 'GET' && attempt < this.maxRetries) {
          await sleep(backoff(attempt, undefined))
          attempt++
          continue
        }
        throw new NetworkError(errMessage(error))
      }
      if (res.ok) return res
      const err = await mapResponse(res)
      if (isRetryable(err) && attempt < this.maxRetries) {
        const ra = err instanceof RateLimitedError ? err.retryAfterMs : undefined
        await sleep(backoff(attempt, ra))
        attempt++
        continue
      }
      throw err
    }
  }

  private url(path: string): URL {
    return new URL(path.replace(/^\/+/, ''), this.baseUrl)
  }

  async createTrust(name: string, config: TrustConfig, otp?: string): Promise<TrustConfig[]> {
    const path = `-/package/${Client.escapedName(name)}/trust`
    // Body is a one-element array; `id` is omitted (never set on a desired config).
    const res = await this.send('POST', path, { otp, body: [config] })
    return normalizeConfigs(await this.json<unknown>(res))
  }

  async listTrust(name: string, otp?: string): Promise<TrustConfig[]> {
    const path = `-/package/${Client.escapedName(name)}/trust`
    const res = await this.send('GET', path, { otp })
    return normalizeConfigs(await this.json<unknown>(res))
  }

  /** `GET /<name>` unauthenticated, no retry. 404 → false, 2xx → true. */
  async packageExists(name: string): Promise<boolean> {
    let res: Response
    try {
      res = await fetch(this.url(name), {
        method: 'GET',
        headers: { 'user-agent': this.userAgent },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw new NetworkError(errMessage(error))
    }
    if (res.status === 404) return false
    if (res.ok) return true
    throw new RegistryError(res.status, messageFrom(await safeText(res)))
  }

  async revokeTrust(name: string, id: string, otp?: string): Promise<void> {
    const path = `-/package/${Client.escapedName(name)}/trust/${encodeURIComponent(id)}`
    await this.send('DELETE', path, { otp })
  }

  async whoami(): Promise<Whoami> {
    const res = await this.send('GET', '-/whoami')
    return this.json<Whoami>(res)
  }
}

function backoff(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return retryAfterMs
  return Math.min(200 * 2 ** Math.min(attempt, 5), 5000)
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function headerParts(h: string | undefined): string[] {
  if (!h) return []
  return h.split(',').map(p => p.trim().toLowerCase())
}

/** Map a `>= 400` response to a typed error. Mirrors `docs/api.md` §8. */
async function mapResponse(res: Response): Promise<NptError> {
  const wwwAuth = res.headers.get('www-authenticate') ?? undefined
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after') ?? undefined)
  const body = await safeText(res)
  const status = res.status

  if (status === 401) {
    const parts = headerParts(wwwAuth)
    if (parts.includes('ipaddress')) return new IpBlockedError()
    if (parts.includes('otp') || body.toLowerCase().includes('one-time pass')) {
      const challenge: OtpChallenge = { web: parseWebOtp(body), wwwAuthenticate: wwwAuth }
      return new OtpRequiredError(challenge)
    }
    return new UnauthorizedError(messageFrom(body))
  }
  if (status === 403) return new ForbiddenError(messageFrom(body))
  if (status === 404) return new NotFoundError(messageFrom(body))
  if (status === 409) return new ConflictError(messageFrom(body))
  if (status === 429) return new RateLimitedError(retryAfterMs)
  return new RegistryError(status, messageFrom(body))
}

function messageFrom(body: string): string {
  const trimmed = body.trim()
  try {
    const v = JSON.parse(body) as Record<string, unknown>
    if (v && typeof v === 'object') {
      if (typeof v.error === 'string') return v.error
      if (typeof v.message === 'string') return v.message
    }
  } catch {
    // not JSON
  }
  return trimmed.length > 0 ? trimmed : '(no response body)'
}

/** Registry may return a single object, an array, `null`, or `{}`; coerce to array. */
function normalizeConfigs(value: unknown): TrustConfig[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value as TrustConfig[]
  if (typeof value === 'object') {
    if (Object.keys(value as object).length === 0) return []
    return [value as TrustConfig]
  }
  return []
}

function parseRetryAfter(h: string | undefined): number | undefined {
  if (!h) return undefined
  const n = Number(h.trim())
  return Number.isSafeInteger(n) ? n * 1000 : undefined
}

function parseWebOtp(body: string): undefined | WebOtp {
  try {
    const v = JSON.parse(body) as Record<string, unknown>
    if (v && typeof v.authUrl === 'string' && typeof v.doneUrl === 'string') {
      return { authUrl: v.authUrl, doneUrl: v.doneUrl }
    }
  } catch {
    // not JSON
  }
  return undefined
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
