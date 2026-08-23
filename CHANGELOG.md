# Changelog 更新日志

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/lang/zh-CN/).

本文记录项目的主要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

- Distribution no longer ships platform binaries. The package is pure ESM and runs on Node.js >= 18. 不再分发平台二进制，改为纯 ESM 包，要求 Node.js 18 及以上。
