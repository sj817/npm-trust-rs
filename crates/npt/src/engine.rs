//! Shared engine: credentials, client construction, desired-binding derivation,
//! status classification, and the OTP-aware write wrapper.

use std::io::{self, IsTerminal, Write};

use anyhow::{Context, Result};
use npm_trust::{npmrc, Client, Error, TrustConfig};

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
            match client.whoami().await {
                Ok(who) => eprintln!("→ authenticated as {} (via {})", who.username, c.source),
                Err(e) => {
                    valid = false;
                    eprintln!("⚠ credentials from {} did not validate: {e}", c.source);
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
            eprintln!("→ no credentials; running read-only (existence checks only)");
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
            match client.list_trust(&pkg.name).await {
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

/// Prompt for a one-time password on the TTY. Errors in non-interactive contexts,
/// matching npm's `otplease` behavior (`docs/api.md` §5.2).
pub fn prompt_otp() -> Result<String> {
    if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
        anyhow::bail!(
            "this operation requires a one-time password, but no interactive terminal is \
             available. Re-run in a terminal (2FA cannot be bypassed for trust writes)."
        );
    }
    eprint!("This operation requires a one-time password.\nEnter OTP: ");
    io::stderr().flush().ok();
    let mut line = String::new();
    io::stdin()
        .read_line(&mut line)
        .context("reading OTP from stdin")?;
    let otp = line.trim().to_string();
    if otp.is_empty() {
        anyhow::bail!("no OTP entered");
    }
    Ok(otp)
}

/// Prompt for a line of input on the TTY, returning `default` if the user just
/// hits enter. Errors in non-interactive contexts.
pub fn prompt_line(prompt: &str, default: Option<&str>) -> Result<String> {
    if !io::stdin().is_terminal() {
        anyhow::bail!(
            "input required ({prompt}) but no interactive terminal is available. \
             Re-run in a terminal, or use the batch subcommands (scan/sync/audit)."
        );
    }
    match default {
        Some(d) if !d.is_empty() => eprint!("{prompt} [{d}]: "),
        _ => eprint!("{prompt}: "),
    }
    io::stderr().flush().ok();
    let mut line = String::new();
    io::stdin().read_line(&mut line).context("reading input")?;
    let val = line.trim();
    if val.is_empty() {
        match default {
            Some(d) => Ok(d.to_string()),
            None => anyhow::bail!("a value is required"),
        }
    } else {
        Ok(val.to_string())
    }
}

/// Ask a yes/no question on the TTY. `--yes` short-circuits to true.
pub fn confirm(prompt: &str, assume_yes: bool) -> Result<bool> {
    if assume_yes {
        return Ok(true);
    }
    if !io::stdin().is_terminal() {
        anyhow::bail!("confirmation required but not a TTY; pass --yes to proceed non-interactively");
    }
    eprint!("{prompt} (y/N) ");
    io::stderr().flush().ok();
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    Ok(matches!(line.trim().to_lowercase().as_str(), "y" | "yes"))
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
