# Changelog 更新日志

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/lang/zh-CN/).

本文记录项目的主要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.0]

### Fixed 修复

- An OTP challenge on a trust _read_ is no longer swallowed. The registry demands 2FA to read `GET /-/package/<pkg>/trust`, not only to write it, so `OtpRequiredError` and `UnauthorizedError` were the ordinary outcome of `assess()` — and both were caught silently, leaving every package `unknown` with nothing printed to say why. 读取绑定时的 OTP 挑战不再被静默吞掉。registry 读取 `GET /-/package/<pkg>/trust` 同样需要 2FA，并非只有写才需要，因此 `OtpRequiredError` 与 `UnauthorizedError` 本就是 `assess()` 的常态结果，而这两类错误此前一个字都不打印，导致所有包停在 `unknown` 却看不出原因。
- `audit` counted `unknown` as clean and exited 0. Since reads are normally unreadable, that turned the drift check into an unconditional pass — it reported "all expected bindings match" for packages that had no binding at all. `audit` 此前把 `unknown` 当作一致并以 0 退出；由于读取本就通常失败，这让漂移检查变成无条件通过 —— 对根本没有任何绑定的包也会报告「所有期望的绑定均一致」。
- `sync` planned no actions for `unknown` and then printed "all packages already in the desired state". It now names the unreadable packages and exits non-zero rather than claiming success for work it never considered. `sync` 对 `unknown` 不生成任何 action，却仍打印「所有包均已处于目标状态」；现在改为列出读不出来的包并以非零码退出，不再为从未考虑过的工作宣告成功。
- Trust reads are spaced like writes. Only writes were throttled, so scanning a handful of packages spent the rate-limit budget on reads and the run 429'd before a single write went out. npm publishes no numeric limit, but `npm trust` advises roughly 2s between commands. 读取与写入一样加了间隔。此前只有写被限速，扫描少量包就会把限流配额耗在读上，导致第一个写请求发出前整轮就 429。npm 未公开具体限流数值，但 `npm trust` 文档建议命令之间间隔约 2 秒。

### Added 新增

- `NPM_OTP` supplies a one-time password without a terminal. `promptOtp()` requires a TTY, which made every trust operation impossible where there is none — CI, an agent shell, a piped invocation. `Writer` seeds from it too. `NPM_OTP` 环境变量可在无终端环境下提供一次性密码。`promptOtp()` 强制要求 TTY，导致 CI、agent shell、管道调用等场景根本无法执行任何 trust 操作。`Writer` 也会从中取值。
- `assess()` accepts an optional `TrustReader`. `sync` passes its `Writer`, so a single OTP covers the reads and the writes that follow, inside the registry's ~5-minute window. `assess()` 新增可选的 `TrustReader` 参数；`sync` 传入自己的 `Writer`，使一次 OTP 同时覆盖读取与随后的写入，落在 registry 约 5 分钟的窗口内。

### Changed 变更

- `runSync` returns an exit code and the CLI propagates it. `runSync` 改为返回退出码，由 CLI 透传。
- The hardcoded version constants in `cli.ts`, `engine.ts`, and `registry/client.ts` were still on `0.2.0` at the `0.2.1` release; all three now track the package version. `cli.ts`、`engine.ts`、`registry/client.ts` 中硬编码的版本常量在 0.2.1 发布时仍停留在 `0.2.0`，现已与包版本同步。

## [0.2.1]

### Changed 变更

- The short `<os>-<arch>` vocabulary now spells x86-64 as `x64` instead of `amd64` — `@scope/native-win-x64`, `@scope/native-mac-x64`. `amd64` stays in the Go vocabulary, where it is the convention. 简写词表的 x86-64 改用 `x64` 而非 `amd64`，如 `@scope/native-win-x64`、`@scope/native-mac-x64`；Go 词表仍用 `amd64`，那是它的惯例。

## [0.2.0]

### Added 新增

- `npt provision` (also in the menu): batch-reserve a primary package and / or its per-platform sub-packages under names that do not exist yet, then bind them all to one repository with a single OTP. Nothing needs to exist locally — no package directory and no checkout; each placeholder is generated in a temp directory, published, and removed. Sub-package names are derived from the primary name (`@scope/native-<os>-<arch>` by default, or the primary name as prefix, or a hand-entered one) in a choice of `<os>-<arch>` vocabularies — Node (`win32-x64`), Go (`windows-amd64`), or short (`win-x64`). `npt provision`（菜单中同样可选）：为尚不存在的包名批量占位发布主包和 / 或跨平台子包，并统一绑定到同一个仓库，整批一次 OTP。全程无需本地包目录或 clone，占位包在临时目录生成、发布完即删。子包名从主包名推导（默认 `@scope/native-<os>-<arch>`，也可沿用主包名做前缀或手动输入），`<os>-<arch>` 词表可选 Node（`win32-x64`）、Go（`windows-amd64`）或简写（`win-x64`）。

## [0.1.0]

First public release. An earlier Rust implementation lived in this repository (planned for npm as `@qwqojs/npt`, wrapping platform binaries) but was never published; it has been rewritten from scratch in TypeScript and ships as `@qwqo/npm-trust`.

首个公开版本。仓库中曾有一版 Rust 实现（计划以 `@qwqojs/npt` 分发，包装多平台二进制），但从未发布到 npm；本版本为 TypeScript 完全重写，以 `@qwqo/npm-trust` 发布。

### Added 新增

- Native TypeScript client for the npm trust API, published as the library entry — no `npm` CLI version requirement and no `gh` CLI dependency. 原生 TypeScript 实现的 npm trust API 客户端，作为库入口发布，不要求特定 npm 版本，也不依赖 `gh` CLI。
- Interactive menu covering status, wizard, bind / revoke, CI template, and batch setup. 交互式菜单，覆盖状态查看、向导、绑定与撤销、CI 模板生成和批量配置。
- `npt init` / `scan` / `audit` / `sync` subcommands, with `audit` exiting non-zero on drift for CI use. `npt init` / `scan` / `audit` / `sync` 四个子命令，其中 `audit` 检测到漂移时以非零码退出，便于接入 CI。
- Batch setup: scan a directory, multi-select packages, and reuse a single OTP across the run. 批量配置：扫描目录后多选包，整批复用一次 OTP。
- First-publish asks for the OTP up front and passes `--otp` to `npm publish`, so 2FA stays in the terminal instead of opening a browser; the same code is reused for the trust write that follows. 首发前先问 OTP 并以 `--otp` 传给 `npm publish`，2FA 全程留在终端而不打开浏览器，随后的信任写操作复用同一个验证码。
- Bilingual UI (English / 中文), auto-detected from the locale, overridable with `NPT_LANG`. 中英双语界面，按系统语言自动切换，可用 `NPT_LANG` 指定。
- `docs/api.md` — the reverse-engineered npm trust HTTP API contract, with source citations. `docs/api.md`：逆向整理的 npm trust HTTP API 契约，附源码出处。

### Changed 变更

- Releases are triggered by pushing a `v*` tag. The job refuses to publish unless the tag matches `package.json`, and creates the GitHub Release itself after a successful publish. 发版改为推送 `v*` tag 触发；tag 与 `package.json` 版本不一致时拒绝发布，发布成功后自动创建 GitHub Release。
- `package-lock.json` resolves everything to `registry.npmjs.org`; a mirror's URLs had been baked in, which npm >= 12 refuses to install (`EALLOWREMOTE`). `scripts/check-lockfile.mjs` guards it in CI. `package-lock.json` 全部解析到 `registry.npmjs.org`；此前混入了镜像地址，npm 12 及以上会拒绝安装（`EALLOWREMOTE`），现由 `scripts/check-lockfile.mjs` 在 CI 中把关。
- `allowScripts` records `unrs-resolver` as denied: npm >= 12 blocks dependency install scripts by default, and that postinstall only repairs a napi binary `optionalDependencies` already installs. `allowScripts` 中将 `unrs-resolver` 记为拒绝：npm 12 起默认拦截依赖安装脚本，而它的 postinstall 只是补装 `optionalDependencies` 本就装好的 napi 二进制。
- `.gitattributes` checks out LF everywhere, so `prettier --check` no longer fails on Windows clones. `.gitattributes` 统一以 LF 签出，Windows 上克隆后 `prettier --check` 不再失败。

- Distribution no longer ships platform binaries. The package is pure ESM and runs on Node.js >= 18. 不再分发平台二进制，改为纯 ESM 包，要求 Node.js 18 及以上。
