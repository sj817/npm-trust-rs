//! Package discovery — from local directories (incl. monorepo workspaces) and,
//! optionally, from GitHub repos via the `gh` CLI.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use serde::Deserialize;

/// A package.json we found and care about.
#[derive(Debug, Clone)]
pub struct DiscoveredPackage {
    pub name: String,
    /// `owner/repo` parsed from the `repository` field, if any.
    pub repository: Option<String>,
    pub private: bool,
    /// Local directory containing the package.json (None for gh-sourced).
    pub dir: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct RawPkgJson {
    name: Option<String>,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    repository: Option<serde_json::Value>,
    #[serde(default)]
    workspaces: Option<serde_json::Value>,
}

/// Parse `owner/repo` out of npm's `repository` field (string or `{ url }`),
/// mirroring the intent of `hosted-git-info` for common GitHub forms.
pub fn parse_repository(value: &serde_json::Value) -> Option<String> {
    let raw = match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(map) => map.get("url")?.as_str()?.to_string(),
        _ => return None,
    };
    normalize_github(&raw)
}

/// Strictly validate and normalize a user-entered GitHub `owner/repo`.
///
/// Accepts a bare `owner/repo` or a full GitHub URL; rejects anything else.
/// GitHub owner/repo name rules: 1–39 chars for owner, ASCII alnum plus
/// `-`/`_`/`.` for both segments, no leading/trailing slash, exactly two parts.
pub fn validate_owner_repo(input: &str) -> anyhow::Result<String> {
    let normalized = normalize_github(input)
        .ok_or_else(|| anyhow::anyhow!("expected `owner/repo` or a GitHub URL"))?;
    let (owner, repo) = normalized
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("expected exactly `owner/repo`"))?;
    let valid_seg = |s: &str, max: usize| {
        !s.is_empty()
            && s.len() <= max
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            && s != "."
            && s != ".."
    };
    if !valid_seg(owner, 39) {
        anyhow::bail!("invalid GitHub owner `{owner}`");
    }
    if !valid_seg(repo, 100) {
        anyhow::bail!("invalid GitHub repo `{repo}`");
    }
    Ok(normalized)
}

pub fn normalize_github(raw: &str) -> Option<String> {
    // Handle: github:owner/repo, owner/repo, git+https://github.com/owner/repo.git,
    // git@github.com:owner/repo.git, https://github.com/owner/repo
    let s = raw.trim();
    let s = s.strip_prefix("git+").unwrap_or(s);
    let tail = if let Some(rest) = s.strip_prefix("github:") {
        rest.to_string()
    } else if let Some(idx) = s.find("github.com") {
        let after = &s[idx + "github.com".len()..];
        after.trim_start_matches([':', '/']).to_string()
    } else if s.matches('/').count() == 1 && !s.contains(':') {
        // bare owner/repo
        s.to_string()
    } else {
        return None;
    };
    let tail = tail.trim_end_matches(".git").trim_end_matches('/');
    let parts: Vec<&str> = tail.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() >= 2 {
        Some(format!("{}/{}", parts[0], parts[1]))
    } else {
        None
    }
}

fn read_pkg_json(path: &Path) -> Result<RawPkgJson> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    let raw: RawPkgJson =
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    Ok(raw)
}

fn to_discovered(raw: RawPkgJson, dir: PathBuf) -> Option<DiscoveredPackage> {
    let name = raw.name?;
    let repository = raw.repository.as_ref().and_then(parse_repository);
    Some(DiscoveredPackage {
        name,
        repository,
        private: raw.private,
        dir: Some(dir),
    })
}

/// Discover packages under the given local directories.
///
/// Walks each dir for `package.json` files, skipping `node_modules` and `.git`.
/// Honors npm `workspaces` globs at the root (best-effort: recursive walk already
/// covers nested workspace packages).
pub fn discover_local(dirs: &[PathBuf]) -> Result<Vec<DiscoveredPackage>> {
    let mut out = Vec::new();
    for dir in dirs {
        walk(dir, &mut out)?;
    }
    Ok(out)
}

fn walk(dir: &Path, out: &mut Vec<DiscoveredPackage>) -> Result<()> {
    let pkg = dir.join("package.json");
    if pkg.is_file() {
        if let Ok(raw) = read_pkg_json(&pkg) {
            let has_workspaces = raw.workspaces.is_some();
            if let Some(found) = to_discovered(raw, dir.to_path_buf()) {
                out.push(found);
            }
            // Continue into subdirs regardless, to find workspace packages,
            // unless this dir is a leaf without workspaces.
            let _ = has_workspaces;
        }
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "node_modules" || name == ".git" || name.starts_with('.') {
            continue;
        }
        walk(&path, out)?;
    }
    Ok(())
}

/// Discover packages from a GitHub org/user by listing repos with `gh` and reading
/// each repo's root `package.json`. Requires the `gh` CLI to be installed & authed.
pub fn discover_github(owner: &str, limit: usize) -> Result<Vec<DiscoveredPackage>> {
    ensure_gh()?;
    // List repo full names.
    let out = Command::new("gh")
        .args([
            "repo",
            "list",
            owner,
            "--limit",
            &limit.to_string(),
            "--json",
            "nameWithOwner",
            "--jq",
            ".[].nameWithOwner",
        ])
        .output()
        .context("running `gh repo list`")?;
    if !out.status.success() {
        anyhow::bail!(
            "`gh repo list {owner}` failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let repos: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect();

    let mut pkgs = Vec::new();
    for repo in repos {
        if let Some(pkg) = fetch_repo_pkg_json(&repo) {
            pkgs.push(pkg);
        }
    }
    Ok(pkgs)
}

fn fetch_repo_pkg_json(repo: &str) -> Option<DiscoveredPackage> {
    // gh api returns base64 content; use --jq to decode.
    let out = Command::new("gh")
        .args([
            "api",
            &format!("repos/{repo}/contents/package.json"),
            "--jq",
            ".content",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None; // no package.json / not accessible
    }
    let b64: String = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .collect();
    let decoded = base64_decode(&b64)?;
    let raw: RawPkgJson = serde_json::from_slice(&decoded).ok()?;
    let name = raw.name.clone()?;
    let repository = raw
        .repository
        .as_ref()
        .and_then(parse_repository)
        .or_else(|| Some(repo.to_string()));
    Some(DiscoveredPackage {
        name,
        repository,
        private: raw.private,
        dir: None,
    })
}

fn ensure_gh() -> Result<()> {
    Command::new("gh")
        .arg("--version")
        .output()
        .map(|_| ())
        .context("the `gh` CLI is required for --org/--user scanning but was not found")
}

/// Minimal standard base64 decoder (avoids adding a dependency).
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lut = [255u8; 256];
    for (i, &c) in TABLE.iter().enumerate() {
        lut[c as usize] = i as u8;
    }
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &b in input.as_bytes() {
        if b == b'=' || b.is_ascii_whitespace() {
            continue;
        }
        let v = lut[b as usize];
        if v == 255 {
            return None;
        }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_various_repository_forms() {
        let cases = [
            ("git+https://github.com/npm/cli.git", "npm/cli"),
            ("https://github.com/npm/cli", "npm/cli"),
            ("git@github.com:npm/cli.git", "npm/cli"),
            ("github:npm/cli", "npm/cli"),
            ("npm/cli", "npm/cli"),
        ];
        for (input, want) in cases {
            assert_eq!(
                normalize_github(input).as_deref(),
                Some(want),
                "input {input}"
            );
        }
        assert_eq!(normalize_github("https://gitlab.com/a/b"), None);
    }

    #[test]
    fn parses_object_repository_field() {
        let v = serde_json::json!({ "type": "git", "url": "git+https://github.com/o/r.git" });
        assert_eq!(parse_repository(&v).as_deref(), Some("o/r"));
    }

    #[test]
    fn base64_roundtrip() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
    }

    #[test]
    fn validate_owner_repo_accepts_and_rejects() {
        assert_eq!(validate_owner_repo("npm/cli").unwrap(), "npm/cli");
        assert_eq!(
            validate_owner_repo("https://github.com/npm/cli").unwrap(),
            "npm/cli"
        );
        assert_eq!(
            validate_owner_repo("git@github.com:npm/cli.git").unwrap(),
            "npm/cli"
        );
        for bad in ["", "just-owner", "a/b/c/d/e", "own er/repo", "owner/"] {
            assert!(validate_owner_repo(bad).is_err(), "should reject {bad:?}");
        }
    }
}
