# npm-trust-rs

**Manage npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC)
bindings from Rust — no npm upgrade required.**

npm's Trusted Publishing lets a CI workflow publish packages without a long-lived token,
but binding each package to its repo + workflow is a per-package chore on npmjs.com. The
official `npm trust` command automates it — **but only on npm ≥ 11.15.0**.

`npm-trust-rs` reimplements the underlying registry API natively in Rust. **Trust
operations have zero dependency on your local npm version** — they talk to
`registry.npmjs.org` directly and work even with npm 9/10, or with no npm installed at all.
Your local npm is reused in only two optional places:

1. **Login state** — the `_authToken` in `~/.npmrc` (npm 9/10/11 write the same format) is
   reused automatically, so you never have to log in again.
2. **First publish** — a package must exist before it can be bound; new packages are
   published once via `npm publish` (only needed for a brand-new package).

## What's in the box

| Crate | What it is |
|-------|------------|
| [`npm-trust`](crates/npm-trust) | Reusable, `async` API-client library. No CLI deps. HTTP base URL is injectable for testing. |
| [`ntr`](crates/ntr) | CLI that orchestrates `scan` / `sync` / `audit` across all your repos/packages. |

The wire protocol is fully documented — and cited back to npm CLI source — in
[`docs/api.md`](docs/api.md).

## Install

```sh
cargo install --path crates/ntr     # or: cargo build --release
```

## Quick start

```sh
# 1. Read-only inventory — works even with NO credentials (existence checks only).
ntr scan --dir .

# 2. See what would change (no writes).
ntr sync --dry-run

# 3. Apply. Prompts once for your OTP; batches writes inside the ~5-min 2FA window.
ntr sync

# 4. CI drift gate — exits non-zero if any binding drifted.
ntr audit --json
```

### Commands

```
ntr scan  [--org <org>] [--user] [--dir <path>...] [--workflow <file>]
    Enumerate packages (local package.json incl. monorepo workspaces, or GitHub repos
    via `gh`), skip private packages, and print: package | published? | binding status
    (missing / correct / DRIFT) | target repo/workflow. Pure read-only; runs without
    credentials (binding status is then "unknown").

ntr sync  [--dry-run] [--workflow <file>] [--placeholder | --no-publish] [--yes]
    Reconcile toward the desired state:
      unpublished        → first-publish via `npm publish` (--placeholder for a stub)
      missing binding    → create   (native API)
      drifted binding    → revoke old + create new
      missing workflow   → warn (the binding exists but publishes will fail)
    Summarizes the plan and asks for confirmation (--yes to skip). Trust writes are
    spaced ~2s apart.

ntr audit [--json] [--dir <path>...]
    Read-only reconciliation: expected (from ntr.toml / package.json) vs. actual.
    Exit code != 0 on drift, for CI.
```

### Configuration — `ntr.toml`

Copy [`ntr.toml.example`](ntr.toml.example) to `ntr.toml`. It sets the default workflow
filename, allowed actions, default org, and per-package mapping exceptions.

## Authentication

Credentials are resolved automatically, in order (see [`docs/api.md`](docs/api.md) §2):

1. `//registry.npmjs.org/:_authToken=…` in `~/.npmrc` (with `${VAR}` expansion),
2. the `NPM_TOKEN` environment variable,
3. otherwise you're asked to `npm login`.

At startup `ntr` calls `GET /-/whoami` to validate the token and show who you are. Only
read operations work unauthenticated (package existence).

### Two-factor (OTP)

By design, **trust *write* operations require account-level 2FA and cannot be performed
silently with a token** — this is a security feature of npm, not a limitation of this tool.
`ntr` prompts for your OTP on the first write, then reuses it for the registry's
**~5-minute免-OTP window** so a batch of writes needs only one code. When the window
expires mid-batch, it prompts again. In a non-TTY (CI) context, writes fail fast with an
actionable message rather than hanging.

## How it was built

`docs/api.md` was extracted directly from **npm CLI source at tag `v11.16.0`**
(`lib/commands/trust/*`, `npm-registry-fetch`, `npm-profile`) — every endpoint notes its
source file + function. The Rust client mirrors that contract and is covered by
protocol-level tests (`wiremock`): CRUD, scoped-name escaping, OTP `401 → replay`,
rate-limit retry, and the full error-code mapping.

```sh
cargo test          # unit + wiremock protocol tests
```

## ⚠️ Risks & caveats

- **This is a non-public, reverse-engineered API.** npm can change it without notice. The
  source-file citations in `docs/api.md` exist precisely so the contract can be re-verified
  quickly after an npm upgrade.
- **OTP interaction cannot be removed** for trust writes — the tool only minimizes it to
  "one OTP per session + batch within the window."
- **A package must exist before binding.** First-publish uses `npm publish` (token-based);
  npm/cli#8544 (first-publish-as-OIDC) is still open upstream.
- **One trust config per package.** Changing a binding is revoke-then-create; `ntr sync`
  does this automatically on drift.

## License

MIT OR Apache-2.0.
