//! Interactive setup wizard for the package in the current directory.
//!
//! Walks a single package end-to-end: login → existence → repository → (early-exit
//! if already bound) → workflow → GitHub repo → first publish → binding. Reuses the
//! registry client, OTP writer, and helpers from [`crate::engine`]; UI text is
//! localized via [`crate::i18n`] and colored via [`crate::color`].

use std::path::Path;

use anyhow::{Context, Result};
use npm_trust::TrustConfig;

use crate::cli::WizardArgs;
use crate::config::Config;
use crate::discover::validate_owner_repo;
use crate::engine::{self, binding_repo, describe_binding, Writer};
use crate::i18n::{is_zh, t};
use crate::pkgjson::PkgJson;
use crate::{color, github, templates};

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
        color::title(t(
            "npt — Trusted Publishing setup wizard",
            "npt — 可信任发布(Trusted Publishing)配置向导"
        ))
    );
    if args.dry_run {
        println!(
            "{}\n",
            color::dim(t(
                "(dry run — no registry writes or publishes; local files may still be written)",
                "(演练模式 — 不写 registry、不发包;本地文件仍可能被写入)"
            ))
        );
    }

    // 0. Confirm this is a package directory FIRST (before any network).
    require_package_dir(dir)?;

    // 1. Login.
    let (client, _valid) = engine::resolve_client(true).await?;

    // 2. package.json + name.
    let mut pkg = PkgJson::load(dir)?;
    let name = pkg
        .name()
        .ok_or_else(|| anyhow::anyhow!("package.json has no \"name\" — set one first"))?
        .to_string();
    println!(
        "{}",
        m(
            format!("→ package: {}", color::accent(&name)),
            format!("→ 包名:{}", color::accent(&name))
        )
    );
    if pkg.is_private() {
        eprintln!(
            "{}",
            color::warn(t(
                "⚠ package.json has \"private\": true — it cannot be published to the public registry.",
                "⚠ package.json 里 \"private\": true —— 无法发布到公共 registry。"
            ))
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
    let owner_repo = ensure_repository(&mut pkg)?;

    // 5. If published, look at the existing binding — maybe we're already done.
    let mut writer = Writer::new(&client);
    let mut existing: Option<TrustConfig> = None;
    if exists {
        existing = writer.list(&name).await?.into_iter().next();
        if let Some(a) = &existing {
            let cur = describe_binding(a);
            if binding_repo(a) == Some(owner_repo.as_str()) {
                println!(
                    "{}",
                    color::ok(&m(
                        format!("✓ already bound: {cur} — nothing to do.",),
                        format!("✓ 已绑定:{cur} —— 无需操作。")
                    ))
                );
                println!(
                    "{}",
                    color::dim(t(
                        "  (to change repo/workflow, revoke it first, or use the menu.)",
                        "  (如需更换仓库/workflow,先撤销再配置,或使用交互式菜单。)"
                    ))
                );
                return Ok(());
            }
            eprintln!(
                "{}",
                color::warn(&m(
                    format!("⚠ existing binding points elsewhere (drift): {cur}"),
                    format!("⚠ 已有绑定指向了别处(漂移):{cur}")
                ))
            );
            if !engine::confirm(
                t(
                    "Rebind to the repository from package.json?",
                    "改绑到 package.json 指定的仓库?"
                ),
                false,
            )? {
                return Ok(());
            }
        }
    }

    // 6. Workflow file (+ template if missing).
    let default_wf = args
        .workflow
        .clone()
        .unwrap_or_else(|| cfg.defaults.workflow.clone());
    let workflow = prompt_workflow(&default_wf)?;
    ensure_workflow_file(dir, &workflow)?;

    // 7. GitHub repo existence.
    check_github_repo(&owner_repo).await?;

    // Build the desired binding (for dry-run preview and the real write).
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

    // 8. First publish (placeholder) if needed.
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
        publish_placeholder(&name, None)?;
    }

    // 9. Create or rebuild the binding.
    match existing {
        Some(old) => {
            let id = old.id.clone().unwrap_or_default();
            writer.revoke(&name, &id).await?;
            writer.create(&name, &desired).await?;
            println!(
                "{}",
                color::ok(&m(
                    format!("✓ binding updated: {}", describe_binding(&desired)),
                    format!("✓ 绑定已更新:{}", describe_binding(&desired))
                ))
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
                color::ok(&m(
                    format!("✓ binding created: {}", describe_binding(&desired)),
                    format!("✓ 绑定已创建:{}", describe_binding(&desired))
                ))
            );
        }
    }

    // 10. Summary / next steps.
    print_next_steps(&owner_repo, &workflow);
    Ok(())
}

/// Fail fast with a clear hint if `dir` has no package.json (no network first).
pub(crate) fn require_package_dir(dir: &Path) -> Result<()> {
    if dir.join("package.json").exists() {
        return Ok(());
    }
    let abs = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let abs = abs.display().to_string();
    let abs = abs.strip_prefix(r"\\?\").unwrap_or(&abs);
    eprintln!(
        "{}",
        color::err(&m(
            format!(
                "✗ Not an npm package — no package.json in this directory.\n  here: {abs}\n  \
                 → cd into your package directory (the one containing package.json), then run `npt`."
            ),
            format!(
                "✗ 当前目录不是 npm 包 —— 这里没有 package.json。\n  当前目录:{abs}\n  \
                 → 请先 cd 到你的 npm 包目录(含 package.json),再运行 `npt`。"
            )
        ))
    );
    std::process::exit(2);
}

/// Ensure the package.json `repository` is a valid GitHub owner/repo, prompting and
/// writing it back if missing. Returns the owner/repo.
pub(crate) fn ensure_repository(pkg: &mut PkgJson) -> Result<String> {
    if let Some(r) = pkg.repository_owner_repo() {
        println!(
            "{}",
            m(
                format!("→ repository (from package.json): {}", color::accent(&r)),
                format!("→ 仓库(来自 package.json):{}", color::accent(&r))
            )
        );
        return Ok(r);
    }
    eprintln!(
        "{}",
        color::warn(t(
            "package.json has no valid GitHub `repository` field.",
            "package.json 缺少合法的 GitHub `repository` 字段。"
        ))
    );
    let owner_repo = engine::prompt_validated(
        t("GitHub repository (owner/repo)", "GitHub 仓库(owner/repo)"),
        None,
        |raw| validate_owner_repo(raw).map_err(|e| e.to_string()),
    )?;
    pkg.set_repository(&owner_repo);
    pkg.save()?;
    println!(
        "{}",
        color::ok(&m(
            format!("✓ wrote repository to {} → {owner_repo}", pkg.path().display()),
            format!("✓ 已写入 repository 到 {} → {owner_repo}", pkg.path().display())
        ))
    );
    Ok(owner_repo)
}

fn prompt_workflow(default: &str) -> Result<String> {
    engine::prompt_validated(
        t("CI workflow filename", "CI workflow 文件名"),
        Some(default),
        |wf| {
            if !wf.ends_with(".yml") && !wf.ends_with(".yaml") {
                return Err(t(
                    "workflow file must end in .yml or .yaml.",
                    "workflow 文件名必须以 .yml 或 .yaml 结尾。",
                )
                .to_string());
            }
            if wf.contains('/') || wf.contains('\\') {
                return Err(t(
                    "must be a bare filename, not a path.",
                    "必须是纯文件名,不能是路径。",
                )
                .to_string());
            }
            Ok(wf.to_string())
        },
    )
}

/// Create `.github/workflows/<workflow>` from the default template if it's missing.
pub(crate) fn ensure_workflow_file(dir: &Path, workflow: &str) -> Result<()> {
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
        color::ok(&m(
            format!("✓ created workflow template: {}", wf_path.display()),
            format!("✓ 已生成 workflow 模板:{}", wf_path.display())
        ))
    );
    Ok(())
}

/// Check the GitHub repo exists; warn + confirm to continue if not.
async fn check_github_repo(owner_repo: &str) -> Result<()> {
    match github::repo_exists(owner_repo).await {
        Ok(true) => {
            println!(
                "{}",
                m(format!("→ GitHub: {owner_repo} exists"), format!("→ GitHub:{owner_repo} 存在"))
            );
            Ok(())
        }
        Ok(false) => {
            eprintln!(
                "{}",
                color::warn(&m(
                    format!(
                        "⚠ GitHub repo {owner_repo} does not exist (or is not visible). The \
                         workflow can't run and the binding won't take effect until the repo exists."
                    ),
                    format!(
                        "⚠ GitHub 仓库 {owner_repo} 不存在(或不可见)。仓库存在前,workflow 无法\
                         运行、绑定也不会生效。"
                    )
                ))
            );
            if engine::confirm(
                t("Continue setting up the binding anyway?", "仍然继续设置绑定吗?"),
                false,
            )? {
                Ok(())
            } else {
                anyhow::bail!("cancelled");
            }
        }
        Err(e) => {
            eprintln!(
                "{}",
                color::warn(&m(
                    format!("⚠ could not verify GitHub repo: {e}"),
                    format!("⚠ 无法验证 GitHub 仓库:{e}")
                ))
            );
            if engine::confirm(t("Continue anyway?", "仍然继续?"), false)? {
                Ok(())
            } else {
                anyhow::bail!("cancelled");
            }
        }
    }
}

pub(crate) fn print_next_steps(owner_repo: &str, workflow: &str) {
    println!("{}", color::title(t("\nDone. Next step:", "\n完成。下一步:")));
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
}

/// Publish a minimal placeholder version from a throwaway temp directory, so we
/// don't publish the user's (possibly unready) working tree.
///
/// If `otp` is given it's passed as `npm publish --otp=<code>` (batch flows reuse one
/// OTP across many publishes); otherwise npm prompts for 2FA itself.
pub(crate) fn publish_placeholder(name: &str, otp: Option<&str>) -> Result<()> {
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
    let mut cmd = engine::npm_command();
    cmd.arg("publish").current_dir(&tmp);
    if name.starts_with('@') {
        // Scoped packages default to restricted; make the first publish public.
        cmd.args(["--access", "public"]);
    }
    if let Some(o) = otp {
        cmd.arg(format!("--otp={o}"));
    }
    let status = cmd
        .status()
        .map_err(|e| anyhow::anyhow!("failed to spawn `npm publish`: {e}"))?;

    // Best-effort cleanup.
    let _ = std::fs::remove_dir_all(&tmp);

    if !status.success() {
        anyhow::bail!("`npm publish` failed for placeholder {name}");
    }
    println!("{}", color::ok(t("✓ placeholder published", "✓ 占位版已发布")));
    Ok(())
}
