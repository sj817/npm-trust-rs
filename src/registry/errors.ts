//! Error types with actionable, user-facing messages.
//!
//! The status→semantics mapping mirrors `docs/api.md` §8, which in turn tracks
//! `npm-registry-fetch/lib/{check-response,errors}.js`.

/** Details of an OTP (two-factor) challenge returned on a `401`. */
export interface OtpChallenge {
  /** Present when the registry offers a browser second-factor (`authUrl`/`doneUrl`). */
  web?: WebOtp
  /** The raw `www-authenticate` header value, for diagnostics. */
  wwwAuthenticate?: string
}

/** Web-OTP URLs from the `401` challenge body. */
export interface WebOtp {
  authUrl: string
  doneUrl: string
}

/** Base class for every error surfaced by the registry client. */
export class NptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** `409` — a trust configuration already exists for this package. */
export class ConflictError extends NptError {
  constructor(detail: string) {
    super(
      `conflict (409): ${detail}\n  ` +
        '→ npm allows only one trust config per package. Revoke the existing one first ' +
        '(reconcile = revoke + create).',
    )
  }
}

/** A malformed response body. */
export class DecodeError extends NptError {
  constructor(detail: string) {
    super(`failed to parse registry response: ${detail}`)
  }
}

/** `403` — not an owner/maintainer of the package. */
export class ForbiddenError extends NptError {
  constructor(detail: string) {
    super(
      `forbidden (403): ${detail}\n  ` +
        '→ You lack publish rights on this package. Ask an owner to add you as a maintainer.',
    )
  }
}

/** `401` with `www-authenticate: ipaddress`. */
export class IpBlockedError extends NptError {
  constructor() {
    super('login is not allowed from your IP address (registry returned 401 ipaddress)')
  }
}

/** Transport-level failure (DNS, TLS, timeout after retries, …). */
export class NetworkError extends NptError {
  constructor(detail: string) {
    super(`network error: ${detail}`)
  }
}

/** A required credential could not be resolved. */
export class NoCredentialsError extends NptError {
  constructor() {
    super(
      'no npm credentials found.\n  ' +
        '→ Add `//registry.npmjs.org/:_authToken=<token>` to ~/.npmrc, set NPM_TOKEN, or run ' +
        '`npm login`.',
    )
  }
}

/** `404` — package (or trust id) not found. */
export class NotFoundError extends NptError {
  constructor(detail: string) {
    super(
      `not found (404): ${detail}\n  ` +
        '→ The package must be published before it can be bound. For revoke, the trust id no ' +
        'longer exists.',
    )
  }
}

/** `401` requiring a one-time password. Caller should prompt for an OTP and replay. */
export class OtpRequiredError extends NptError {
  readonly challenge: OtpChallenge
  constructor(challenge: OtpChallenge) {
    super(
      'two-factor authentication required.\n  ' +
        '→ This is an account-level 2FA write and cannot use an automation/granular token.\n  ' +
        '→ Enter your OTP when prompted (or run `npm login` first).',
    )
    this.challenge = challenge
  }
}

/** `429` — rate limited. */
export class RateLimitedError extends NptError {
  /** Retry-After hint, in milliseconds, when the registry provided one. */
  readonly retryAfterMs?: number
  constructor(retryAfterMs?: number) {
    const suffix =
      retryAfterMs === undefined ? '' : `, retry after ${Math.round(retryAfterMs / 1000)}s`
    super(`rate limited (429)${suffix}`)
    this.retryAfterMs = retryAfterMs
  }
}

/** Any other `>= 400` response. */
export class RegistryError extends NptError {
  readonly status: number
  constructor(status: number, message: string) {
    super(`registry error (${status}): ${message}`)
    this.status = status
  }
}

/** `401` for another reason (bad/expired token, GAT used for a write, …). */
export class UnauthorizedError extends NptError {
  constructor(detail: string) {
    super(
      `unauthorized (401): ${detail}\n  ` +
        '→ Your token is missing, expired, or lacks account 2FA. Run `npm login` or set NPM_TOKEN ' +
        'to an account token with 2FA.',
    )
  }
}

/** True if retrying (after backoff) may succeed: 429 or 5xx. */
export function isRetryable(err: unknown): boolean {
  return (
    err instanceof RateLimitedError ||
    (err instanceof RegistryError && err.status >= 500 && err.status <= 599)
  )
}
