//! Default CI workflow templates for npm Trusted Publishing (OIDC).

/// Render a GitHub Actions workflow that publishes to the public npm registry via
/// OIDC (no token). `id-token: write` is what makes trusted publishing work.
///
/// Node 24 ships npm >= 11.5 (which supports OIDC publish), so no npm upgrade step
/// is needed.
pub fn github_publish_workflow() -> &'static str {
    r#"name: Publish

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write        # required for npm Trusted Publishing (OIDC)

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm publish
"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_has_oidc_permission_and_publish() {
        let wf = github_publish_workflow();
        assert!(wf.contains("id-token: write"));
        assert!(wf.contains("npm publish"));
        assert!(wf.contains("registry-url: https://registry.npmjs.org"));
    }
}
