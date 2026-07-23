# npm Trusted Publishing — Registry HTTP API

> **Non-public API.** This document reverse-engineers the registry endpoints that the
> `npm trust` command talks to. It is **extracted from npm CLI source**, not from an
> official registry spec. Every endpoint below cites the source file + function it was
> extracted from so it can be re-verified when npm upgrades.
>
> - **Extraction basis:** `npm/cli` tag **`v11.16.0`** (first `npm trust` GA line is ≥ 11.15.0).
> - **Registry endpoints are client-version-independent** — the paths live on
>   `registry.npmjs.org` and do not change with the local npm version. The CLI tag only
>   fixes *which client code* we read the contract from.
> - Relevant HTTP plumbing lives in the bundled dependencies
>   `npm-registry-fetch@19.1.1` and `npm-profile` (under `node_modules/` of the CLI).

---

## 1. Base URL & path construction

| Item | Value | Source |
|------|-------|--------|
| Default registry | `https://registry.npmjs.org/` | `npm-registry-fetch/lib/default-opts.js` → `registry` |
| npm frontend | `https://www.npmjs.com` | `lib/trust-cmd.js` → `NPM_FRONTEND` |

Relative URIs passed by the trust commands (e.g. `/-/package/<name>/trust`) are resolved
against the registry by trimming a trailing slash from the registry and a leading slash
from the URI (`npm-registry-fetch/lib/index.js` → `regFetch`, lines ~36–49).

### Package-name escaping (`escapedName`)

The trust commands build paths from `npa(pkg).escapedName`:

```js
// npm-package-arg/lib/npa.js:188
this.escapedName = name.replace('/', '%2f')
```

- Only the **first** `/` is replaced (a package name has at most one).
- Unscoped `foo` → `foo`.
- Scoped `@scope/foo` → `@scope%2ffoo` (lowercase `%2f`, not `%2F`).

The revoke path additionally does `encodeURIComponent(id)` on the trust-config id
(`lib/commands/trust/revoke.js:43`).

---

## 2. Authentication

### 2.1 Bearer token (the normal path)

`npm-registry-fetch` resolves auth from config keys of the form
`//<host><path>:_authToken` and sends:

```
Authorization: Bearer <token>
```

Source: `npm-registry-fetch/lib/auth.js` (`getAuth`, `hasAuth`) selects the longest
matching `//registry.npmjs.org/:_authToken`; `npm-registry-fetch/lib/index.js` →
`getHeaders` (lines 237–241) emits the header:

```js
if (auth.token)      headers.authorization = `Bearer ${auth.token}`
else if (auth.auth)  headers.authorization = `Basic ${auth.auth}`   // legacy _auth
```

Basic auth is also supported (`username` + base64 `_password` → `Basic <base64(user:pass)>`),
but the standard `~/.npmrc` login writes `_authToken`, so the Rust client uses Bearer.

> ⚠️ **Trust write operations require an account-level 2FA token and do *not* accept
> Granular Access Tokens.** This is enforced server-side (the write returns a 401/OTP
> challenge regardless of the token type). The client cannot detect GAT vs automation
> token from the token string alone; surface the server's 401 message to the user.

### 2.2 `.npmrc` credential reuse

Priority order the Rust client resolves credentials (mirrors npm's config layering):

1. `//registry.npmjs.org/:_authToken=<token>` in `~/.npmrc` (user config) or a
   project/`userconfig`-pointed `.npmrc`.
2. Environment variable `NPM_TOKEN`.
3. Neither → prompt `npm login` (or run the web-login flow, §6).

**Env-var interpolation:** npm expands `${VAR}` references inside `.npmrc` values at load
time (`@npmcli/config`). A value like `_authToken=${NPM_TOKEN}` must be expanded against
the process environment before use. Unset `${VAR}` → npm leaves the literal text; the
Rust client should treat an unresolved `${...}` as "no token".

### 2.3 Identity check — `GET /-/whoami`

Used at startup to validate a token and show the current user.

- **Method / path:** `GET /-/whoami`
- **Auth:** Bearer (required)
- **Response 200:** `{ "username": "<name>" }`
- **Source:** `lib/utils/get-identity.js` → `npmFetch.json('/-/whoami', opts)`; only called
  when a token (or cert+key) is present, else throws `ENEEDAUTH`.

---

## 3. Trust-config CRUD endpoints

All three operations are wrapped in `otplease(...)` (§5) so a `401 OTP` is transparently
retried with the `npm-otp` header.

### 3.1 List — `GET /-/package/<escapedName>/trust`

- **Source:** `lib/commands/trust/list.js:41–45`

```js
const uri = `/-/package/${spec.escapedName}/trust`
const body = await otplease(npm, flatOptions, opts =>
  npmFetch.json(uri, { ...opts, method: 'GET' }))
```

- **Auth:** Bearer. (Reads *can* trigger an OTP challenge because they go through
  `otplease`, but in practice list is readable with just the token.)
- **Response 200:** JSON. Either a single config object or an **array** of config objects.
  The CLI normalizes with `Array.isArray(body) ? body : [body]`
  (`lib/trust-cmd.js` → `displayResponseBody`, line 332). Empty result → `[]` / empty body.
- Each element matches the **per-provider config schema** in §4.

### 3.2 Create — `POST /-/package/<escapedName>/trust`

- **Source:** `lib/trust-cmd.js` → `createConfig` (lines 58–66) and `createConfigCommand`
  (lines 206–244).

```js
const uri = `/-/package/${spec.escapedName}/trust`
otplease(npm, flatOptions, opts => npmFetch(uri, {
  ...opts, method: 'POST', body,      // body is JSON-stringified by npm-registry-fetch
}))
```

- **Body:** a **JSON array with a single trust-config object** (`createConfigCommand`
  calls `this.createConfig(pkg, [trustConfig])`, line 240). The object shape is
  provider-specific (§4) and always carries a `permissions` array (§4.4).
- **Content-Type:** `application/json` — set automatically because the body is a non-string
  object (`npm-registry-fetch/lib/index.js:63–67`).
- **Response:** JSON body of the created config(s); the CLI reads `await response.json()`
  and renders it (`createConfigCommand:241–243`). Shape matches §4 (single object or array).
- **Preconditions enforced by registry, not the client:**
  - **The package must already exist.** There is no create-package-on-trust path
    (npm/cli#8544 still open). New packages must be published first (token-based publish is
    fine), *then* bound.
  - **One trust config per package.** Changing a binding = revoke old id + create new.
  - **Since 2026-05-20, at least one allowed action is required** (see §4.4). The client
    mirrors this: `createConfigCommand` throws locally if neither `--allow-publish` nor
    `--allow-stage-publish` is set (`lib/trust-cmd.js:214–216`).

### 3.3 Revoke — `DELETE /-/package/<escapedName>/trust/<id>`

- **Source:** `lib/commands/trust/revoke.js:42–47`

```js
const uri = `/-/package/${spec.escapedName}/trust/${encodeURIComponent(id)}`
otplease(npm, flatOptions, opts => npmFetch(uri, { ...opts, method: 'DELETE' }))
```

- **Auth:** Bearer + OTP (write operation).
- **`<id>`:** the `id` field of a config returned by List/Create, URL-encoded.
- **Response:** success status; the CLI ignores the body (`ignoreBody` path). Treat 2xx as
  revoked.

---

## 4. Trust-config JSON schema (per provider)

The config object is built by each provider's `optionsToBody` and parsed back by
`bodyToOptions`. Common envelope:

```jsonc
{
  "id":   "<server-assigned>",   // present in responses, absent in create requests
  "type": "github | gitlab | circleci",
  "claims": { /* provider-specific, see below */ },
  "permissions": ["createPackage", "createStagedPackage"]   // see §4.4
}
```

`type` and `claims` are set by the client; `id` is assigned by the registry and echoed
in List/Create responses.

### 4.1 GitHub Actions — `type: "github"`

Source: `lib/commands/trust/github.js` → `optionsToBody` (70–83) / `bodyToOptions` (86–97).

```jsonc
{
  "type": "github",
  "claims": {
    "repository": "owner/repo",          // required, validated as exactly 2 "/"-parts
    "workflow_ref": { "file": "publish.yml" },  // basename only, must end .yml/.yaml
    "environment": "production"          // OPTIONAL (omitted if unset)
  },
  "permissions": ["createPackage"]
}
```

- `file` must be a **bare filename**, not a path (`validateFile`, github.js:64–68). The full
  on-disk location is `.github/workflows/<file>` (used only for the display URL).
- `repository` format `owner/repo` (exactly one `/`).

### 4.2 GitLab CI/CD — `type: "gitlab"`

Source: `lib/commands/trust/gitlab.js` → `optionsToBody` (69–84) / `bodyToOptions` (87–98).

```jsonc
{
  "type": "gitlab",
  "claims": {
    "project_path": "group/project",           // or group/subgroup/project (>= 2 parts)
    "ci_config_ref_uri": { "file": ".gitlab-ci.yml" },  // basename only, .yml/.yaml
    "environment": "production"                 // OPTIONAL
  },
  "permissions": ["createPackage"]
}
```

- Note the field name difference vs GitHub: `project_path` (not `repository`) and
  `ci_config_ref_uri` (not `workflow_ref`).
- `project_path` allows subgroups (`>= 2` slash-parts; `validateEntity`, gitlab.js:57–61).

### 4.3 CircleCI — `type: "circleci"`

Source: `lib/commands/trust/circleci.js` → `optionsToBody` (81–96) / `bodyToOptions` (98–110).

```jsonc
{
  "type": "circleci",
  "claims": {
    "oidc.circleci.com/org-id":                "<uuid>",
    "oidc.circleci.com/project-id":            "<uuid>",
    "oidc.circleci.com/pipeline-definition-id":"<uuid>",
    "oidc.circleci.com/vcs-origin":            "github.com/owner/repo",  // provider/owner/repo, no scheme
    "oidc.circleci.com/context-ids":           ["<uuid>", "..."]         // OPTIONAL, only if non-empty
  },
  "permissions": ["createPackage"]
}
```

- All four `org-id` / `project-id` / `pipeline-definition-id` values are UUIDs
  (`validateUUID`, `lib/utils/validate-uuid.js`).
- `vcs-origin` is `provider/owner/repo` (≥ 3 parts) and **must not include a scheme**
  (`validateVcsOrigin`, circleci.js:61–70).
- Claim keys are literal dotted-slash strings (`oidc.circleci.com/...`) — send verbatim.

### 4.4 Permissions / allowed actions

Source: `lib/commands/trust/index.js:13–16` (`PERMISSIONS`), `lib/trust-cmd.js:206–239`.

| CLI flag | Permission string in `permissions[]` | Display label |
|----------|---------------------------------------|---------------|
| `--allow-publish` | `createPackage` | `publish` |
| `--allow-stage-publish` (alias `--allow-staged-publish`) | `createStagedPackage` | `stage publish` |

- `permissions` is an **array** built in `createConfigCommand` (lines 218–224, 238–239).
- **At least one is mandatory** — the client throws `At least one permission flag is
  required` if both are false (`trust-cmd.js:214–216`); the registry likewise rejects
  configs created after 2026-05-20 with no allowed action.

---

## 5. OTP (two-factor) challenge flow

Trust **writes** require account-level 2FA. The first write in a session triggers an OTP
challenge; the registry then grants an **~5-minute window** during which subsequent writes
succeed without a fresh OTP (server-side behavior — there is no client artifact for the
window; the client simply retries and only re-prompts when a new `401 OTP` arrives).

### 5.1 Detecting the challenge (`401`)

Source: `npm-registry-fetch/lib/check-response.js` → `checkErrors` (65–107).

A `401` is classified by the **`www-authenticate`** response header (comma-split,
lowercased):

| `www-authenticate` contains | Error code | Meaning |
|-----------------------------|-----------|---------|
| `otp` | `EOTP` | One-time password required |
| `ipaddress` | `EAUTHIP` | Login blocked from this IP |
| (other) | `HttpErrorAuthUnknown` | Unknown auth requirement |

**Heuristic fallback:** a `401` whose body text matches `/one-time pass/` is also treated as
an OTP challenge even without the header (`check-response.js:92–101`).

### 5.2 Classic OTP replay

Source: `lib/utils/auth.js` → `otplease` (6–33).

1. Perform the request. On `EOTP` (or `E401` + body `/one-time pass/`):
2. Prompt the user: `This operation requires a one-time password.\nEnter OTP:`
3. **Replay the same request** with the OTP as a header:

```
npm-otp: <one-time-password>
```

Source for the header: `npm-registry-fetch/lib/index.js` → `getHeaders` (243–245):
`if (opts.otp) headers['npm-otp'] = opts.otp`.

> If stdin/stdout is not a TTY, `otplease` rethrows instead of prompting
> (`auth.js:10–12`). The Rust CLI must do the same for CI-safe behavior.

### 5.3 Web OTP (browser second factor)

Source: `lib/utils/auth.js:15–23`. If the `401` body carries `authUrl` **and** `doneUrl`:

```jsonc
// 401 body
{ "authUrl": "https://www.npmjs.com/...", "doneUrl": "https://registry.npmjs.org/-/..." }
```

1. Open `authUrl` in a browser.
2. Poll `doneUrl` (see §6 polling semantics — same `webAuthOpener`) until it returns a
   `token`/`otp`.
3. Replay the original request with that `otp` via `npm-otp`.

---

## 6. Web login (credential bootstrap, optional)

Used only when there is no reusable token. Source: `npm-profile/lib/index.js`.

### 6.1 Initiate — `POST /-/v1/login`

```
POST /-/v1/login          (npm-profile/lib/index.js:54)
Body: {}                  (empty object on first attempt)
```

- **Response 200:** `{ "doneUrl": "<url>", "loginUrl": "<url>" }` (both must be valid
  http(s) URLs, else `WebLoginInvalidResponse`).
- **Response 4xx/500:** web login not supported → fall back to CouchDB
  (`/-/user/org.couchdb.user:<username>`) — out of scope for the trust client.

### 6.2 Poll — `GET <doneUrl>`

Source: `webAuthCheckLogin` (106–128).

| Status | Action |
|--------|--------|
| `200` | Body `{ "token": "<authToken>" }` → done. Missing token ⇒ invalid response. |
| `202` | Not ready. Honor **`Retry-After`** header (seconds) and poll again. |
| other | `WebLoginInvalidResponse`. |

The returned `token` is a normal registry `_authToken` and can be written to `.npmrc` and
reused per §2.

---

## 7. Required / notable request headers

Source: `npm-registry-fetch/lib/index.js` → `getHeaders` (214–248).

| Header | When sent | Notes / Rust client behavior |
|--------|-----------|------------------------------|
| `authorization: Bearer <token>` | when a token is resolved | primary auth |
| `user-agent` | always | npm default format `npm/<ver> node/<ver> <platform> <arch>`; the Rust client sends a plausible npm-style UA. Default-opts fallback: `npm-registry-fetch@<ver>/node@<ver>+<arch> (<platform>)` (`default-opts.js:9–18`). |
| `content-type: application/json` | non-string object bodies | set automatically for POST create |
| `npm-otp: <otp>` | OTP replay only | §5.2 |
| `npm-command: <name>` | when `opts.npmCommand` set | npm sends the command name; **not known to be required** for trust endpoints. Record here so the Rust client can send `npm-command: trust` if a 4xx suggests gating. |
| `npm-scope`, `npm-session`, `npm-auth-type` | when set in opts | telemetry/session; not required. |

> **Validation TODO (real registry):** confirm whether `registry.npmjs.org` gates the
> trust endpoints on any of `user-agent` / `npm-command`. If a request without them returns
> 4xx, document the exact requirement here and have the Rust client mock it.

---

## 8. Error-code semantics

`npm-registry-fetch` maps every `>= 400` response to `E<status>` (`errors.js` →
`HttpErrorBase.code = 'E' + res.status`). Body is JSON-parsed when possible; `body.error`
carries the human message (`HttpErrorGeneral`).

| Status | `code` | Trust-context meaning | User-facing next step |
|--------|--------|------------------------|-----------------------|
| `401` (`www-authenticate: otp` or body `one-time pass`) | `EOTP` | 2FA required / window expired | Prompt for OTP, replay (§5). |
| `401` (`www-authenticate: ipaddress`) | `EAUTHIP` | IP not allowed | Tell user their IP is blocked. |
| `401` (other) | `E401` / `HttpErrorAuthUnknown` | Bad/expired token, or GAT used for a write | "Token invalid or lacks 2FA — run `npm login` / use an account 2FA token." |
| `403` | `E403` | Not an owner/maintainer of the package | "You lack publish rights on `<pkg>`." |
| `404` | `E404` | Package (or trust id) not found | Package must be published first; for revoke, the id no longer exists. |
| `409` | `E409` | Conflict — a trust config already exists | "Package already has a trust config; revoke it first (reconcile = revoke + create)." |
| `429` | `E429` | Rate limited | Back off; honor `Retry-After` if present. Space trust writes ~2s apart (npm guidance). |
| `5xx` | `E5xx` | Registry error | Retry with backoff. |

> **Exact 4xx bodies for "already exists" / "package not found" / "insufficient
> permission" are not fully pinned from source** (they originate server-side). §Validation
> against a throwaway package must capture the real status + `body.error` strings and update
> this table.

`npm-registry-fetch` also retries transient failures automatically
(`fetchRetries`/`fetchRetryFactor`, index.js:125–130) — the Rust client implements
equivalent exponential-backoff retry on `429`/`5xx`/network errors.

---

## 9. Client behavior checklist (for the Rust implementation)

- [ ] Resolve token: `.npmrc` `//registry.npmjs.org/:_authToken` (with `${VAR}` expansion) → `NPM_TOKEN` → prompt.
- [ ] Escape package name via `name.replace('/', '%2f')` (first slash only).
- [ ] `GET /-/whoami` at startup to validate + display identity.
- [ ] `GET /<name>` (public, unauth) for existence check — 404 = not published (see note below).
- [ ] List: `GET /-/package/<esc>/trust`; normalize object-or-array.
- [ ] Create: `POST /-/package/<esc>/trust` with a **one-element array** body + `permissions`.
- [ ] Revoke: `DELETE /-/package/<esc>/trust/<urlencoded-id>`.
- [ ] OTP: on `EOTP`/`one-time pass` 401 → prompt once, replay with `npm-otp`; reuse the OTP
      for the ~5-min window; re-prompt on the next `EOTP`.
- [ ] Non-TTY → never prompt; fail with actionable message.
- [ ] Space trust writes ~2s apart; back off on 429.

### Package existence check (public, unauthenticated)

`GET https://registry.npmjs.org/<name>` — `404` = does not exist, `200` = exists. No auth
required. (Not part of `npm trust`; documented in the project brief and used by `ntr scan`.)

---

## 10. Source-file index (tag v11.16.0)

| Concern | File · symbol |
|---------|---------------|
| Subcommand registry | `lib/commands/trust/index.js` · `Trust.subcommands` |
| Shared command base, create/list helpers | `lib/trust-cmd.js` · `TrustCommand` (`createConfig`, `createConfigCommand`, `displayResponseBody`) |
| Permissions map | `lib/commands/trust/index.js` · `PERMISSIONS` |
| GitHub body/parse | `lib/commands/trust/github.js` · `optionsToBody`/`bodyToOptions` |
| GitLab body/parse | `lib/commands/trust/gitlab.js` · `optionsToBody`/`bodyToOptions` |
| CircleCI body/parse | `lib/commands/trust/circleci.js` · `optionsToBody`/`bodyToOptions` |
| List (GET) | `lib/commands/trust/list.js` · `exec` |
| Revoke (DELETE) | `lib/commands/trust/revoke.js` · `exec` |
| OTP orchestration | `lib/utils/auth.js` · `otplease` |
| Identity / whoami | `lib/utils/get-identity.js` |
| HTTP: headers, auth header, otp header | `npm-registry-fetch/lib/index.js` · `regFetch`/`getHeaders` |
| HTTP: token resolution from config | `npm-registry-fetch/lib/auth.js` · `getAuth` |
| HTTP: 401/OTP classification, error mapping | `npm-registry-fetch/lib/check-response.js`, `errors.js` |
| Default registry / user-agent | `npm-registry-fetch/lib/default-opts.js` |
| Web login initiate/poll | `npm-profile/lib/index.js` · `webAuth`/`webAuthCheckLogin` |
| Name escaping | `npm-package-arg/lib/npa.js` · `escapedName` |
</content>
