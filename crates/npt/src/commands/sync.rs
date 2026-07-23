//! `npt sync` — reconcile actual bindings toward the desired state.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;

use crate::cli::SyncArgs;
use crate::config::Config;
use crate::discover;
use crate::engine::{self, describe_binding, BindingStatus, PackagePlan, Writer};

/// One planned action.
#[derive(Debug)]
enum Action {
    Publish { name: String, dir: Option<PathBuf>, placeholder: bool },
    Create { name: String },
    Reconcile { name: String, old_id: String }, // revoke old + create new
    WarnMissingWorkflow { name: String, workflow: String },
}

/// npm guidance: space trust writes ~2s apart to stay within limits.
const WRITE_SPACING: Duration = Duration::from_secs(2);

pub async fn run(args: SyncArgs, cfg: &Config) -> Result<()> {
    let dirs = if args.dir.is_empty() {
        vec![PathBuf::from(".")]
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

    // Writes need credentials.
    let (client, have_creds) = engine::resolve_client(true).await?;
    let plans = engine::assess(&client, have_creds, &packages, cfg, args.workflow.as_deref()).await?;

    // Build the action plan.
    let mut actions = Vec::new();
    for p in &plans {
        match p.status {
            BindingStatus::Unpublished => {
                if args.no_publish {
                    eprintln!("skip {}: unpublished and --no-publish set", p.name);
                    continue;
                }
                actions.push(Action::Publish {
                    name: p.name.clone(),
                    dir: package_dir(&packages, &p.name),
                    placeholder: args.placeholder,
                });
                // After publish it would need a Create; handled on the next run,
                // or immediately below if we published successfully.
                if p.desired.is_some() {
                    actions.push(Action::Create { name: p.name.clone() });
                }
            }
            BindingStatus::Missing => {
                if p.desired.is_some() {
                    check_workflow(p, &packages, &mut actions);
                    actions.push(Action::Create { name: p.name.clone() });
                }
            }
            BindingStatus::Drift => {
                if let Some(a) = &p.actual {
                    check_workflow(p, &packages, &mut actions);
                    actions.push(Action::Reconcile {
                        name: p.name.clone(),
                        old_id: a.id.clone().unwrap_or_default(),
                    });
                }
            }
            BindingStatus::Correct
            | BindingStatus::Unknown
            | BindingStatus::NoBinding
            | BindingStatus::Untracked => {}
        }
    }

    if actions.is_empty() {
        println!("Nothing to do — all packages already in the desired state.");
        return Ok(());
    }

    // Summarize the plan.
    println!("\nPlanned actions:");
    for a in &actions {
        println!("  - {}", describe_action(a, &plans));
    }
    println!();

    if args.dry_run {
        println!("(dry run — no changes made)");
        return Ok(());
    }

    if !engine::confirm("Proceed with these actions?", args.yes)? {
        println!("Aborted.");
        return Ok(());
    }

    // Execute.
    let mut writer = Writer::new(&client);
    let mut first_write = true;
    for a in &actions {
        match a {
            Action::WarnMissingWorkflow { name, workflow } => {
                eprintln!(
                    "⚠ {name}: workflow file `.github/workflows/{workflow}` not found in repo — \
                     the binding will exist but publishes will fail until you add it."
                );
            }
            Action::Publish { name, dir, placeholder } => {
                publish(name, dir.as_deref(), *placeholder)?;
            }
            Action::Create { name } => {
                let desired = desired_for(&plans, name);
                if let Some(cfg) = desired {
                    space_writes(&mut first_write).await;
                    println!("→ creating binding for {name}: {}", describe_binding(&cfg));
                    writer.create(name, &cfg).await?;
                }
            }
            Action::Reconcile { name, old_id } => {
                let desired = desired_for(&plans, name);
                if let Some(cfg) = desired {
                    space_writes(&mut first_write).await;
                    println!("→ revoking old binding {old_id} for {name}");
                    writer.revoke(name, old_id).await?;
                    space_writes(&mut first_write).await;
                    println!("→ creating binding for {name}: {}", describe_binding(&cfg));
                    writer.create(name, &cfg).await?;
                }
            }
        }
    }
    println!("\n✓ sync complete.");
    Ok(())
}

async fn space_writes(first: &mut bool) {
    if *first {
        *first = false;
        return;
    }
    tokio::time::sleep(WRITE_SPACING).await;
}

fn desired_for(plans: &[PackagePlan], name: &str) -> Option<npm_trust::TrustConfig> {
    plans
        .iter()
        .find(|p| p.name == name)
        .and_then(|p| p.desired.clone())
}

fn package_dir(pkgs: &[discover::DiscoveredPackage], name: &str) -> Option<PathBuf> {
    pkgs.iter().find(|p| p.name == name).and_then(|p| p.dir.clone())
}

/// If we have the package locally, verify the workflow file exists.
fn check_workflow(p: &PackagePlan, pkgs: &[discover::DiscoveredPackage], actions: &mut Vec<Action>) {
    let (Some(dir), Some(workflow)) = (package_dir(pkgs, &p.name), p.workflow.clone()) else {
        return;
    };
    let wf_path = dir.join(".github").join("workflows").join(&workflow);
    if !wf_path.exists() {
        actions.push(Action::WarnMissingWorkflow {
            name: p.name.clone(),
            workflow,
        });
    }
}

fn describe_action(a: &Action, plans: &[PackagePlan]) -> String {
    match a {
        Action::Publish { name, placeholder, .. } => {
            format!(
                "publish {name}{}",
                if *placeholder { " (placeholder version)" } else { "" }
            )
        }
        Action::Create { name } => {
            let d = desired_for(plans, name)
                .map(|c| describe_binding(&c))
                .unwrap_or_default();
            format!("create binding {name} → {d}")
        }
        Action::Reconcile { name, old_id } => {
            let d = desired_for(plans, name)
                .map(|c| describe_binding(&c))
                .unwrap_or_default();
            format!("reconcile {name}: revoke {old_id} + create {d}")
        }
        Action::WarnMissingWorkflow { name, workflow } => {
            format!("warn {name}: missing workflow {workflow}")
        }
    }
}

/// First-publish fallback. Shells out to `npm publish` (allowed to use token/npm CLI,
/// per the project brief — publish protocol is out of scope for the native client).
fn publish(name: &str, dir: Option<&std::path::Path>, placeholder: bool) -> Result<()> {
    let dir = dir.ok_or_else(|| {
        anyhow::anyhow!("cannot publish {name}: no local package directory (gh-only source)")
    })?;
    if placeholder {
        eprintln!(
            "note: --placeholder requested for {name}; ensure package.json has a minimal \
             publishable version before first publish."
        );
    }
    println!("→ publishing {name} via `npm publish` in {}", dir.display());
    let status = crate::engine::npm_command()
        .arg("publish")
        .current_dir(dir)
        .status()
        .map_err(|e| anyhow::anyhow!("failed to spawn `npm publish`: {e}"))?;
    if !status.success() {
        anyhow::bail!("`npm publish` failed for {name}");
    }
    Ok(())
}
