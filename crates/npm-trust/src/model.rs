//! Trust-configuration data types.
//!
//! These mirror the JSON schema documented in `docs/api.md` §4, extracted from
//! `npm/cli` tag v11.16.0 (`lib/commands/trust/{github,gitlab,circleci}.js`).

use serde::{Deserialize, Serialize};

/// An allowed action on a trusted-publisher configuration.
///
/// Extracted from `lib/commands/trust/index.js` (`PERMISSIONS`):
/// `createPackage` ⇐ `--allow-publish`, `createStagedPackage` ⇐ `--allow-stage-publish`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Permission {
    /// `--allow-publish`
    #[serde(rename = "createPackage")]
    Publish,
    /// `--allow-stage-publish`
    #[serde(rename = "createStagedPackage")]
    StagePublish,
}

impl Permission {
    /// Human label used by npm's output (`TrustCommand.permissionLabels`).
    pub fn label(self) -> &'static str {
        match self {
            Permission::Publish => "publish",
            Permission::StagePublish => "stage publish",
        }
    }
}

/// The `{ "file": "..." }` sub-object used by GitHub (`workflow_ref`) and
/// GitLab (`ci_config_ref_uri`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRef {
    pub file: String,
}

impl FileRef {
    pub fn new(file: impl Into<String>) -> Self {
        FileRef { file: file.into() }
    }
}

/// GitHub Actions claims. Source: `lib/commands/trust/github.js::optionsToBody`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubClaims {
    /// `owner/repo`
    pub repository: String,
    /// Bare workflow filename, e.g. `publish.yml`.
    pub workflow_ref: FileRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

/// GitLab CI/CD claims. Source: `lib/commands/trust/gitlab.js::optionsToBody`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitlabClaims {
    /// `group/project` or `group/subgroup/project`
    pub project_path: String,
    /// Bare pipeline filename, e.g. `.gitlab-ci.yml`.
    pub ci_config_ref_uri: FileRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

/// CircleCI claims. Source: `lib/commands/trust/circleci.js::optionsToBody`.
///
/// The registry uses literal dotted-slash claim keys, preserved here via `rename`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CircleciClaims {
    #[serde(rename = "oidc.circleci.com/org-id")]
    pub org_id: String,
    #[serde(rename = "oidc.circleci.com/project-id")]
    pub project_id: String,
    #[serde(rename = "oidc.circleci.com/pipeline-definition-id")]
    pub pipeline_definition_id: String,
    /// `provider/owner/repo`, no scheme (e.g. `github.com/npm/cli`).
    #[serde(rename = "oidc.circleci.com/vcs-origin")]
    pub vcs_origin: String,
    #[serde(
        rename = "oidc.circleci.com/context-ids",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_ids: Option<Vec<String>>,
}

/// The provider discriminant + its claims. Serializes to `{ "type": ..., "claims": ... }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Provider {
    Github { claims: GithubClaims },
    Gitlab { claims: GitlabClaims },
    Circleci { claims: CircleciClaims },
}

impl Provider {
    pub fn kind(&self) -> &'static str {
        match self {
            Provider::Github { .. } => "github",
            Provider::Gitlab { .. } => "gitlab",
            Provider::Circleci { .. } => "circleci",
        }
    }
}

/// A full trusted-publisher configuration.
///
/// On **create** requests `id` is absent; on **list/create responses** the registry
/// assigns and echoes `id`. The envelope flattens to
/// `{ "id"?, "type", "claims", "permissions" }` (`docs/api.md` §4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(flatten)]
    pub provider: Provider,
    pub permissions: Vec<Permission>,
}

impl TrustConfig {
    /// Build a GitHub Actions trust config.
    pub fn github(
        repository: impl Into<String>,
        workflow_file: impl Into<String>,
        environment: Option<String>,
        permissions: Vec<Permission>,
    ) -> Self {
        TrustConfig {
            id: None,
            provider: Provider::Github {
                claims: GithubClaims {
                    repository: repository.into(),
                    workflow_ref: FileRef::new(workflow_file),
                    environment,
                },
            },
            permissions,
        }
    }

    /// Build a GitLab CI/CD trust config.
    pub fn gitlab(
        project_path: impl Into<String>,
        pipeline_file: impl Into<String>,
        environment: Option<String>,
        permissions: Vec<Permission>,
    ) -> Self {
        TrustConfig {
            id: None,
            provider: Provider::Gitlab {
                claims: GitlabClaims {
                    project_path: project_path.into(),
                    ci_config_ref_uri: FileRef::new(pipeline_file),
                    environment,
                },
            },
            permissions,
        }
    }

    /// Does this config's provider binding equal `other`'s (ignoring `id`)?
    ///
    /// Used by `ntr` reconcile to detect drift: the binding differs when the
    /// provider claims or permission set differ.
    pub fn same_binding(&self, other: &TrustConfig) -> bool {
        self.provider == other.provider && {
            let mut a = self.permissions.clone();
            let mut b = other.permissions.clone();
            a.sort_by_key(|p| *p as u8);
            b.sort_by_key(|p| *p as u8);
            a == b
        }
    }
}

/// Response of `GET /-/whoami`.
#[derive(Debug, Clone, Deserialize)]
pub struct Whoami {
    pub username: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_serializes_to_documented_shape() {
        let cfg = TrustConfig::github("npm/cli", "publish.yml", None, vec![Permission::Publish]);
        let v = serde_json::to_value(&cfg).unwrap();
        assert_eq!(v["type"], "github");
        assert_eq!(v["claims"]["repository"], "npm/cli");
        assert_eq!(v["claims"]["workflow_ref"]["file"], "publish.yml");
        assert!(v["claims"].get("environment").is_none());
        assert_eq!(v["permissions"][0], "createPackage");
        assert!(v.get("id").is_none(), "create body must omit id");
    }

    #[test]
    fn circleci_uses_literal_dotted_keys() {
        let cfg = TrustConfig {
            id: None,
            provider: Provider::Circleci {
                claims: CircleciClaims {
                    org_id: "o".into(),
                    project_id: "p".into(),
                    pipeline_definition_id: "d".into(),
                    vcs_origin: "github.com/a/b".into(),
                    context_ids: None,
                },
            },
            permissions: vec![Permission::StagePublish],
        };
        let v = serde_json::to_value(&cfg).unwrap();
        assert_eq!(v["claims"]["oidc.circleci.com/org-id"], "o");
        assert_eq!(v["claims"]["oidc.circleci.com/vcs-origin"], "github.com/a/b");
        assert!(v["claims"].get("oidc.circleci.com/context-ids").is_none());
        assert_eq!(v["permissions"][0], "createStagedPackage");
    }

    #[test]
    fn response_with_id_round_trips() {
        let json = serde_json::json!({
            "id": "abc123",
            "type": "gitlab",
            "claims": {
                "project_path": "group/proj",
                "ci_config_ref_uri": { "file": ".gitlab-ci.yml" },
                "environment": "prod"
            },
            "permissions": ["createPackage", "createStagedPackage"]
        });
        let cfg: TrustConfig = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.id.as_deref(), Some("abc123"));
        match &cfg.provider {
            Provider::Gitlab { claims } => {
                assert_eq!(claims.project_path, "group/proj");
                assert_eq!(claims.ci_config_ref_uri.file, ".gitlab-ci.yml");
                assert_eq!(claims.environment.as_deref(), Some("prod"));
            }
            _ => panic!("expected gitlab"),
        }
        assert_eq!(cfg.permissions.len(), 2);
    }
}
