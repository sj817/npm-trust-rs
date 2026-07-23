//! Credential resolution from `~/.npmrc` and the environment.
//!
//! Mirrors `docs/api.md` §2.2 and npm's own auth-key lookup
//! (`npm-registry-fetch/lib/auth.js`): the token lives under a config key of the
//! form `//<host><path>:_authToken`.

use std::path::{Path, PathBuf};

/// Default registry host used for the auth-key lookup.
pub const DEFAULT_REGISTRY_HOST: &str = "//registry.npmjs.org/";

/// A resolved credential and where it came from (for user-facing messages).
#[derive(Debug, Clone)]
pub struct Credential {
    pub token: String,
    pub source: CredentialSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialSource {
    Npmrc(PathBuf),
    EnvNpmToken,
}

impl std::fmt::Display for CredentialSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CredentialSource::Npmrc(p) => write!(f, "{}", p.display()),
            CredentialSource::EnvNpmToken => write!(f, "$NPM_TOKEN"),
        }
    }
}

/// Resolve a token following the documented priority (`docs/api.md` §2.2):
///
/// 1. `//registry.npmjs.org/:_authToken` in the user `~/.npmrc`,
/// 2. environment variable `NPM_TOKEN`,
/// 3. otherwise `None` (caller prompts to log in).
///
/// `${VAR}` references inside `.npmrc` values are expanded against the environment.
pub fn resolve_token() -> Option<Credential> {
    if let Some(path) = user_npmrc_path() {
        if let Some(token) = token_from_npmrc_file(&path) {
            return Some(Credential {
                token,
                source: CredentialSource::Npmrc(path),
            });
        }
    }
    if let Ok(tok) = std::env::var("NPM_TOKEN") {
        let tok = tok.trim();
        if !tok.is_empty() {
            return Some(Credential {
                token: tok.to_string(),
                source: CredentialSource::EnvNpmToken,
            });
        }
    }
    None
}

/// Path to the user's `~/.npmrc`, honoring `$NPM_CONFIG_USERCONFIG`.
pub fn user_npmrc_path() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("NPM_CONFIG_USERCONFIG") {
        if !custom.trim().is_empty() {
            return Some(PathBuf::from(custom));
        }
    }
    dirs::home_dir().map(|h| h.join(".npmrc"))
}

fn token_from_npmrc_file(path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(path).ok()?;
    token_from_npmrc_str(&contents, DEFAULT_REGISTRY_HOST)
}

/// Parse `.npmrc` text and return the `_authToken` for `registry_host`
/// (e.g. `//registry.npmjs.org/`). Exposed for testing.
pub fn token_from_npmrc_str(contents: &str, registry_host: &str) -> Option<String> {
    let key = format!("{registry_host}:_authToken");
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((raw_key, raw_val)) = line.split_once('=') else {
            continue;
        };
        if raw_key.trim() != key {
            continue;
        }
        let val = unquote(raw_val.trim());
        let expanded = expand_env(val)?;
        let expanded = expanded.trim();
        if !expanded.is_empty() {
            return Some(expanded.to_string());
        }
    }
    None
}

fn unquote(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// Expand `${VAR}` references. Returns `None` if any referenced var is unset —
/// matching the intent that an unresolved `${...}` means "no usable token".
fn expand_env(value: &str) -> Option<String> {
    if !value.contains("${") {
        return Some(value.to_string());
    }
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find('}')?;
        let var = &after[..end];
        let val = std::env::var(var).ok()?;
        out.push_str(&val);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_plain_token() {
        let rc = "//registry.npmjs.org/:_authToken=npm_abc123\n";
        assert_eq!(
            token_from_npmrc_str(rc, DEFAULT_REGISTRY_HOST).as_deref(),
            Some("npm_abc123")
        );
    }

    #[test]
    fn ignores_comments_and_other_keys() {
        let rc = "# comment\nregistry=https://registry.npmjs.org/\n//other.org/:_authToken=nope\n//registry.npmjs.org/:_authToken=yes\n";
        assert_eq!(
            token_from_npmrc_str(rc, DEFAULT_REGISTRY_HOST).as_deref(),
            Some("yes")
        );
    }

    #[test]
    fn strips_surrounding_quotes() {
        let rc = "//registry.npmjs.org/:_authToken=\"quoted_tok\"\n";
        assert_eq!(
            token_from_npmrc_str(rc, DEFAULT_REGISTRY_HOST).as_deref(),
            Some("quoted_tok")
        );
    }

    #[test]
    fn expands_env_reference() {
        std::env::set_var("NPM_TRUST_TEST_TOK", "from_env");
        let rc = "//registry.npmjs.org/:_authToken=${NPM_TRUST_TEST_TOK}\n";
        assert_eq!(
            token_from_npmrc_str(rc, DEFAULT_REGISTRY_HOST).as_deref(),
            Some("from_env")
        );
        std::env::remove_var("NPM_TRUST_TEST_TOK");
    }

    #[test]
    fn unresolved_env_reference_yields_none() {
        let rc = "//registry.npmjs.org/:_authToken=${DEFINITELY_UNSET_VAR_XYZ}\n";
        assert_eq!(token_from_npmrc_str(rc, DEFAULT_REGISTRY_HOST), None);
    }
}
