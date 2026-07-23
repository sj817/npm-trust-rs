//! Interactive setup wizard for the package in the current directory.
//!
//! Walks a single package end-to-end: login → existence → repository → workflow →
//! GitHub repo → first publish → trusted-publisher binding. See the flow in
//! `plans`/README. Reuses the registry client, OTP writer, and helpers from
//! [`crate::engine`]; only the orchestration lives here.

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result};
use npm_trust::TrustConfig;

use crate::cli::WizardArgs;
use crate::config::Config;
use crate::discover::validate_owner_repo;
use crate::engine::{self, describe_binding, Writer};
use crate::pkgjson::PkgJson;
use crate::{github, templates};

pub async fn run(args: WizardArgs, cfg: &Config) -> Result<()> {
    let dir = args.dir.as_path();
    println!("npt — Trusted Publishing setup wizard\n");
    if args.dry_run {
        println!("(dry run — no registry writes or publishes; local files may still be written)\n");
    }

    // 1. Login. resolve_client(require = true) prints identity and errors out if
    //    credentials are missing or invalid.
    let (client, _valid) = engine::resolve_client(true).await?;

    // 2. package.json + name.
    let mut pkg = PkgJson::load(dir)?;
    let name = pkg
        .name()
        .ok_or_else(|| anyhow::anyhow!("package.json has no \"name\" — set one first"))?
        .to_string();
    println!("→ package: {name}");
    if pkg.is_private() {
        eprintln!("⚠ package.json has \"private\": true — it cannot be published to the public registry.");
        if !engine::confirm("Continue anyway?", false)? {
            return Ok(());
        }
    }

    // 3. Registry existence.
    let exists = client.package_exists(&name).await?;
    println!(
        "→ registry: {}",
        if exists { "already published" } else { "not published yet" }
    );

    // 4. repository field.
    let owner_repo = match pkg.repository_owner_repo() {
        Some(r) => {
            println!("→ repository (from package.json): {r}");
            r
        }
        None => {
            eprintln!("package.json has no valid GitHub `repository` field.");
            let owner_repo = prompt_owner_repo()?;
            pkg.set_repository(&owner_repo);
            pkg.save()?;
            println!(
                "✓ wrote repository to {} → {owner_repo}",
                pkg.path().display()
            );
            owner_repo
        }
    };

    // 5. Workflow file (+ template if missing).
    let default_wf = args
        .workflow
        .clone()
        .unwrap_or_else(|| cfg.defaults.workflow.clone());
    let workflow = prompt_workflow(&default_wf)?;
    ensure_workflow_file(dir, &workflow)?;

    // 6. GitHub repo existence.
    match github::repo_exists(&owner_repo).await {
        Ok(true) => println!("→ GitHub: {owner_repo} exists"),
        Ok(false) => {
            eprintln!(
                "⚠ GitHub repo {owner_repo} does not exist (or is not visible). The workflow \
                 can't run and the binding won't take effect until the repo exists."
            );
            if !engine::confirm("Continue setting up the binding anyway?", false)? {
                return Ok(());
            }
        }
        Err(e) => {
            eprintln!("⚠ could not verify GitHub repo: {e}");
            if !engine::confirm("Continue anyway?", false)? {
                return Ok(());
            }
        }
    }

    // Build the desired binding now (used for dry-run preview and the real write).
    let desired = TrustConfig::github(
        owner_repo.clone(),
        workflow.clone(),
        cfg.defaults.environment.clone(),
        cfg.default_permissions(),
    );

    if args.dry_run {
        println!("\n(dry run) would ensure binding: {}", describe_binding(&desired));
        if !exists {
            println!("(dry run) would first-publish a placeholder version of {name}");
        }
        return Ok(());
    }

    // 7. First publish (placeholder) if the package doesn't exist yet.
    if !exists {
        println!("\n{name} is not published; a package must exist before it can be bound.");
        if !engine::confirm("Publish a minimal placeholder version now?", false)? {
            println!("Aborted — publish the package first, then re-run the wizard.");
            return Ok(());
        }
        publish_placeholder(&name)?;
    }

    // 8. Ensure the trusted-publisher binding.
    let actual = client.list_trust(&name).await?.into_iter().next();
    let mut writer = Writer::new(&client);
    match actual {
        Some(a) if desired.same_binding(&a) => {
            println!("✓ binding already correct: {}", describe_binding(&a));
        }
        Some(a) => {
            println!("current binding: {}", describe_binding(&a));
            println!("desired binding: {}", describe_binding(&desired));
            if !engine::confirm("Replace the current binding (revoke + create)?", false)? {
                return Ok(());
            }
            let id = a.id.clone().unwrap_or_default();
            writer.revoke(&name, &id).await?;
            writer.create(&name, &desired).await?;
            println!("✓ binding updated: {}", describe_binding(&desired));
        }
        None => {
            println!("desired binding: {}", describe_binding(&desired));
            if !engine::confirm("Create this trusted-publisher binding?", false)? {
                return Ok(());
            }
            writer.create(&name, &desired).await?;
            println!("✓ binding created: {}", describe_binding(&desired));
        }
    }

    // 9. Summary / next steps.
    println!("\nDone. Next step:");
    println!(
        "  Commit `.github/workflows/{workflow}`, push it to {owner_repo}'s default branch,\n  \
         then publish by creating a GitHub Release — CI will publish via OIDC (no token)."
    );
    Ok(())
}

fn prompt_owner_repo() -> Result<String> {
    loop {
        let input = engine::prompt_line("GitHub repository (owner/repo)", None)?;
        match validate_owner_repo(&input) {
            Ok(v) => return Ok(v),
            Err(e) => eprintln!("  invalid: {e}. Try again (e.g. octocat/hello-world)."),
        }
    }
}

fn prompt_workflow(default: &str) -> Result<String> {
    loop {
        let wf = engine::prompt_line("CI workflow filename", Some(default))?;
        if wf.ends_with(".yml") || wf.ends_with(".yaml") {
            // npm requires a bare filename, not a path.
            if wf.contains('/') || wf.contains('\\') {
                eprintln!("  must be a bare filename, not a path.");
                continue;
            }
            return Ok(wf);
        }
        eprintln!("  workflow file must end in .yml or .yaml.");
    }
}

/// Create `.github/workflows/<workflow>` from the default template if it's missing.
fn ensure_workflow_file(dir: &Path, workflow: &str) -> Result<()> {
    let wf_dir = dir.join(".github").join("workflows");
    let wf_path = wf_dir.join(workflow);
    if wf_path.exists() {
        println!("→ workflow file exists: {}", wf_path.display());
        return Ok(());
    }
    std::fs::create_dir_all(&wf_dir)
        .with_context(|| format!("creating {}", wf_dir.display()))?;
    std::fs::write(&wf_path, templates::github_publish_workflow())
        .with_context(|| format!("writing {}", wf_path.display()))?;
    println!("✓ created workflow template: {}", wf_path.display());
    Ok(())
}

/// Publish a minimal placeholder version from a throwaway temp directory, so we
/// don't publish the user's (possibly unready) working tree. OTP is handled by
/// `npm publish` itself.
fn publish_placeholder(name: &str) -> Result<()> {
    let slug = name.replace(['@', '/'], "-");
    let tmp = std::env::temp_dir().join(format!("npt-placeholder-{slug}-{}", std::process::id()));
    std::fs::create_dir_all(&tmp)
        .with_context(|| format!("creating temp dir {}", tmp.display()))?;

    let pkg = serde_json::json!({
        "name": name,
        "version": "0.0.1",
        "description": "Placeholder release to reserve the package name for Trusted Publishing.",
        "license": "MIT"
    });
    std::fs::write(
        tmp.join("package.json"),
        serde_json::to_string_pretty(&pkg)? + "\n",
    )?;
    std::fs::write(
        tmp.join("README.md"),
        format!("# {name}\n\nPlaceholder release. Real content is published via CI (OIDC).\n"),
    )?;

    println!("→ publishing placeholder {name}@0.0.1 (npm will prompt for OTP if needed)…");
    let mut cmd = Command::new("npm");
    cmd.arg("publish").current_dir(&tmp);
    if name.starts_with('@') {
        // Scoped packages default to restricted; make the first publish public.
        cmd.args(["--access", "public"]);
    }
    let status = cmd
        .status()
        .map_err(|e| anyhow::anyhow!("failed to spawn `npm publish`: {e}"))?;

    // Best-effort cleanup.
    let _ = std::fs::remove_dir_all(&tmp);

    if !status.success() {
        anyhow::bail!("`npm publish` failed for placeholder {name}");
    }
    println!("✓ placeholder published");
    Ok(())
}
