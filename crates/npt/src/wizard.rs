//! Interactive setup wizard for the package in the current directory.
//!
//! Walks a single package end-to-end: login → existence → repository → workflow →
//! GitHub repo → first publish → trusted-publisher binding. Reuses the registry
//! client, OTP writer, and helpers from [`crate::engine`]; only the orchestration
//! lives here. UI text is localized via [`crate::i18n`] (errors stay English).

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result};
use npm_trust::TrustConfig;

use crate::cli::WizardArgs;
use crate::config::Config;
use crate::discover::validate_owner_repo;
use crate::engine::{self, describe_binding, Writer};
use crate::i18n::{is_zh, t};
use crate::pkgjson::PkgJson;
use crate::{github, templates};

/// Choose an interpolated message by language (English vs. Chinese).
fn m(en: String, zh: String) -> String {
    if is_zh() {
        zh
    } else {
        en
    }
}

pub async fn run(args: WizardArgs, cfg: &Config) -> Result<()> {
    let dir = args.dir.as_path();
    println!(
        "{}\n",
        t(
            "npt — Trusted Publishing setup wizard",
            "npt — 可信任发布(Trusted Publishing)配置向导"
        )
    );
    if args.dry_run {
        println!(
            "{}\n",
            t(
                "(dry run — no registry writes or publishes; local files may still be written)",
                "(演练模式 — 不写 registry、不发包;本地文件仍可能被写入)"
            )
        );
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
    println!("{}", m(format!("→ package: {name}"), format!("→ 包名:{name}")));
    if pkg.is_private() {
        eprintln!(
            "{}",
            t(
                "⚠ package.json has \"private\": true — it cannot be published to the public registry.",
                "⚠ package.json 里 \"private\": true —— 无法发布到公共 registry。"
            )
        );
        if !engine::confirm(t("Continue anyway?", "仍然继续?"), false)? {
            return Ok(());
        }
    }

    // 3. Registry existence.
    let exists = client.package_exists(&name).await?;
    println!(
        "{}",
        if exists {
            t("→ registry: already published", "→ registry:已发布")
        } else {
            t("→ registry: not published yet", "→ registry:尚未发布")
        }
    );

    // 4. repository field.
    let owner_repo = match pkg.repository_owner_repo() {
        Some(r) => {
            println!(
                "{}",
                m(
                    format!("→ repository (from package.json): {r}"),
                    format!("→ 仓库(来自 package.json):{r}")
                )
            );
            r
        }
        None => {
            eprintln!(
                "{}",
                t(
                    "package.json has no valid GitHub `repository` field.",
                    "package.json 缺少合法的 GitHub `repository` 字段。"
                )
            );
            let owner_repo = prompt_owner_repo()?;
            pkg.set_repository(&owner_repo);
            pkg.save()?;
            println!(
                "{}",
                m(
                    format!("✓ wrote repository to {} → {owner_repo}", pkg.path().display()),
                    format!("✓ 已写入 repository 到 {} → {owner_repo}", pkg.path().display())
                )
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
        Ok(true) => println!(
            "{}",
            m(format!("→ GitHub: {owner_repo} exists"), format!("→ GitHub:{owner_repo} 存在"))
        ),
        Ok(false) => {
            eprintln!(
                "{}",
                m(
                    format!(
                        "⚠ GitHub repo {owner_repo} does not exist (or is not visible). The \
                         workflow can't run and the binding won't take effect until the repo exists."
                    ),
                    format!(
                        "⚠ GitHub 仓库 {owner_repo} 不存在(或不可见)。仓库存在前,workflow 无法\
                         运行、绑定也不会生效。"
                    )
                )
            );
            if !engine::confirm(
                t(
                    "Continue setting up the binding anyway?",
                    "仍然继续设置绑定吗?"
                ),
                false,
            )? {
                return Ok(());
            }
        }
        Err(e) => {
            eprintln!(
                "{}",
                m(
                    format!("⚠ could not verify GitHub repo: {e}"),
                    format!("⚠ 无法验证 GitHub 仓库:{e}")
                )
            );
            if !engine::confirm(t("Continue anyway?", "仍然继续?"), false)? {
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
        println!(
            "{}",
            m(
                format!("\n(dry run) would ensure binding: {}", describe_binding(&desired)),
                format!("\n(演练)将确保绑定:{}", describe_binding(&desired))
            )
        );
        if !exists {
            println!(
                "{}",
                m(
                    format!("(dry run) would first-publish a placeholder version of {name}"),
                    format!("(演练)将先发布 {name} 的占位版本")
                )
            );
        }
        return Ok(());
    }

    // 7. First publish (placeholder) if the package doesn't exist yet.
    if !exists {
        println!(
            "{}",
            m(
                format!("\n{name} is not published; a package must exist before it can be bound."),
                format!("\n{name} 尚未发布;包必须先存在才能绑定。")
            )
        );
        if !engine::confirm(
            t(
                "Publish a minimal placeholder version now?",
                "现在发布一个最小占位版本吗?"
            ),
            false,
        )? {
            println!(
                "{}",
                t(
                    "Aborted — publish the package first, then re-run the wizard.",
                    "已取消 —— 请先发布该包,再重新运行向导。"
                )
            );
            return Ok(());
        }
        publish_placeholder(&name)?;
    }

    // 8. Ensure the trusted-publisher binding.
    let actual = client.list_trust(&name).await?.into_iter().next();
    let mut writer = Writer::new(&client);
    match actual {
        Some(a) if desired.same_binding(&a) => {
            println!(
                "{}",
                m(
                    format!("✓ binding already correct: {}", describe_binding(&a)),
                    format!("✓ 绑定已正确:{}", describe_binding(&a))
                )
            );
        }
        Some(a) => {
            println!(
                "{}",
                m(
                    format!("current binding: {}", describe_binding(&a)),
                    format!("当前绑定:{}", describe_binding(&a))
                )
            );
            println!(
                "{}",
                m(
                    format!("desired binding: {}", describe_binding(&desired)),
                    format!("目标绑定:{}", describe_binding(&desired))
                )
            );
            if !engine::confirm(
                t(
                    "Replace the current binding (revoke + create)?",
                    "替换当前绑定(先撤销再创建)?"
                ),
                false,
            )? {
                return Ok(());
            }
            let id = a.id.clone().unwrap_or_default();
            writer.revoke(&name, &id).await?;
            writer.create(&name, &desired).await?;
            println!(
                "{}",
                m(
                    format!("✓ binding updated: {}", describe_binding(&desired)),
                    format!("✓ 绑定已更新:{}", describe_binding(&desired))
                )
            );
        }
        None => {
            println!(
                "{}",
                m(
                    format!("desired binding: {}", describe_binding(&desired)),
                    format!("目标绑定:{}", describe_binding(&desired))
                )
            );
            if !engine::confirm(
                t(
                    "Create this trusted-publisher binding?",
                    "创建这个可信任发布绑定?"
                ),
                false,
            )? {
                return Ok(());
            }
            writer.create(&name, &desired).await?;
            println!(
                "{}",
                m(
                    format!("✓ binding created: {}", describe_binding(&desired)),
                    format!("✓ 绑定已创建:{}", describe_binding(&desired))
                )
            );
        }
    }

    // 9. Summary / next steps.
    println!("{}", t("\nDone. Next step:", "\n完成。下一步:"));
    println!(
        "{}",
        m(
            format!(
                "  Commit `.github/workflows/{workflow}`, push it to {owner_repo}'s default \
                 branch,\n  then publish by creating a GitHub Release — CI will publish via OIDC \
                 (no token)."
            ),
            format!(
                "  提交 `.github/workflows/{workflow}` 并推送到 {owner_repo} 的默认分支,\n  \
                 然后创建一个 GitHub Release 即可触发 CI 通过 OIDC 免 token 发布。"
            )
        )
    );
    Ok(())
}

fn prompt_owner_repo() -> Result<String> {
    loop {
        let input = engine::prompt_line(
            t("GitHub repository (owner/repo)", "GitHub 仓库(owner/repo)"),
            None,
        )?;
        match validate_owner_repo(&input) {
            Ok(v) => return Ok(v),
            Err(e) => eprintln!(
                "{}",
                m(
                    format!("  invalid: {e}. Try again (e.g. octocat/hello-world)."),
                    format!("  无效:{e}。请重试(例如 octocat/hello-world)。")
                )
            ),
        }
    }
}

fn prompt_workflow(default: &str) -> Result<String> {
    loop {
        let wf = engine::prompt_line(t("CI workflow filename", "CI workflow 文件名"), Some(default))?;
        if wf.ends_with(".yml") || wf.ends_with(".yaml") {
            // npm requires a bare filename, not a path.
            if wf.contains('/') || wf.contains('\\') {
                eprintln!(
                    "{}",
                    t(
                        "  must be a bare filename, not a path.",
                        "  必须是纯文件名,不能是路径。"
                    )
                );
                continue;
            }
            return Ok(wf);
        }
        eprintln!(
            "{}",
            t(
                "  workflow file must end in .yml or .yaml.",
                "  workflow 文件名必须以 .yml 或 .yaml 结尾。"
            )
        );
    }
}

/// Create `.github/workflows/<workflow>` from the default template if it's missing.
fn ensure_workflow_file(dir: &Path, workflow: &str) -> Result<()> {
    let wf_dir = dir.join(".github").join("workflows");
    let wf_path = wf_dir.join(workflow);
    if wf_path.exists() {
        println!(
            "{}",
            m(
                format!("→ workflow file exists: {}", wf_path.display()),
                format!("→ workflow 文件已存在:{}", wf_path.display())
            )
        );
        return Ok(());
    }
    std::fs::create_dir_all(&wf_dir).with_context(|| format!("creating {}", wf_dir.display()))?;
    std::fs::write(&wf_path, templates::github_publish_workflow())
        .with_context(|| format!("writing {}", wf_path.display()))?;
    println!(
        "{}",
        m(
            format!("✓ created workflow template: {}", wf_path.display()),
            format!("✓ 已生成 workflow 模板:{}", wf_path.display())
        )
    );
    Ok(())
}

/// Publish a minimal placeholder version from a throwaway temp directory, so we
/// don't publish the user's (possibly unready) working tree. OTP is handled by
/// `npm publish` itself.
fn publish_placeholder(name: &str) -> Result<()> {
    let slug = name.replace(['@', '/'], "-");
    let tmp = std::env::temp_dir().join(format!("npt-placeholder-{slug}-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).with_context(|| format!("creating temp dir {}", tmp.display()))?;

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

    println!(
        "{}",
        m(
            format!("→ publishing placeholder {name}@0.0.1 (npm will prompt for OTP if needed)…"),
            format!("→ 正在发布占位版 {name}@0.0.1(如需要 npm 会提示输入 OTP)…")
        )
    );
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
    println!("{}", t("✓ placeholder published", "✓ 占位版已发布"));
    Ok(())
}
