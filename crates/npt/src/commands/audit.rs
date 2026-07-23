//! `npt audit` — read-only reconciliation check. Exit code != 0 on drift (for CI).

use anyhow::Result;
use serde_json::json;

use crate::cli::AuditArgs;
use crate::config::Config;
use crate::discover;
use crate::engine::{self, describe_binding, BindingStatus};

pub async fn run(args: AuditArgs, cfg: &Config) -> Result<i32> {
    let dirs = if args.dir.is_empty() {
        vec![std::path::PathBuf::from(".")]
    } else {
        args.dir.clone()
    };
    let mut packages = discover::discover_local(&dirs)?;
    if let Some(owner) = args.org.clone() {
        match discover::discover_github(&owner, args.limit) {
            Ok(gh) => packages.extend(gh),
            Err(e) => eprintln!("⚠ GitHub discovery skipped: {e}"),
        }
    }
    packages.sort_by(|a, b| a.name.cmp(&b.name));
    packages.dedup_by(|a, b| a.name == b.name);

    // Audit needs credentials to read actual bindings.
    let (client, have_creds) = engine::resolve_client(true).await?;
    let plans = engine::assess(&client, have_creds, &packages, cfg, args.workflow.as_deref()).await?;

    // Drift = any package we expect to be bound whose actual != desired.
    let mut drifted = Vec::new();
    for p in &plans {
        match p.status {
            BindingStatus::Drift | BindingStatus::Missing => drifted.push(p),
            BindingStatus::Unpublished if p.desired.is_some() => drifted.push(p),
            _ => {}
        }
    }

    if args.json {
        let items: Vec<_> = plans
            .iter()
            .map(|p| {
                json!({
                    "name": p.name,
                    "published": p.published,
                    "status": p.status.label(),
                    "desired": p.desired.as_ref().map(describe_binding),
                    "actual": p.actual.as_ref().map(describe_binding),
                })
            })
            .collect();
        let out = json!({
            "drift": !drifted.is_empty(),
            "drift_count": drifted.len(),
            "packages": items,
        });
        println!("{}", serde_json::to_string_pretty(&out)?);
    } else if drifted.is_empty() {
        println!("✓ audit clean — all expected bindings match ({} packages).", plans.len());
    } else {
        println!("✗ audit found {} drift(s):", drifted.len());
        for p in &drifted {
            let want = p.desired.as_ref().map(describe_binding).unwrap_or_else(|| "-".into());
            let have = p
                .actual
                .as_ref()
                .map(describe_binding)
                .unwrap_or_else(|| p.status.label().to_string());
            println!("  - {}: want {want}, have {have}", p.name);
        }
    }

    Ok(if drifted.is_empty() { 0 } else { 1 })
}
