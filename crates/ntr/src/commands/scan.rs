//! `ntr scan` — read-only inventory of packages and their trust bindings.

use anyhow::Result;

use crate::cli::ScanArgs;
use crate::config::Config;
use crate::discover;
use crate::engine::{self, describe_binding, PackagePlan};

pub async fn run(args: ScanArgs, cfg: &Config) -> Result<()> {
    // Gather packages from local dirs and/or GitHub.
    let mut packages = Vec::new();
    if !args.dir.is_empty() {
        packages.extend(discover::discover_local(&args.dir)?);
    }
    let owner = args.org.clone().or_else(|| {
        if args.user {
            cfg.defaults.org.clone()
        } else {
            None
        }
    });
    if let Some(owner) = owner {
        match discover::discover_github(&owner, args.limit) {
            Ok(gh) => packages.extend(gh),
            Err(e) => eprintln!("⚠ GitHub discovery skipped: {e}"),
        }
    }
    if packages.is_empty() && args.dir.is_empty() {
        // Default to scanning the current directory.
        packages.extend(discover::discover_local(&[std::path::PathBuf::from(".")])?);
    }

    // Dedup by name (a package may appear from both sources).
    packages.sort_by(|a, b| a.name.cmp(&b.name));
    packages.dedup_by(|a, b| a.name == b.name);

    // Credentials are optional for scan.
    let (client, have_creds) = engine::resolve_client(false).await?;
    let plans = engine::assess(&client, have_creds, &packages, cfg, args.workflow.as_deref()).await?;

    print_table(&plans);
    Ok(())
}

pub fn print_table(plans: &[PackagePlan]) {
    if plans.is_empty() {
        println!("No public packages found.");
        return;
    }
    let name_w = plans.iter().map(|p| p.name.len()).max().unwrap_or(4).max(7);
    println!(
        "{:<name_w$}  {:<9}  {:<20}  TARGET / CURRENT",
        "PACKAGE",
        "PUBLISHED",
        "STATUS",
        name_w = name_w
    );
    for p in plans {
        let target = match (&p.desired, &p.actual) {
            (_, Some(a)) => describe_binding(a),
            (Some(d), None) => format!("want {}", describe_binding(d)),
            (None, None) => p
                .repository
                .clone()
                .map(|r| format!("repo {r}"))
                .unwrap_or_else(|| "-".to_string()),
        };
        println!(
            "{:<name_w$}  {:<9}  {:<20}  {}",
            p.name,
            if p.published { "yes" } else { "no" },
            p.status.label(),
            target,
            name_w = name_w
        );
    }
}
