# npt — npm Trusted Publishing (OIDC) manager

[![CI](https://github.com/sj817/npm-trust/actions/workflows/ci.yml/badge.svg)](https://github.com/sj817/npm-trust/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@qwqo/npm-trust.svg)](https://www.npmjs.com/package/@qwqo/npm-trust)
[![node](https://img.shields.io/node/v/@qwqo/npm-trust.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#license-许可)

`npt` sets up and manages npm Trusted Publishing (OIDC / provenance) bindings: an interactive wizard, batch tools, and a native TypeScript client for the npm registry trust API. Pure ESM, zero config files, no `gh` CLI required.

`npt` 用于配置和管理 npm 可信任发布（Trusted Publishing，OIDC / provenance）绑定，提供交互式向导、批量工具，以及原生 TypeScript 实现的 npm registry trust API 客户端。纯 ESM，无配置文件，不依赖 `gh` CLI。

## Install 安装

```sh
npx @qwqo/npm-trust             # run directly 直接运行
npm i -g @qwqo/npm-trust        # or install the `npt` command 或全局安装 npt 命令
```

Requires Node.js >= 18. UI is bilingual (English / 中文), auto-detected from the locale; override with `NPT_LANG=zh|en`.

要求 Node.js 18 及以上。界面按系统语言自动切换中英文，也可以用 `NPT_LANG=zh|en` 指定。

## Usage 使用

Run `npt` with no arguments for the interactive menu — status, wizard, bind / revoke, CI template, and batch setup. Or use the subcommands directly:

不带参数运行 `npt` 进入交互式菜单，覆盖状态查看、向导、绑定与撤销、CI 模板生成和批量配置。也可以直接使用子命令：

| Command     | Description                                         | 说明                            |
| ----------- | --------------------------------------------------- | ------------------------------- |
| `npt init`  | One-shot setup wizard for the current directory     | 当前目录包的一键配置向导        |
| `npt scan`  | Read-only inventory: existence + binding vs. target | 只读清单，对比当前绑定与目标    |
| `npt audit` | CI drift check, non-zero exit on drift              | CI 漂移检查，有漂移时退出码非 0 |
| `npt sync`  | Reconcile bindings: create / revoke, first-publish  | 纠偏，创建或撤销绑定、首发      |

Common flags 常用参数: `--dir <path...>`, `--org <owner>`, `--workflow <file>` (default `publish.yml`), `--environment <name>`. See `npt <cmd> --help`.

The wizard derives the `github:<owner/repo>@<workflow>` binding from `package.json`, scaffolds the CI workflow, first-publishes a placeholder when the name is still unused, then creates the trust binding. Batch mode scans a directory, lets packages be multi-selected, and reuses one OTP across the whole batch (npm's 2FA window lasts about 5 minutes).

向导从 `package.json` 推导 `github:<owner/repo>@<workflow>` 绑定，生成 CI workflow 模板；包名未被占用时先发布占位版本，再创建信任绑定。批量模式扫描目录后勾选多个包一次性配置，整批只需输入一次 OTP（npm 的 2FA 窗口约 5 分钟）。

GitHub scanning (`--org`) and repo checks use the anonymous GitHub REST API. Set `GITHUB_TOKEN` (or `GH_TOKEN`) to raise the rate limit and see private repos.

GitHub 扫描（`--org`）与仓库检查走匿名 GitHub REST API。设置 `GITHUB_TOKEN`（或 `GH_TOKEN`）可提高限额并访问私有仓库。

## Relation to `npm trust` 与内置 `npm trust` 的关系

npm 11.15 ships a built-in `npm trust` (`github` / `gitlab` / `circleci` / `list` / `revoke`). It covers one package at a time, from explicit flags. If that is all that is needed, use it — it is the official client and `npt` talks to the same endpoints.

npm 11.15 起内置了 `npm trust`（`github` / `gitlab` / `circleci` / `list` / `revoke`），按显式参数一次处理一个包。如果需求就到这里，直接用它即可——那是官方客户端，`npt` 调用的也是同一批接口。

`npt` adds the parts around it:

`npt` 补的是它周围的部分：

|                                                                                          | `npm trust` | `npt`                     |
| ---------------------------------------------------------------------------------------- | ----------- | ------------------------- |
| Derive the binding from `package.json` 从 `package.json` 推导绑定                        | —           | ✓                         |
| Scaffold the CI workflow 生成 CI workflow                                                | —           | ✓                         |
| First-publish a placeholder for an unused name 为未占用的包名首发占位                    | —           | ✓                         |
| Drift detection across many packages, non-zero exit for CI 多包漂移检查，CI 可用的退出码 | —           | `scan` / `audit` / `sync` |
| One OTP across a whole batch 整批复用一次 OTP                                            | —           | ✓                         |
| Keep 2FA in the terminal on publish 发布时 2FA 留在终端                                  | —           | ✓                         |
| Requires a recent npm 对 npm 版本有要求                                                  | >= 11.15    | any 任意版本              |
| Usable as a library 可作为库调用                                                         | —           | `exports["."]`            |

The trust HTTP contract `npt` implements is byte-identical between npm 11.16.0 and 12.0.2 — every file under `lib/commands/trust/` has the same SHA at both tags. See `docs/api.md`.

`npt` 实现的 trust HTTP 契约在 npm 11.16.0 与 12.0.2 之间完全一致——`lib/commands/trust/` 下每个文件在两个 tag 上的 SHA 都相同，详见 `docs/api.md`。

## Authentication 认证

`npt` reuses existing npm credentials — the `//registry.npmjs.org/:_authToken` line in the user `.npmrc` (`${VAR}` is expanded), or the `NPM_TOKEN` environment variable. Trust writes require account-level 2FA: `npt` prompts for an OTP when the registry challenges and reuses it across a batch. Read-only `scan` / `audit` never prompt.

`npt` 直接复用现有 npm 凭据：用户 `.npmrc` 中的 `//registry.npmjs.org/:_authToken`（支持 `${VAR}` 展开），或环境变量 `NPM_TOKEN`。信任配置的写操作要求账户级 2FA，registry 发起质询时会提示输入 OTP，并在批量操作中复用；只读的 `scan` / `audit` 不会提示。

## How it works 发布原理

The wizard scaffolds `.github/workflows/publish.yml` — a GitHub Actions job with `id-token: write` that runs `npm publish` with no token. Once the trust binding exists on npm and that workflow runs on the repo's default branch, releases publish tokenlessly via OIDC. This repo publishes itself the same way.

向导生成的 `.github/workflows/publish.yml` 是一个带 `id-token: write` 权限的 GitHub Actions 任务，不带 token 执行 `npm publish`。只要 npm 上的信任绑定存在、且该 workflow 在仓库默认分支上运行，发布就通过 OIDC 免 token 完成。本仓库自身也用这种方式发布。

Two caveats 两点注意:

- A package must exist on the registry before a binding can be created (hence the placeholder first-publish), and npm allows one trust config per package — changing it means revoke + create. 创建绑定前包必须已存在于 registry（所以需要占位首发）；npm 每个包只允许一条信任配置，修改等于撤销后重建。
- Trusted publishing takes effect only after the bound workflow actually runs on the repo; until then publishes still need a token. 可信任发布要等被绑定的 workflow 真正运行后才生效，在那之前发布仍需 token。

## Development 开发

| Path            | Content 内容                                                         |
| --------------- | -------------------------------------------------------------------- |
| `src/registry/` | Native npm trust API client 原生 trust API 客户端                    |
| `src/`          | CLI: wizard, menu, scan / audit / sync CLI 主体                      |
| `docs/api.md`   | Reverse-engineered npm trust HTTP API 逆向整理的 trust HTTP API 契约 |
| `test/`         | Vitest suite with a loopback wire-contract test 含回环协议契约测试   |

`npm run build` (tsdown) / `npm test` (Vitest) / `npm run typecheck` / `npm run lint` / `npm run format`.

Setup, conventions, and what CI checks: [CONTRIBUTING.md](CONTRIBUTING.md). Release notes: [CHANGELOG.md](CHANGELOG.md). Reporting a vulnerability: [SECURITY.md](SECURITY.md). Community expectations: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

环境搭建、约定和 CI 检查项见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变更见 [CHANGELOG.md](CHANGELOG.md)，安全问题上报见 [SECURITY.md](SECURITY.md)，社区行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## License 许可

Dual-licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.

采用 [MIT](LICENSE-MIT) 与 [Apache-2.0](LICENSE-APACHE) 双许可，二者任选其一。
