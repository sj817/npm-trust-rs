//! Interactive main menu — the default entry point (`npt` with no subcommand).
//!
//! Package-centric: operates on the package.json in the current directory. Reuses
//! the wizard's helpers and the OTP-aware [`Writer`] for all registry work.

use std::path::{Path, PathBuf};

use anyhow::Result;
use dialoguer::{theme::ColorfulTheme, MultiSelect, Select};
use npm_trust::{Client, TrustConfig};

use crate::cli::{AuditArgs, ScanArgs, WizardArgs};
use crate::config::Config;
use crate::engine::{self, binding_repo, describe_binding, Writer};
use crate::i18n::{is_zh, t};
use crate::pkgjson::PkgJson;
use crate::{color, wizard};

fn m(en: String, zh: String) -> String {
    if is_zh() {
        zh
    } else {
        en
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Action {
    Status,
    Wizard,
    Bind,
    Revoke,
    GenCi,
    Publish,
    Batch,
    Scan,
    Audit,
    Quit,
}

/// Cached view of the package's registry state (avoids re-fetching each loop).
struct Snapshot {
    published: bool,
    binding: Option<TrustConfig>,
    binding_known: bool,
}

pub async fn run(cfg: &Config) -> Result<()> {
    println!(
        "{}\n",
        color::title(t(
            "npt — npm Trusted Publishing",
            "npt — npm 可信任发布(Trusted Publishing)"
        ))
    );

    let (client, _valid) = engine::resolve_client(true).await?;

    let mut pkg = PkgJson::load(Path::new(".")).ok();
    let name = pkg.as_ref().and_then(|p| p.name().map(String::from));
    if name.is_none() {
        println!(
            "{}",
            color::warn(t(
                "No package.json in the current directory — only batch commands are available.",
                "当前目录没有 package.json —— 仅提供批量命令。"
            ))
        );
    }

    // Startup snapshot: existence only (cheap, unauth). Binding is fetched lazily
    // so opening the menu never triggers an OTP prompt.
    let mut snap = Snapshot {
        published: match &name {
            Some(n) => client.package_exists(n).await.unwrap_or(false),
            None => false,
        },
        binding: None,
        binding_known: false,
    };

    loop {
        println!();
        print_header(name.as_deref(), &snap);

        let items = menu_items(name.is_some());
        let labels: Vec<&str> = items.iter().map(|(l, _)| l.as_str()).collect();
        let choice = Select::with_theme(&ColorfulTheme::default())
            .with_prompt(t("Choose an action", "选择操作"))
            .items(&labels)
            .default(0)
            .interact_opt();

        let idx = match choice {
            Ok(Some(i)) => i,
            // Esc or Ctrl+C (the latter is also caught by the global handler).
            _ => break,
        };

        match items[idx].1 {
            Action::Quit => break,
            Action::Status => show_status(&client, name.as_deref(), &mut snap).await?,
            Action::Wizard => {
                wizard::run(WizardArgs::default(), cfg).await?;
                refresh(&client, name.as_deref(), &mut snap).await;
            }
            Action::Bind => {
                bind(&client, pkg.as_mut(), name.as_deref(), cfg, &mut snap).await?;
            }
            Action::Revoke => revoke(&client, name.as_deref(), &mut snap).await?,
            Action::GenCi => gen_ci(cfg)?,
            Action::Publish => {
                if let Some(n) = name.as_deref() {
                    if snap.published {
                        println!("{}", color::dim(t("Already published.", "已发布,无需再发。")));
                    } else if engine::confirm(
                        t("Publish a minimal placeholder version now?", "现在发布最小占位版本吗?"),
                        false,
                    )? {
                        wizard::publish_placeholder(n, None)?;
                        refresh(&client, name.as_deref(), &mut snap).await;
                    }
                }
            }
            Action::Batch => batch(&client, cfg).await?,
            Action::Scan => {
                crate::commands::scan::run(scan_args(), cfg).await?;
                if engine::confirm(
                    t(
                        "Select some of these to configure now?",
                        "现在从当前目录勾选一些包来配置?",
                    ),
                    false,
                )? {
                    configure_from_dir(&client, cfg, ".").await?;
                }
            }
            Action::Audit => {
                let _ = crate::commands::audit::run(audit_args(), cfg).await?;
            }
        }
    }
    Ok(())
}

fn menu_items(has_pkg: bool) -> Vec<(String, Action)> {
    let mut items: Vec<(String, Action)> = Vec::new();
    if has_pkg {
        items.push((t("View status", "查看状态(是否发布 + 当前绑定)").into(), Action::Status));
        items.push((t("One-shot setup wizard", "一键配置(完整向导)").into(), Action::Wizard));
        items.push((t("Create / change binding", "创建 / 修改绑定").into(), Action::Bind));
        items.push((t("Revoke binding", "撤销绑定").into(), Action::Revoke));
        items.push((t("Generate / update CI workflow", "生成 / 更新 CI workflow 模板").into(), Action::GenCi));
        items.push((t("Publish placeholder version", "发布占位版(首发)").into(), Action::Publish));
    }
    items.push((
        t("Batch setup (scan a dir, one OTP)", "批量配置(扫描目录,一次 OTP)").into(),
        Action::Batch,
    ));
    items.push((t("Scan (batch)", "扫描 scan(批量)").into(), Action::Scan));
    items.push((t("Audit (batch)", "审计 audit(批量)").into(), Action::Audit));
    items.push((t("Quit", "退出").into(), Action::Quit));
    items
}

fn print_header(name: Option<&str>, snap: &Snapshot) {
    let mut parts: Vec<String> = Vec::new();
    if let Some(n) = name {
        parts.push(color::accent(n));
        parts.push(if snap.published {
            color::ok(t("published", "已发布"))
        } else {
            color::dim(t("not published", "未发布"))
        });
        if snap.binding_known {
            match &snap.binding {
                Some(b) => parts.push(color::ok(&m(
                    format!("bound {}", describe_binding(b)),
                    format!("已绑定 {}", describe_binding(b)),
                ))),
                None => parts.push(color::dim(t("no binding", "未绑定"))),
            }
        } else {
            parts.push(color::dim(t("binding unknown (View status)", "绑定未知(选\"查看状态\")")));
        }
    }
    if !parts.is_empty() {
        println!("{}", parts.join(&color::dim(" · ")));
    }
}

async fn refresh(client: &Client, name: Option<&str>, snap: &mut Snapshot) {
    if let Some(n) = name {
        snap.published = client.package_exists(n).await.unwrap_or(false);
        // Binding state may have changed; mark unknown until next explicit fetch,
        // unless we can fetch quietly (skip to avoid surprise OTP).
        snap.binding_known = false;
        snap.binding = None;
    }
}

async fn show_status(client: &Client, name: Option<&str>, snap: &mut Snapshot) -> Result<()> {
    let Some(n) = name else { return Ok(()) };
    snap.published = client.package_exists(n).await?;
    println!(
        "{}",
        if snap.published {
            t("→ registry: published", "→ registry:已发布")
        } else {
            t("→ registry: not published", "→ registry:未发布")
        }
    );
    if snap.published {
        let mut writer = Writer::new(client);
        let binding = writer.list(n).await?.into_iter().next();
        match &binding {
            Some(b) => println!(
                "{}",
                color::ok(&m(
                    format!("→ current binding: {}", describe_binding(b)),
                    format!("→ 当前绑定:{}", describe_binding(b))
                ))
            ),
            None => println!("{}", color::dim(t("→ no trust binding", "→ 无可信任发布绑定"))),
        }
        snap.binding = binding;
        snap.binding_known = true;
    }
    Ok(())
}

async fn bind(
    client: &Client,
    pkg: Option<&mut PkgJson>,
    name: Option<&str>,
    cfg: &Config,
    snap: &mut Snapshot,
) -> Result<()> {
    let Some(n) = name else { return Ok(()) };

    // Default repo: package.json repository, else current binding's repo.
    let default_repo = pkg
        .as_ref()
        .and_then(|p| p.repository_owner_repo())
        .or_else(|| snap.binding.as_ref().and_then(|b| binding_repo(b).map(String::from)));

    let owner_repo = engine::prompt_validated(
        t("GitHub repository (owner/repo)", "GitHub 仓库(owner/repo)"),
        default_repo.as_deref(),
        |raw| crate::discover::validate_owner_repo(raw).map_err(|e| e.to_string()),
    )?;

    let default_wf = snap
        .binding
        .as_ref()
        .and_then(|b| match &b.provider {
            npm_trust::Provider::Github { claims } => Some(claims.workflow_ref.file.clone()),
            _ => None,
        })
        .unwrap_or_else(|| cfg.defaults.workflow.clone());
    let workflow = engine::prompt_validated(
        t("CI workflow filename", "CI workflow 文件名"),
        Some(&default_wf),
        |wf| {
            if (wf.ends_with(".yml") || wf.ends_with(".yaml")) && !wf.contains('/') && !wf.contains('\\') {
                Ok(wf.to_string())
            } else {
                Err(t(
                    "must be a bare *.yml / *.yaml filename.",
                    "必须是纯 *.yml / *.yaml 文件名。",
                )
                .to_string())
            }
        },
    )?;

    // Ensure the workflow file exists locally (best effort, current dir).
    let _ = wizard::ensure_workflow_file(Path::new("."), &workflow);

    let desired = TrustConfig::github(
        owner_repo,
        workflow,
        cfg.defaults.environment.clone(),
        cfg.default_permissions(),
    );

    let mut writer = Writer::new(client);
    let existing = writer.list(n).await?.into_iter().next();
    match &existing {
        Some(old) if old.same_binding(&desired) => {
            println!("{}", color::ok(t("✓ already the desired binding — nothing to do.", "✓ 已是目标绑定,无需操作。")));
            snap.binding = existing;
            snap.binding_known = true;
            return Ok(());
        }
        Some(old) => {
            println!(
                "{}",
                m(
                    format!("current: {}\ndesired: {}", describe_binding(old), describe_binding(&desired)),
                    format!("当前:{}\n目标:{}", describe_binding(old), describe_binding(&desired))
                )
            );
            if !engine::confirm(t("Replace it (revoke + create)?", "替换它(撤销 + 重建)?"), false)? {
                return Ok(());
            }
            let id = old.id.clone().unwrap_or_default();
            writer.revoke(n, &id).await?;
            writer.create(n, &desired).await?;
        }
        None => {
            println!("{}", m(format!("desired: {}", describe_binding(&desired)), format!("目标:{}", describe_binding(&desired))));
            if !engine::confirm(t("Create this binding?", "创建这个绑定?"), false)? {
                return Ok(());
            }
            writer.create(n, &desired).await?;
        }
    }
    println!("{}", color::ok(&m(format!("✓ binding set: {}", describe_binding(&desired)), format!("✓ 绑定已设置:{}", describe_binding(&desired)))));
    snap.binding = Some(desired);
    snap.binding_known = true;
    Ok(())
}

async fn revoke(client: &Client, name: Option<&str>, snap: &mut Snapshot) -> Result<()> {
    let Some(n) = name else { return Ok(()) };
    let mut writer = Writer::new(client);
    let existing = writer.list(n).await?.into_iter().next();
    match existing {
        None => {
            println!("{}", color::dim(t("No binding to revoke.", "没有可撤销的绑定。")));
            snap.binding = None;
            snap.binding_known = true;
        }
        Some(b) => {
            println!("{}", m(format!("current binding: {}", describe_binding(&b)), format!("当前绑定:{}", describe_binding(&b))));
            if engine::confirm(t("Revoke this binding?", "撤销这个绑定?"), false)? {
                let id = b.id.clone().unwrap_or_default();
                writer.revoke(n, &id).await?;
                println!("{}", color::ok(t("✓ revoked.", "✓ 已撤销。")));
                snap.binding = None;
                snap.binding_known = true;
            }
        }
    }
    Ok(())
}

fn gen_ci(cfg: &Config) -> Result<()> {
    let workflow = engine::prompt_validated(
        t("CI workflow filename", "CI workflow 文件名"),
        Some(&cfg.defaults.workflow),
        |wf| {
            if (wf.ends_with(".yml") || wf.ends_with(".yaml")) && !wf.contains('/') && !wf.contains('\\') {
                Ok(wf.to_string())
            } else {
                Err(t("must be a bare *.yml / *.yaml filename.", "必须是纯 *.yml / *.yaml 文件名。").to_string())
            }
        },
    )?;
    wizard::ensure_workflow_file(Path::new("."), &workflow)
}

/// Batch: prompt for a directory, then scan → select → configure.
async fn batch(client: &Client, cfg: &Config) -> Result<()> {
    let dir = engine::prompt_line(
        t("Directory to scan for packages", "要扫描的目录"),
        Some("."),
    )?;
    configure_from_dir(client, cfg, &dir).await
}

/// Scan a directory for packages, show each one's publish status, let the user
/// multi-select, then for each selected package first-publish a placeholder (if
/// needed) and bind it — reusing one OTP across the whole batch (npm's ~5-minute
/// 2FA window).
async fn configure_from_dir(client: &Client, cfg: &Config, dir: &str) -> Result<()> {
    let found = crate::discover::discover_local(&[PathBuf::from(dir)])?;
    let candidates: Vec<_> = found
        .into_iter()
        .filter(|p| !p.private && !p.name.is_empty())
        .collect();
    if candidates.is_empty() {
        println!(
            "{}",
            color::warn(t(
                "No configurable packages found (need non-private package.json with a name).",
                "未找到可配置的包(需非 private 且含 name 的 package.json)。"
            ))
        );
        return Ok(());
    }

    // Publish status per candidate (fast, unauthenticated — no OTP).
    println!(
        "{}",
        color::dim(&m(
            format!("Scanning {} package(s)…", candidates.len()),
            format!("正在检查 {} 个包的状态…", candidates.len())
        ))
    );
    let mut published = Vec::with_capacity(candidates.len());
    for p in &candidates {
        published.push(client.package_exists(&p.name).await.unwrap_or(false));
    }

    let labels: Vec<String> = candidates
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let pub_s = if published[i] {
                t("published", "已发布")
            } else {
                t("unpublished", "未发布")
            };
            match &p.repository {
                Some(r) => format!("{}  → {r} · {pub_s}", p.name),
                None => format!(
                    "{}  · {pub_s} {}",
                    p.name,
                    t("(no repository — will skip)", "(无 repository,将跳过)")
                ),
            }
        })
        .collect();

    let picked = MultiSelect::with_theme(&ColorfulTheme::default())
        .with_prompt(t(
            "Select packages to configure (space toggles, enter confirms)",
            "勾选要配置的包(空格切换,回车确认)",
        ))
        .items(&labels)
        .defaults(&vec![true; candidates.len()])
        .interact_opt()
        .ok()
        .flatten();
    let Some(picked) = picked else { return Ok(()) };
    if picked.is_empty() {
        println!("{}", color::dim(t("Nothing selected.", "未选择。")));
        return Ok(());
    }

    let bindable = picked
        .iter()
        .filter(|&&i| candidates[i].repository.is_some())
        .count();
    if bindable == 0 {
        println!(
            "{}",
            color::warn(t(
                "None of the selected packages has a repository to bind.",
                "所选包都没有可绑定的 repository。"
            ))
        );
        return Ok(());
    }

    println!(
        "{}",
        m(
            format!("Will configure {bindable} package(s): first-publish placeholder if unpublished, then bind."),
            format!("将配置 {bindable} 个包:未发布则首发占位,然后绑定。")
        )
    );
    if !engine::confirm(
        t("Proceed? You'll enter your OTP once.", "继续?只需输入一次 OTP。"),
        false,
    )? {
        return Ok(());
    }

    let mut otp = engine::prompt_otp()?;
    let mut writer = Writer::with_otp(client, otp.clone());
    let (mut ok, mut fail) = (0u32, 0u32);

    for &i in &picked {
        let p = &candidates[i];
        let name = &p.name;
        println!("\n{}", color::title(&format!("── {name} ──")));
        let Some(repo) = p.repository.clone() else {
            eprintln!(
                "{}",
                color::warn(t("  skipped: package.json has no repository.", "  跳过:package.json 无 repository。"))
            );
            fail += 1;
            continue;
        };

        // First-publish a placeholder if it doesn't exist yet. Retry on OTP expiry;
        // a blank OTP skips this package.
        if !published[i] {
            let mut done = false;
            loop {
                match wizard::publish_placeholder(name, Some(&otp)) {
                    Ok(()) => {
                        done = true;
                        break;
                    }
                    Err(e) => {
                        eprintln!("{}", color::warn(&format!("  publish failed: {e}")));
                        match engine::prompt_otp_optional(t(
                            "  re-enter OTP to retry (blank to skip this package)",
                            "  重输 OTP 重试(留空跳过该包)",
                        ))? {
                            Some(o) => {
                                otp = o;
                                writer.set_otp(otp.clone());
                            }
                            None => break,
                        }
                    }
                }
            }
            if !done {
                fail += 1;
                continue;
            }
        }

        // Bind (create, or revoke+create on drift).
        let desired = TrustConfig::github(
            repo,
            cfg.defaults.workflow.clone(),
            cfg.defaults.environment.clone(),
            cfg.default_permissions(),
        );
        let existing = match writer.list(name).await {
            Ok(v) => v.into_iter().next(),
            Err(e) => {
                eprintln!("{}", color::warn(&format!("  list failed: {e}")));
                fail += 1;
                continue;
            }
        };
        let outcome: Result<&str> = async {
            match &existing {
                Some(a) if a.same_binding(&desired) => Ok("already"),
                Some(a) => {
                    writer.revoke(name, &a.id.clone().unwrap_or_default()).await?;
                    writer.create(name, &desired).await?;
                    Ok("updated")
                }
                None => {
                    writer.create(name, &desired).await?;
                    Ok("created")
                }
            }
        }
        .await;
        match outcome {
            Ok(kind) => {
                let label = match kind {
                    "already" => t("already bound", "已正确绑定"),
                    "updated" => t("rebound", "已改绑"),
                    _ => t("bound", "已绑定"),
                };
                println!("{}", color::ok(&format!("  ✓ {label}: {}", describe_binding(&desired))));
                ok += 1;
            }
            Err(e) => {
                eprintln!("{}", color::warn(&format!("  bind failed: {e}")));
                fail += 1;
            }
        }
    }

    println!(
        "\n{}",
        color::ok(&m(
            format!("Done: {ok} configured, {fail} failed/skipped."),
            format!("完成:成功 {ok} 个,失败/跳过 {fail} 个。")
        ))
    );
    Ok(())
}

fn scan_args() -> ScanArgs {
    ScanArgs {
        org: None,
        user: false,
        dir: vec![".".into()],
        workflow: None,
        limit: 200,
    }
}

fn audit_args() -> AuditArgs {
    AuditArgs {
        org: None,
        dir: vec![".".into()],
        workflow: None,
        json: false,
        limit: 200,
    }
}
