//! `ntr` — batch npm Trusted Publishing manager.

mod cli;
mod commands;
mod config;
mod discover;
mod engine;

use std::process::ExitCode;

use clap::Parser;

use crate::cli::{Cli, CommandKind};
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
        CommandKind::Scan(args) => {
            commands::scan::run(args, &cfg).await?;
            Ok(ExitCode::SUCCESS)
        }
        CommandKind::Sync(args) => {
            commands::sync::run(args, &cfg).await?;
            Ok(ExitCode::SUCCESS)
        }
        CommandKind::Audit(args) => {
            let code = commands::audit::run(args, &cfg).await?;
            Ok(ExitCode::from(code as u8))
        }
    }
}
