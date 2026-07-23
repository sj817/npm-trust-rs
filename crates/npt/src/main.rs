//! `npt` — npm Trusted Publishing manager (interactive wizard + batch commands).

mod cli;
mod commands;
mod config;
mod discover;
mod engine;
mod github;
mod i18n;
mod pkgjson;
mod templates;
mod wizard;

use std::process::ExitCode;

use clap::Parser;

use crate::cli::{Cli, CommandKind, WizardArgs};
use crate::config::Config;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .without_time()
        .init();

    match run().await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(2)
        }
    }
}

async fn run() -> anyhow::Result<ExitCode> {
    let cli = Cli::parse();
    let cfg = Config::load(&cli.config)?;

    match cli.command {
        // No subcommand → run the interactive wizard with defaults.
        None => {
            wizard::run(WizardArgs::default(), &cfg).await?;
            Ok(ExitCode::SUCCESS)
        }
        Some(CommandKind::Init(args)) => {
            wizard::run(args, &cfg).await?;
            Ok(ExitCode::SUCCESS)
        }
        Some(CommandKind::Scan(args)) => {
            commands::scan::run(args, &cfg).await?;
            Ok(ExitCode::SUCCESS)
        }
        Some(CommandKind::Sync(args)) => {
            commands::sync::run(args, &cfg).await?;
            Ok(ExitCode::SUCCESS)
        }
        Some(CommandKind::Audit(args)) => {
            let code = commands::audit::run(args, &cfg).await?;
            Ok(ExitCode::from(code as u8))
        }
    }
}
