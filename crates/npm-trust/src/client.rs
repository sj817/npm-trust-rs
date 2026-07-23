//! HTTP client for the npm trusted-publishing registry API.
//!
//! Endpoints and semantics are documented in `docs/api.md`. The base URL is
//! injectable so protocol tests can point the client at a mock server.

use std::time::Duration;

use reqwest::{Method, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;
use url::Url;

use crate::error::{Error, OtpChallenge, Result, WebOtp};
use crate::model::{TrustConfig, Whoami};

/// Default public npm registry.
pub const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org/";

/// Builder for [`Client`].
pub struct ClientBuilder {
    base_url: String,
    token: Option<String>,
    user_agent: String,
    max_retries: u32,
    http: Option<reqwest::Client>,
}

impl Default for ClientBuilder {
    fn default() -> Self {
        ClientBuilder {
            base_url: DEFAULT_REGISTRY.to_string(),
            token: None,
            // A plausible npm-style user-agent (docs/api.md §7).
            user_agent: format!("npm-trust-rs/{}", env!("CARGO_PKG_VERSION")),
            max_retries: 3,
            http: None,
        }
    }
}

impl ClientBuilder {
    /// Registry base URL. Trailing slash optional. Injectable for tests.
    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }

    /// Bearer token from `.npmrc`/`NPM_TOKEN`. `None` = unauthenticated
    /// (existence checks still work).
    pub fn token(mut self, token: Option<String>) -> Self {
        self.token = token;
        self
    }

    pub fn user_agent(mut self, ua: impl Into<String>) -> Self {
        self.user_agent = ua.into();
        self
    }

    /// Number of retries for transient failures (429/5xx/network). Default 3.
    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = n;
        self
    }

    /// Inject a preconfigured `reqwest::Client` (proxies, custom TLS, …).
    pub fn http_client(mut self, client: reqwest::Client) -> Self {
        self.http = Some(client);
        self
    }

    pub fn build(self) -> Result<Client> {
        let mut base = self.base_url;
        if !base.ends_with('/') {
            base.push('/');
        }
        let base_url = Url::parse(&base)?;
        let http = match self.http {
            Some(c) => c,
            None => reqwest::Client::builder()
                .user_agent(&self.user_agent)
                // Fail fast on a stuck network instead of hanging forever.
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(30))
                .build()?,
        };
        Ok(Client {
            http,
            base_url,
            token: self.token,
            user_agent: self.user_agent,
            max_retries: self.max_retries,
        })
    }
}

/// Async client for the npm trusted-publishing API.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base_url: Url,
    token: Option<String>,
    user_agent: String,
    max_retries: u32,
}

impl Client {
    pub fn builder() -> ClientBuilder {
        ClientBuilder::default()
    }

    /// Escape a package name for use in a path segment.
    ///
    /// Mirrors `npm-package-arg`'s `escapedName`: replace **only the first** `/`
    /// with `%2f` (`docs/api.md` §1).
    pub fn escaped_name(name: &str) -> String {
        name.replacen('/', "%2f", 1)
    }

    fn url(&self, path: &str) -> Result<Url> {
        Ok(self.base_url.join(path.trim_start_matches('/'))?)
    }

    /// `GET /-/whoami` — validate the token and return the identity (`docs/api.md` §2.3).
    pub async fn whoami(&self) -> Result<Whoami> {
        let url = self.url("-/whoami")?;
        let resp = self.send(Method::GET, url, None, None).await?;
        self.json(resp).await
    }

    /// Public existence check: `GET /<name>` on the registry, no auth.
    /// `Ok(true)` = published, `Ok(false)` = 404 (`docs/api.md` §9).
    pub async fn package_exists(&self, name: &str) -> Result<bool> {
        let url = self.url(name)?;
        // Build directly (unauthenticated, and 404 is an expected non-error).
        let resp = self
            .http
            .get(url)
            .header("user-agent", &self.user_agent)
            .send()
            .await?;
        match resp.status() {
            StatusCode::NOT_FOUND => Ok(false),
            s if s.is_success() => Ok(true),
            other => Err(map_status(other, read_body(resp).await)),
        }
    }

    /// `GET /-/package/<name>/trust` — list configs (`docs/api.md` §3.1).
    ///
    /// Normalizes the object-or-array response into a `Vec`. npm wraps this read in
    /// `otplease`, so it can return [`Error::OtpRequired`]; pass `otp` to replay,
    /// reusing the account's ~5-minute 2FA window.
    pub async fn list_trust(&self, package: &str, otp: Option<&str>) -> Result<Vec<TrustConfig>> {
        let path = format!("-/package/{}/trust", Self::escaped_name(package));
        let url = self.url(&path)?;
        let resp = self.send(Method::GET, url, None, otp).await?;
        let value: Value = self.json(resp).await?;
        normalize_configs(value)
    }

    /// `POST /-/package/<name>/trust` — create a config (`docs/api.md` §3.2).
    ///
    /// The body is wrapped in a one-element array, per npm's `createConfig`.
    /// Pass `otp` after an [`Error::OtpRequired`]; the registry grants a ~5-minute
    /// window during which the same OTP satisfies subsequent writes.
    pub async fn create_trust(
        &self,
        package: &str,
        config: &TrustConfig,
        otp: Option<&str>,
    ) -> Result<Vec<TrustConfig>> {
        let path = format!("-/package/{}/trust", Self::escaped_name(package));
        let url = self.url(&path)?;
        let body = serde_json::to_value([config]).map_err(|e| Error::Decode(e.to_string()))?;
        let resp = self.send(Method::POST, url, Some(body), otp).await?;
        let value: Value = self.json(resp).await?;
        normalize_configs(value)
    }

    /// `DELETE /-/package/<name>/trust/<id>` — revoke a config (`docs/api.md` §3.3).
    pub async fn revoke_trust(&self, package: &str, id: &str, otp: Option<&str>) -> Result<()> {
        let path = format!(
            "-/package/{}/trust/{}",
            Self::escaped_name(package),
            urlencode(id)
        );
        let url = self.url(&path)?;
        // Success bodies are ignored.
        self.send(Method::DELETE, url, None, otp).await?;
        Ok(())
    }

    /// Send a request with retry/backoff on transient failures, then map errors.
    async fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
        otp: Option<&str>,
    ) -> Result<Response> {
        let mut attempt = 0u32;
        loop {
            let mut req = self
                .http
                .request(method.clone(), url.clone())
                .header("user-agent", &self.user_agent);
            if let Some(tok) = &self.token {
                req = req.bearer_auth(tok);
            }
            if let Some(otp) = otp {
                // npm-otp header (docs/api.md §5.2).
                req = req.header("npm-otp", otp);
            }
            if let Some(b) = &body {
                req = req.json(b);
            }

            let result = req.send().await;
            match result {
                Ok(resp) if resp.status().is_success() => return Ok(resp),
                Ok(resp) => {
                    let status = resp.status();
                    let err = self.map_response(resp).await;
                    if err.is_retryable() && attempt < self.max_retries {
                        let delay = backoff(attempt, retry_after(&err));
                        tracing::debug!(%status, attempt, ?delay, "retrying transient failure");
                        tokio::time::sleep(delay).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(err);
                }
                Err(e) => {
                    // Network-level failure: retry a few times.
                    if attempt < self.max_retries {
                        let delay = backoff(attempt, None);
                        tracing::debug!(error = %e, attempt, ?delay, "retrying network failure");
                        tokio::time::sleep(delay).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(Error::Http(e));
                }
            }
        }
    }

    /// Classify a `>= 400` response into a typed [`Error`].
    async fn map_response(&self, resp: Response) -> Error {
        let status = resp.status();
        let www_auth = resp
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let body = read_body(resp).await;

        if status == StatusCode::UNAUTHORIZED {
            let is_otp = www_auth
                .as_deref()
                .map(|h| header_has(h, "otp"))
                .unwrap_or(false)
                || body.to_lowercase().contains("one-time pass");
            let is_ip = www_auth
                .as_deref()
                .map(|h| header_has(h, "ipaddress"))
                .unwrap_or(false);
            if is_ip {
                return Error::IpBlocked;
            }
            if is_otp {
                return Error::OtpRequired(OtpChallenge {
                    web: parse_web_otp(&body),
                    www_authenticate: www_auth,
                });
            }
            return Error::Unauthorized(message_from(&body));
        }

        match status {
            StatusCode::FORBIDDEN => Error::Forbidden(message_from(&body)),
            StatusCode::NOT_FOUND => Error::NotFound(message_from(&body)),
            StatusCode::CONFLICT => Error::Conflict(message_from(&body)),
            StatusCode::TOO_MANY_REQUESTS => Error::RateLimited { retry_after },
            other => Error::Registry {
                status: other.as_u16(),
                message: message_from(&body),
            },
        }
    }

    async fn json<T: DeserializeOwned>(&self, resp: Response) -> Result<T> {
        let text = read_body(resp).await;
        serde_json::from_str(&text).map_err(|e| Error::Decode(format!("{e}: {text}")))
    }
}

/// `retry-after` extracted from a rate-limit error, if any.
fn retry_after(err: &Error) -> Option<Duration> {
    match err {
        Error::RateLimited { retry_after } => *retry_after,
        _ => None,
    }
}

/// Exponential backoff with a `retry-after` override.
fn backoff(attempt: u32, retry_after: Option<Duration>) -> Duration {
    if let Some(d) = retry_after {
        return d;
    }
    // 200ms, 400ms, 800ms, ... capped at 5s.
    let ms = 200u64.saturating_mul(1 << attempt.min(5));
    Duration::from_millis(ms.min(5_000))
}

fn header_has(header: &str, needle: &str) -> bool {
    header
        .split(',')
        .any(|part| part.trim().to_lowercase() == needle)
}

/// Extract a human message from a JSON `{ "error": ... }` body, else the raw text.
fn message_from(body: &str) -> String {
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(body) {
        if let Some(Value::String(e)) = map.get("error") {
            return e.clone();
        }
        if let Some(Value::String(m)) = map.get("message") {
            return m.clone();
        }
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        "(no response body)".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Parse an `authUrl`/`doneUrl` web-OTP challenge from a `401` body.
fn parse_web_otp(body: &str) -> Option<WebOtp> {
    let v: Value = serde_json::from_str(body).ok()?;
    let auth_url = v.get("authUrl")?.as_str()?.to_string();
    let done_url = v.get("doneUrl")?.as_str()?.to_string();
    Some(WebOtp { auth_url, done_url })
}

/// Normalize the object-or-array trust response into a `Vec` (`docs/api.md` §3.1).
fn normalize_configs(value: Value) -> Result<Vec<TrustConfig>> {
    match value {
        Value::Null => Ok(vec![]),
        Value::Array(_) => {
            serde_json::from_value(value).map_err(|e| Error::Decode(e.to_string()))
        }
        Value::Object(ref map) if map.is_empty() => Ok(vec![]),
        other => {
            let one: TrustConfig =
                serde_json::from_value(other).map_err(|e| Error::Decode(e.to_string()))?;
            Ok(vec![one])
        }
    }
}

async fn read_body(resp: Response) -> String {
    resp.text().await.unwrap_or_default()
}

/// Map a bare status to an error (used on the unauth existence path, no headers).
fn map_status(status: StatusCode, body: String) -> Error {
    Error::Registry {
        status: status.as_u16(),
        message: message_from(&body),
    }
}

/// Percent-encode a path segment (trust id). Encodes everything outside the
/// RFC 3986 unreserved set, matching JS `encodeURIComponent` closely enough for ids.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_scoped_name_first_slash_only() {
        assert_eq!(Client::escaped_name("foo"), "foo");
        assert_eq!(Client::escaped_name("@scope/foo"), "@scope%2ffoo");
    }

    #[test]
    fn normalizes_single_object_and_array_and_empty() {
        let obj = serde_json::json!({
            "id": "1", "type": "github",
            "claims": { "repository": "a/b", "workflow_ref": { "file": "p.yml" } },
            "permissions": ["createPackage"]
        });
        assert_eq!(normalize_configs(obj.clone()).unwrap().len(), 1);
        assert_eq!(
            normalize_configs(Value::Array(vec![obj])).unwrap().len(),
            1
        );
        assert_eq!(normalize_configs(Value::Null).unwrap().len(), 0);
        assert_eq!(
            normalize_configs(serde_json::json!({})).unwrap().len(),
            0
        );
    }

    #[test]
    fn extracts_error_message() {
        assert_eq!(message_from(r#"{"error":"nope"}"#), "nope");
        assert_eq!(message_from("plain text"), "plain text");
        assert_eq!(message_from(""), "(no response body)");
    }

    #[test]
    fn parses_web_otp_body() {
        let w = parse_web_otp(r#"{"authUrl":"https://a","doneUrl":"https://d"}"#).unwrap();
        assert_eq!(w.auth_url, "https://a");
        assert_eq!(w.done_url, "https://d");
        assert!(parse_web_otp(r#"{"error":"otp"}"#).is_none());
    }

    #[test]
    fn urlencodes_ids() {
        assert_eq!(urlencode("abc-123"), "abc-123");
        assert_eq!(urlencode("a/b c"), "a%2Fb%20c");
    }
}
