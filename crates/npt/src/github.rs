//! GitHub repository existence check (used by the wizard before creating a binding).

use std::process::Command;

use anyhow::{Context, Result};

/// Does `owner/repo` exist on github.com?
///
/// Prefers the `gh` CLI (uses the user's auth, so private repos resolve too);
/// falls back to an anonymous GitHub REST call when `gh` is unavailable.
pub async fn repo_exists(owner_repo: &str) -> Result<bool> {
    if gh_available() {
        return gh_repo_exists(owner_repo);
    }
    rest_repo_exists(owner_repo).await
}

fn gh_available() -> bool {
    Command::new("gh")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn gh_repo_exists(owner_repo: &str) -> Result<bool> {
    let out = Command::new("gh")
        .args(["api", &format!("repos/{owner_repo}"), "--silent"])
        .output()
        .context("running `gh api`")?;
    if out.status.success() {
        return Ok(true);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("Not Found") || stderr.contains("404") {
        Ok(false)
    } else {
        anyhow::bail!("`gh api repos/{owner_repo}` failed: {}", stderr.trim())
    }
}

async fn rest_repo_exists(owner_repo: &str) -> Result<bool> {
    let url = format!("https://api.github.com/repos/{owner_repo}");
    let client = reqwest::Client::builder()
        .user_agent(concat!("npt/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("building GitHub HTTP client")?;
    let resp = client
        .get(&url)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .context("querying GitHub API")?;
    match resp.status().as_u16() {
        200 => Ok(true),
        404 => Ok(false),
        other => anyhow::bail!("unexpected GitHub API status {other} for {owner_repo}"),
    }
}
