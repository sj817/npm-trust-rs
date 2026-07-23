//! `npt.toml` — default binding rules and per-package exceptions.

use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

use npm_trust::Permission;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub defaults: Defaults,
    /// Per-package overrides / explicit expectations (used by `audit`).
    #[serde(default, rename = "package")]
    pub packages: Vec<PackageRule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Defaults {
    /// Default workflow filename convention.
    #[serde(default = "default_workflow")]
    pub workflow: String,
    /// Optional CI environment claim.
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default = "default_true")]
    pub allow_publish: bool,
    #[serde(default)]
    pub allow_stage_publish: bool,
    /// Default GitHub org/user for `scan --org/--user`.
    #[serde(default)]
    pub org: Option<String>,
}

impl Default for Defaults {
    fn default() -> Self {
        Defaults {
            workflow: default_workflow(),
            environment: None,
            allow_publish: true,
            allow_stage_publish: false,
            org: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageRule {
    /// Package name this rule applies to.
    pub name: String,
    /// Override GitHub `owner/repo` (the mapping exception).
    #[serde(default)]
    pub repository: Option<String>,
    /// Override workflow filename.
    #[serde(default)]
    pub workflow: Option<String>,
    #[serde(default)]
    pub environment: Option<String>,
    /// If set, `audit` treats this package as expected-unbound (skip).
    #[serde(default)]
    pub ignore: bool,
}

fn default_workflow() -> String {
    "publish.yml".to_string()
}
fn default_true() -> bool {
    true
}

impl Config {
    /// Load `npt.toml` from `path`, or return defaults if it doesn't exist.
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Config::default());
        }
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading {}", path.display()))?;
        let cfg: Config =
            toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        Ok(cfg)
    }

    pub fn rule_for<'a>(&'a self, name: &str) -> Option<&'a PackageRule> {
        self.packages.iter().find(|p| p.name == name)
    }

    /// Permission set implied by the defaults.
    pub fn default_permissions(&self) -> Vec<Permission> {
        let mut p = Vec::new();
        if self.defaults.allow_publish {
            p.push(Permission::Publish);
        }
        if self.defaults.allow_stage_publish {
            p.push(Permission::StagePublish);
        }
        if p.is_empty() {
            // npm requires at least one; fall back to publish.
            p.push(Permission::Publish);
        }
        p
    }
}
