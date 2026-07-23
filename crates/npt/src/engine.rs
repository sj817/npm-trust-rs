//! Shared engine: credentials, client construction, desired-binding derivation,
//! status classification, and the OTP-aware write wrapper.

use std::io::{self, IsTerminal};
use std::process::Command;

use anyhow::{Context, Result};
use npm_trust::{npmrc, Client, Error, TrustConfig};

/// Build a `Command` that invokes npm.
///
/// On Windows npm is `npm.cmd` (a batch script), which `Command::new("npm")` can't
/// launch directly (CreateProcess ignores PATHEXT), so we go through `cmd /C npm`.
pub fn npm_command() -> Command {
    if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", "npm"]);
        c
    } else {
        Command::new("npm")
    }
}

use crate::config::Config;
use crate::discover::DiscoveredPackage;

/// How a package's registry binding compares to what we want.
#[derive(Debug, Clone, PartialEq)]
pub enum BindingStatus {
    /// Package is not published to the registry yet.
    Unpublished,
    /// Published, but we have no credentials to read its trust config.
    Unknown,
    /// Published, no trust config, and we can't derive a desired one (no repo).
    NoBinding,
    /// Published with no trust config, but we know the desired binding.
    Missing,
    /// Actual binding matches the desired binding.
    Correct,
    /// Actual binding differs from the desired binding.
    Drift,
    /// Has a binding but we have no desired binding to compare against.
    Untracked,
}

impl BindingStatus {
    pub fn label(&self) -> &'static str {
        match self {
            BindingStatus::Unpublished => "unpublished",
            BindingStatus::Unknown => "unknown (no creds)",
            BindingStatus::NoBinding => "no binding (no repo)",
            BindingStatus::Missing => "missing",
            BindingStatus::Correct => "correct",
            BindingStatus::Drift => "DRIFT",
            BindingStatus::Untracked => "untracked",
        }
    }
}

/// The assessment of a single package.
#[derive(Debug, Clone)]
pub struct PackagePlan {
    pub name: String,
    pub published: bool,
    pub desired: Option<TrustConfig>,
    pub actual: Option<TrustConfig>,
    pub status: BindingStatus,
    pub repository: Option<String>,
    pub workflow: Option<String>,
}

/// Resolve npm credentials and print the identity. `require` forces a hard error
/// when nothing is found (used by write commands). Returns the client and whether
/// usable credentials were found.
pub async fn resolve_client(require: bool) -> Result<(Client, bool)> {
    let cred = npmrc::resolve_token();
    let token = cred.as_ref().map(|c| c.token.clone());

    let client = Client::builder()
        .token(token.clone())
        .user_agent(format!("npm-trust-rs/{} npt", env!("CARGO_PKG_VERSION")))
        .build()
        .context("building registry client")?;

    match &cred {
        Some(c) => {
            let mut valid = true;
            eprintln!(
                "{}",
                crate::i18n::t(
                    "→ verifying npm login (GET /-/whoami)…",
                    "→ 正在验证 npm 登录(GET /-/whoami)…"
                )
            );
            match client.whoami().await {
                Ok(who) => eprintln!(
                    "{}",
                    crate::color::ok(&if crate::i18n::is_zh() {
                        format!("→ 已登录:{}(来自 {})", who.username, c.source)
                    } else {
                        format!("→ authenticated as {} (via {})", who.username, c.source)
                    })
                ),
                Err(e) => {
                    valid = false;
                    eprintln!(
                        "{}",
                        if crate::i18n::is_zh() {
                            format!("⚠ 凭据({})验证失败:{e}", c.source)
                        } else {
                            format!("⚠ credentials from {} did not validate: {e}", c.source)
                        }
                    );
                    if require {
                        return Err(anyhow::anyhow!("invalid credentials"));
                    }
                }
            }
            Ok((client, valid))
        }
        None => {
            if require {
                anyhow::bail!(
                    "no npm credentials found.\n  → Add //registry.npmjs.org/:_authToken to \
                     ~/.npmrc, set NPM_TOKEN, or run `npm login`."
                );
            }
            eprintln!(
                "{}",
                crate::i18n::t(
                    "→ no credentials; running read-only (existence checks only)",
                    "→ 未提供凭据;只读模式(仅做存在性检查)"
                )
            );
            Ok((client, false))
        }
    }
}

/// Derive the desired trust config for a discovered package, honoring `npt.toml`
/// overrides and a CLI `--workflow` override. Returns `None` if we can't determine
/// a target repository.
pub fn desired_binding(
    pkg: &DiscoveredPackage,
    cfg: &Config,
    workflow_override: Option<&str>,
) -> Option<(TrustConfig, String, String)> {
    let rule = cfg.rule_for(&pkg.name);
    if rule.map(|r| r.ignore).unwrap_or(false) {
        return None;
    }

    let repository = rule
        .and_then(|r| r.repository.clone())
        .or_else(|| pkg.repository.clone())?;

    let workflow = workflow_override
        .map(String::from)
        .or_else(|| rule.and_then(|r| r.workflow.clone()))
        .unwrap_or_else(|| cfg.defaults.workflow.clone());

    let environment = rule
        .and_then(|r| r.environment.clone())
        .or_else(|| cfg.defaults.environment.clone());

    let permissions = cfg.default_permissions();
    let tc = TrustConfig::github(
        repository.clone(),
        workflow.clone(),
        environment,
        permissions,
    );
    Some((tc, repository, workflow))
}

/// Classify a package given existence, desired, and actual bindings.
pub fn classify(
    published: bool,
    have_creds: bool,
    desired: Option<&TrustConfig>,
    actual: Option<&TrustConfig>,
) -> BindingStatus {
    if !published {
        return BindingStatus::Unpublished;
    }
    if !have_creds {
        return BindingStatus::Unknown;
    }
    match (desired, actual) {
        (_, Some(a)) => match desired {
            Some(d) if d.same_binding(a) => BindingStatus::Correct,
            Some(_) => BindingStatus::Drift,
            None => BindingStatus::Untracked,
        },
        (Some(_), None) => BindingStatus::Missing,
        (None, None) => BindingStatus::NoBinding,
    }
}

/// Assess every discovered package: existence check + (if creds) current binding,
/// compared against the desired binding.
pub async fn assess(
    client: &Client,
    have_creds: bool,
    packages: &[DiscoveredPackage],
    cfg: &Config,
    workflow_override: Option<&str>,
) -> Result<Vec<PackagePlan>> {
    let mut plans = Vec::with_capacity(packages.len());
    for pkg in packages {
        // Skip private packages: they are never published to the public registry.
        if pkg.private {
            continue;
        }
        let published = client.package_exists(&pkg.name).await.unwrap_or(false);

        let desired = desired_binding(pkg, cfg, workflow_override);
        let (desired_cfg, repository, workflow) = match desired {
            Some((c, r, w)) => (Some(c), Some(r), Some(w)),
            None => (None, pkg.repository.clone(), None),
        };

        let actual = if published && have_creds {
            match client.list_trust(&pkg.name, None).await {
                Ok(list) => list.into_iter().next(),
                Err(Error::OtpRequired(_)) | Err(Error::Unauthorized(_)) => None,
                Err(e) => {
                    eprintln!("⚠ could not read trust for {}: {e}", pkg.name);
                    None
                }
            }
        } else {
            None
        };

        let status = classify(published, have_creds, desired_cfg.as_ref(), actual.as_ref());
        plans.push(PackagePlan {
            name: pkg.name.clone(),
            published,
            desired: desired_cfg,
            actual,
            status,
            repository,
            workflow,
        });
    }
    Ok(plans)
}

/// OTP-aware writer. Caches the OTP across calls to exploit the ~5-minute window,
/// prompting again only when the registry issues a fresh challenge.
pub struct Writer<'a> {
    client: &'a Client,
    otp: Option<String>,
}

impl<'a> Writer<'a> {
    pub fn new(client: &'a Client) -> Self {
        Writer { client, otp: None }
    }

    /// List configs, prompting for OTP on challenge (reads can require 2FA too).
    pub async fn list(&mut self, package: &str) -> Result<Vec<TrustConfig>> {
        loop {
            let otp = self.otp.clone();
            match self.client.list_trust(package, otp.as_deref()).await {
                Ok(v) => return Ok(v),
                Err(Error::OtpRequired(ch)) => self.handle_otp(ch)?,
                Err(e) => return Err(e.into()),
            }
        }
    }

    pub async fn create(&mut self, package: &str, cfg: &TrustConfig) -> Result<()> {
        loop {
            let otp = self.otp.clone();
            match self.client.create_trust(package, cfg, otp.as_deref()).await {
                Ok(_) => return Ok(()),
                Err(Error::OtpRequired(ch)) => self.handle_otp(ch)?,
                Err(e) => return Err(e.into()),
            }
        }
    }

    pub async fn revoke(&mut self, package: &str, id: &str) -> Result<()> {
        loop {
            let otp = self.otp.clone();
            match self.client.revoke_trust(package, id, otp.as_deref()).await {
                Ok(()) => return Ok(()),
                Err(Error::OtpRequired(ch)) => self.handle_otp(ch)?,
                Err(e) => return Err(e.into()),
            }
        }
    }

    /// Prompt for a fresh OTP after a challenge, updating the cached window value.
    fn handle_otp(&mut self, challenge: npm_trust::OtpChallenge) -> Result<()> {
        if let Some(web) = &challenge.web {
            eprintln!("→ this operation offers browser 2FA. Open:\n    {}", web.auth_url);
        }
        self.otp = Some(prompt_otp()?);
        Ok(())
    }
}

/// Guard: require an interactive terminal, else a clear error (npm 2FA can't be
/// bypassed for trust writes, and menus/wizard need input).
fn require_tty() -> Result<()> {
    if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
        anyhow::bail!(
            "an interactive terminal is required here. Re-run in a terminal \
             (2FA/OTP cannot be bypassed for trust writes; use scan/audit for CI)."
        );
    }
    Ok(())
}

/// Map a dialoguer interaction error (incl. Ctrl+C interrupt) to anyhow.
fn dialog_err(e: dialoguer::Error) -> anyhow::Error {
    anyhow::anyhow!("interactive prompt failed: {e}")
}

/// Prompt for a one-time password. Errors in non-interactive contexts,
/// matching npm's `otplease` behavior (`docs/api.md` §5.2).
pub fn prompt_otp() -> Result<String> {
    require_tty()?;
    let prompt = crate::i18n::t(
        "This operation requires a one-time password (2FA/OTP). Enter OTP",
        "此操作需要一次性密码(2FA/OTP),请输入 OTP",
    );
    let otp: String = dialoguer::Input::new()
        .with_prompt(prompt)
        .interact_text()
        .map_err(dialog_err)?;
    let otp = otp.trim().to_string();
    if otp.is_empty() {
        anyhow::bail!("no OTP entered");
    }
    Ok(otp)
}

/// Prompt for a line of input, returning `default` on empty. Errors in
/// non-interactive contexts.
pub fn prompt_line(prompt: &str, default: Option<&str>) -> Result<String> {
    require_tty()?;
    let mut input = dialoguer::Input::<String>::new().with_prompt(prompt);
    if let Some(d) = default {
        if !d.is_empty() {
            input = input.default(d.to_string());
        }
    }
    let val = input.interact_text().map_err(dialog_err)?;
    Ok(val.trim().to_string())
}

/// Prompt for a line with a validator; re-asks until it passes. `validate` returns
/// the normalized value on success or an error message shown to the user.
pub fn prompt_validated(
    prompt: &str,
    default: Option<&str>,
    validate: impl Fn(&str) -> std::result::Result<String, String>,
) -> Result<String> {
    require_tty()?;
    loop {
        let raw = prompt_line(prompt, default)?;
        match validate(&raw) {
            Ok(v) => return Ok(v),
            Err(msg) => eprintln!("{}", crate::color::err(&format!("  {msg}"))),
        }
    }
}

/// Ask a yes/no question. `--yes` short-circuits to true.
pub fn confirm(prompt: &str, assume_yes: bool) -> Result<bool> {
    if assume_yes {
        return Ok(true);
    }
    require_tty()?;
    dialoguer::Confirm::new()
        .with_prompt(prompt)
        .default(false)
        .interact()
        .map_err(dialog_err)
}

/// Human summary of a trust config's binding.
pub fn describe_binding(cfg: &TrustConfig) -> String {
    use npm_trust::Provider;
    let perms: Vec<&str> = cfg.permissions.iter().map(|p| p.label()).collect();
    let perms = perms.join("+");
    match &cfg.provider {
        Provider::Github { claims } => format!(
            "github:{}@{}{} [{}]",
            claims.repository,
            claims.workflow_ref.file,
            claims
                .environment
                .as_ref()
                .map(|e| format!(" env={e}"))
                .unwrap_or_default(),
            perms
        ),
        Provider::Gitlab { claims } => format!(
            "gitlab:{}@{} [{}]",
            claims.project_path, claims.ci_config_ref_uri.file, perms
        ),
        Provider::Circleci { claims } => {
            format!("circleci:{} [{}]", claims.vcs_origin, perms)
        }
    }
}

/// The GitHub `owner/repo` a binding targets, if it's a GitHub binding.
pub fn binding_repo(cfg: &TrustConfig) -> Option<&str> {
    match &cfg.provider {
        npm_trust::Provider::Github { claims } => Some(&claims.repository),
        _ => None,
    }
}
