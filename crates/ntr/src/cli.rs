//! Command-line interface definition.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "ntr",
    version,
    about = "Batch-manage npm Trusted Publishing (OIDC) bindings — native, no npm required for trust ops",
    long_about = None
)]
pub struct Cli {
    /// Path to the config file (default: ./ntr.toml).
    #[arg(long, global = true, default_value = "ntr.toml")]
    pub config: PathBuf,

    #[command(subcommand)]
    pub command: CommandKind,
}

#[derive(Debug, Subcommand)]
pub enum CommandKind {
    /// Read-only inventory: package existence + current trust binding vs. target.
    Scan(ScanArgs),
    /// Reconcile bindings toward the desired state (create/revoke, first-publish).
    Sync(SyncArgs),
    /// CI-friendly drift check (exit != 0 on drift).
    Audit(AuditArgs),
}

#[derive(Debug, Args)]
pub struct ScanArgs {
    /// Enumerate repos of this GitHub org/user (needs `gh`).
    #[arg(long)]
    pub org: Option<String>,
    /// Use the org from ntr.toml `[defaults].org`.
    #[arg(long)]
    pub user: bool,
    /// Local directories to scan for package.json (repeatable).
    #[arg(long)]
    pub dir: Vec<PathBuf>,
    /// Override the workflow filename used to derive the target binding.
    #[arg(long)]
    pub workflow: Option<String>,
    /// Max repos to list from GitHub.
    #[arg(long, default_value_t = 200)]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct SyncArgs {
    /// GitHub org/user to source packages from (needs `gh`).
    #[arg(long)]
    pub org: Option<String>,
    /// Local directories to scan (default: current dir).
    #[arg(long)]
    pub dir: Vec<PathBuf>,
    /// Override the workflow filename.
    #[arg(long)]
    pub workflow: Option<String>,
    /// Show the plan without making changes.
    #[arg(long)]
    pub dry_run: bool,
    /// Skip confirmation prompts (still prompts for OTP).
    #[arg(long)]
    pub yes: bool,
    /// Publish a minimal placeholder version for unpublished packages.
    #[arg(long, conflicts_with = "no_publish")]
    pub placeholder: bool,
    /// Never publish; skip unpublished packages.
    #[arg(long)]
    pub no_publish: bool,
    /// Max repos to list from GitHub.
    #[arg(long, default_value_t = 200)]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct AuditArgs {
    /// GitHub org/user to source packages from (needs `gh`).
    #[arg(long)]
    pub org: Option<String>,
    /// Local directories to scan (default: current dir).
    #[arg(long)]
    pub dir: Vec<PathBuf>,
    /// Override the workflow filename.
    #[arg(long)]
    pub workflow: Option<String>,
    /// Emit machine-readable JSON.
    #[arg(long)]
    pub json: bool,
    /// Max repos to list from GitHub.
    #[arg(long, default_value_t = 200)]
    pub limit: usize,
}
