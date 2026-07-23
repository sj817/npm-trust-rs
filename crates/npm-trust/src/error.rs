//! Error types with actionable, user-facing messages.
//!
//! The status→semantics mapping mirrors `docs/api.md` §8, which in turn tracks
//! `npm-registry-fetch/lib/{check-response,errors}.js`.

use std::time::Duration;

/// Details of an OTP (two-factor) challenge returned on a `401`.
#[derive(Debug, Clone)]
pub struct OtpChallenge {
    /// Present when the registry offers a browser second-factor
    /// (`401` body carrying `authUrl`/`doneUrl`; `docs/api.md` §5.3).
    pub web: Option<WebOtp>,
    /// The raw `www-authenticate` header value, for diagnostics.
    pub www_authenticate: Option<String>,
}

/// Web-OTP URLs from the `401` challenge body.
#[derive(Debug, Clone)]
pub struct WebOtp {
    pub auth_url: String,
    pub done_url: String,
}

/// Errors surfaced by the client. Each carries an actionable message via `Display`.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `401` requiring a one-time password. The caller should prompt for an OTP
    /// and replay the request (`Client::*_with_otp`).
    #[error(
        "two-factor authentication required.\n  \
         → This is an account-level 2FA write and cannot use an automation/granular token.\n  \
         → Enter your OTP when prompted (or run `npm login` first)."
    )]
    OtpRequired(OtpChallenge),

    /// `401` with `www-authenticate: ipaddress`.
    #[error("login is not allowed from your IP address (registry returned 401 ipaddress)")]
    IpBlocked,

    /// `401` for another reason (bad/expired token, GAT used for a write, …).
    #[error(
        "unauthorized (401): {0}\n  \
         → Your token is missing, expired, or lacks account 2FA. Run `npm login` or set NPM_TOKEN \
         to an account token with 2FA."
    )]
    Unauthorized(String),

    /// `403` — not an owner/maintainer of the package.
    #[error(
        "forbidden (403): {0}\n  \
         → You lack publish rights on this package. Ask an owner to add you as a maintainer."
    )]
    Forbidden(String),

    /// `404` — package (or trust id) not found.
    #[error(
        "not found (404): {0}\n  \
         → The package must be published before it can be bound. For revoke, the trust id no \
         longer exists."
    )]
    NotFound(String),

    /// `409` — a trust configuration already exists for this package.
    #[error(
        "conflict (409): {0}\n  \
         → npm allows only one trust config per package. Revoke the existing one first \
         (reconcile = revoke + create)."
    )]
    Conflict(String),

    /// `429` — rate limited.
    #[error("rate limited (429){}", .retry_after.map(|d| format!(", retry after {}s", d.as_secs())).unwrap_or_default())]
    RateLimited { retry_after: Option<Duration> },

    /// Any other `>= 400` response.
    #[error("registry error ({status}): {message}")]
    Registry { status: u16, message: String },

    /// A required credential could not be resolved.
    #[error(
        "no npm credentials found.\n  \
         → Add `//registry.npmjs.org/:_authToken=<token>` to ~/.npmrc, set NPM_TOKEN, or run \
         `npm login`."
    )]
    NoCredentials,

    /// Transport-level failure (DNS, TLS, timeout after retries, …).
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),

    /// A malformed response body.
    #[error("failed to parse registry response: {0}")]
    Decode(String),

    #[error("invalid registry URL: {0}")]
    Url(#[from] url::ParseError),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// True if retrying (after backoff) may succeed: 429 or 5xx.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Error::RateLimited { .. } | Error::Registry { status: 500..=599, .. }
        )
    }
}
