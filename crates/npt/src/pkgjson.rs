//! Minimal read/modify/write of a package's `package.json`, preserving key order
//! (via serde_json's `preserve_order`) so edits are minimally disruptive.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::Value;

use crate::discover;

pub struct PkgJson {
    path: PathBuf,
    value: Value,
}

impl PkgJson {
    /// Load `<dir>/package.json`.
    pub fn load(dir: &Path) -> Result<Self> {
        let path = dir.join("package.json");
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {} — is this a package directory?", path.display()))?;
        let value: Value =
            serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        Ok(PkgJson { path, value })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn name(&self) -> Option<&str> {
        self.value.get("name").and_then(Value::as_str)
    }

    pub fn is_private(&self) -> bool {
        self.value
            .get("private")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// Parsed `owner/repo` from the `repository` field, if present and valid.
    pub fn repository_owner_repo(&self) -> Option<String> {
        self.value
            .get("repository")
            .and_then(discover::parse_repository)
    }

    /// Set the `repository` field to the canonical npm object form for a GitHub
    /// `owner/repo`. Adds the key if missing (preserving order otherwise).
    pub fn set_repository(&mut self, owner_repo: &str) {
        let url = format!("git+https://github.com/{owner_repo}.git");
        let repo = serde_json::json!({ "type": "git", "url": url });
        if let Value::Object(map) = &mut self.value {
            map.insert("repository".to_string(), repo);
        }
    }

    /// Write the file back (2-space indent + trailing newline, matching npm).
    pub fn save(&self) -> Result<()> {
        let mut text = serde_json::to_string_pretty(&self.value)
            .context("serializing package.json")?;
        text.push('\n');
        std::fs::write(&self.path, text)
            .with_context(|| format!("writing {}", self.path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_repository_preserving_order_and_reparses() {
        let mut pkg = PkgJson {
            path: PathBuf::from("package.json"),
            value: serde_json::json!({ "name": "x", "version": "1.0.0" }),
        };
        assert_eq!(pkg.name(), Some("x"));
        assert_eq!(pkg.repository_owner_repo(), None);
        pkg.set_repository("acme/widget");
        assert_eq!(pkg.repository_owner_repo().as_deref(), Some("acme/widget"));
        // name/version still precede the appended repository key.
        let out = serde_json::to_string(&pkg.value).unwrap();
        let name_pos = out.find("\"name\"").unwrap();
        let repo_pos = out.find("\"repository\"").unwrap();
        assert!(name_pos < repo_pos);
    }
}
