# Changelog 更新日志

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/lang/zh-CN/).

本文记录项目的主要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
