# npm-trust-rs

**Set up npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) with
one interactive command — no npm upgrade required.**

npm's Trusted Publishing lets a CI workflow publish packages without a long-lived token,
but wiring up each package (repo + workflow binding, `id-token` permissions, first publish)
is fiddly. The official `npm trust` command helps — **but only on npm ≥ 11.15.0**.

`npm-trust-rs` reimplements the underlying registry API natively in Rust. **Trust
operations have zero dependency on your local npm version** — they talk to
`registry.npmjs.org` directly and work even with npm 9/10, or with no npm installed at all.
Your local npm login (`~/.npmrc` `_authToken`) is reused automatically, and `npm publish`
is only shelled out for a brand-new package's first (placeholder) release.

## Install

**Via npm (recommended — no Rust toolchain needed):**

```sh
npm install -g @qwqojs/npt
npt            # run the wizard in your package directory
```

The binary ships as a platform-specific optional dependency
(`@qwqojs/npt-<platform>-<arch>`, built for win32/darwin/linux × x64/arm64); npm installs
only the one matching your OS/CPU via its `os`/`cpu` fields. The launcher
([`npm/npt/bin.js`](npm/npt/bin.js)) resolves and execs it. This is the same pattern
esbuild/biome/swc use. See [`scripts/assemble-npm.mjs`](scripts/assemble-npm.mjs) and
[`.github/workflows/release.yml`](.github/workflows/release.yml) for how the packages are
built and published.

**From source (Rust):**

```sh
cargo install --path crates/npt     # or: cargo build --release
```

## Use it — the wizard

Run `npt` inside your package directory. With no subcommand it launches an interactive
wizard that configures **the package in the current directory** end-to-end:

```sh
npt
```

```
1. Checks you're logged in (reuses ~/.npmrc / NPM_TOKEN; exits if not).
2. Reads package.json's name.
3. Checks whether it's published on the registry.
4. Ensures a valid GitHub `repository` field — prompts + validates + writes it back.
5. Asks for the CI workflow filename; generates a Trusted-Publishing workflow template
   at .github/workflows/<file> if it doesn't exist.
6. Verifies the GitHub repo exists (warns + asks before continuing if not).
7. If the package is new, publishes a minimal placeholder version to reserve the name.
8. Creates (or reconciles) the trusted-publisher binding — prompts once for your OTP.
9. Prints the next step: push the workflow and publish via a GitHub Release.
```

Add `--dry-run` to walk the steps without any registry writes or publishes (local files
like the workflow template are still written), or `--dir <path>` to target another package.

## Batch subcommands (many packages)

For managing bindings across many repos/packages, the batch commands are still here:

```
npt scan  [--org <org>] [--user] [--dir <path>...] [--workflow <file>]
    Read-only inventory: package | published? | binding status (missing/correct/DRIFT) |
    target. Runs without credentials (binding status is then "unknown").

npt sync  [--dry-run] [--workflow <file>] [--placeholder | --no-publish] [--yes]
    Reconcile toward the desired state: first-publish, create, or revoke+recreate on drift.
    Summarizes the plan, confirms, and spaces trust writes ~2s apart.

npt audit [--json] [--dir <path>...]
    CI drift gate: expected vs. actual, exit code != 0 on drift.
```

### Configuration — `npt.toml`

Copy [`npt.toml.example`](npt.toml.example) to `npt.toml` to set the default workflow
filename, allowed actions, default org, and per-package mapping exceptions. Optional — the
wizard works without it.

## Authentication

Credentials are resolved automatically (see [`docs/api.md`](docs/api.md) §2):

1. `//registry.npmjs.org/:_authToken=…` in `~/.npmrc` (with `${VAR}` expansion),
2. the `NPM_TOKEN` environment variable,
3. otherwise you're asked to `npm login`.

At startup `npt` calls `GET /-/whoami` to validate the token and show who you are. Only read
operations work unauthenticated (package existence).

### Two-factor (OTP)

By design, **trust *write* operations require account-level 2FA and cannot be performed
silently with a token** — a security feature of npm, not a limitation of this tool. `npt`
prompts for your OTP on the first write, then reuses it for the registry's **~5-minute
window** so a batch needs only one code. In a non-TTY (CI) context, interactive steps fail
fast with an actionable message rather than hanging.

## Layout

| Crate | What it is |
|-------|------------|
| [`npm-trust`](crates/npm-trust) | Reusable `async` API-client library. No CLI deps. HTTP base URL is injectable for testing. |
| [`npt`](crates/npt) | The CLI: interactive `wizard` + `scan`/`sync`/`audit`. |

The wire protocol is documented — and cited back to npm CLI source (tag `v11.16.0`) — in
[`docs/api.md`](docs/api.md). The library is covered by `wiremock` protocol tests (CRUD,
scoped-name escaping, OTP `401 → replay`, rate-limit retry, error-code mapping):

```sh
cargo test
```

## Publishing these npm packages (maintainers)

The main package + 6 platform binary packages are published together. Because Trusted
Publishing (OIDC) can't be configured for a package that doesn't exist yet, the **first**
release is done locally with your 2FA — one OTP for the whole batch:

```sh
# 1. Build every platform (push a tag → the release workflow's build job), then pull the
#    binaries locally:
gh run download <run-id> -D artifacts        # artifacts/<rust-target>/npt[.exe]

# 2. Assemble + publish all packages. You're prompted ONCE for your OTP; every
#    `npm publish` reuses it within npm's ~5-minute 2FA window (auto re-prompts if it
#    expires mid-run):
node scripts/assemble-npm.mjs --artifacts artifacts --version <x.y.z> --publish
```

After that first publish, configure Trusted Publishing for each package (use `npt`!) and
subsequent releases go tokenless via the OIDC `release.yml` workflow — no OTP, no token.

In CI (non-interactive) the same script skips the OTP prompt and relies on OIDC.

## ⚠️ Risks & caveats

- **This is a non-public, reverse-engineered API.** npm can change it without notice; the
  source-file citations in `docs/api.md` exist so the contract can be re-verified after an
  npm upgrade.
- **OTP interaction cannot be removed** for trust writes — the tool only minimizes it to one
  OTP per session + batch within the window.
- **A package must exist before binding.** The wizard first-publishes a placeholder;
  npm/cli#8544 (first-publish-as-OIDC) is still open upstream.
- **One trust config per package.** Changing a binding is revoke-then-create; the wizard and
  `sync` do this automatically on drift.

## License

MIT OR Apache-2.0.
