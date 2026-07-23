//! `npt` — npm Trusted Publishing manager (interactive wizard + batch commands).

mod cli;
mod color;
mod commands;
mod config;
mod discover;
mod engine;
mod github;
mod i18n;
mod menu;
mod pkgjson;
mod templates;
mod wizard;

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

    // Make Ctrl+C reliable everywhere (during network waits or dialoguer prompts):
    // a dedicated listener exits the process immediately.
    tokio::spawn(async {
        if tokio::signal::ctrl_c().await.is_ok() {
            eprintln!();
            eprintln!("{}", crate::i18n::t("Cancelled.", "已取消。"));
            std::process::exit(130);
        }
    });

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
        // No subcommand → interactive main menu.
        None => {
            menu::run(&cfg).await?;
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
