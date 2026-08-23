# Contributing 贡献指南

Thanks for taking the time to contribute. This document covers the setup, the checks CI runs, and the conventions this repo follows.

本文说明本地环境搭建、CI 会跑的检查项，以及本仓库遵循的约定。

## Getting started 环境准备

Requires Node.js >= 18 (CI tests on 18 and 22; lint and format run on 22).

要求 Node.js 18 及以上。CI 在 18 和 22 两个版本上跑测试，lint 与格式检查跑在 22 上。

```sh
git clone https://github.com/sj817/npm-trust.git
cd npm-trust
npm ci
```

## Checks 本地检查

Run these before opening a pull request — they are exactly what CI runs.

提交 PR 前先在本地跑一遍，与 CI 的检查项完全一致：

```sh
npm run typecheck     # tsc --noEmit
npm run build         # tsdown → dist/
npm test              # vitest run
npm run lint          # eslint .
npm run format:check  # prettier --check .
```

`npm run lint:fix` and `npm run format` fix what can be fixed automatically.

`npm run lint:fix` 与 `npm run format` 会自动修复可修复的问题。

## Lockfile 锁文件

`package-lock.json` must resolve every package to `registry.npmjs.org`; CI fails otherwise. Installing behind a mirror bakes that mirror's URLs into every `resolved` entry — npm >= 12 then refuses to install the tree (`EALLOWREMOTE`), and no one else opted into that host. A mirror is fine for a plain `npm install --registry <mirror>`, but regenerate the lockfile against npmjs before committing it.

`package-lock.json` 中每一项都必须解析到 `registry.npmjs.org`，否则 CI 不通过。挂着镜像安装会把镜像地址写进每一条 `resolved`，npm 12 及以上会直接拒绝安装（`EALLOWREMOTE`），而且别人并没有选择那个源。日常用 `npm install --registry <镜像>` 加速没问题，但提交前要用 npmjs 重新生成锁文件。

Dependency install scripts are blocked by default from npm 12 on. The one package in this tree that has one — `unrs-resolver`, a transitive dev dependency — is recorded as denied in the `allowScripts` field: its postinstall only repairs a missing napi binary that `optionalDependencies` already installs correctly, so it is not needed. Do not approve it without a reason.

从 npm 12 起，依赖的安装脚本默认被拦截。本项目依赖树中唯一带安装脚本的 `unrs-resolver`（传递而来的开发依赖）在 `allowScripts` 中记为拒绝：它的 postinstall 只是在 napi 二进制缺失时补装，而 `optionalDependencies` 本来就装好了，因此不需要放行。没有理由不要批准它。

## Layout 目录结构

| Path            | Content 内容                                                        |
| --------------- | ------------------------------------------------------------------- |
| `src/registry/` | npm trust API client, no CLI deps 原生 trust API 客户端，不依赖 CLI |
| `src/`          | CLI: wizard, menu, scan / audit / sync CLI 主体                     |
| `test/`         | Vitest suite 测试                                                   |
| `docs/api.md`   | Reverse-engineered trust HTTP API 逆向整理的 HTTP API 契约          |

`src/registry/` is published as the library entry (`exports["."]`) and must stay free of prompt, color, and `process.exit` code — everything interactive belongs above it.

`src/registry/` 是对外的库入口（`exports["."]`），其中不应出现交互提示、颜色输出和 `process.exit`，交互相关代码放在上层。

## Talking to the registry 与 registry 交互

The trust endpoints are not a public npm API — `docs/api.md` records where each one was extracted from in the npm CLI source. When changing `src/registry/`, update that document and cite the source file, so the contract can be re-verified after an npm upgrade.

trust 相关接口不是 npm 的公开 API，`docs/api.md` 记录了每个接口从 npm CLI 源码的哪个位置提取而来。改动 `src/registry/` 时同步更新该文档并注明来源，npm 升级后才能重新核对契约。

`test/protocol.test.ts` verifies the wire contract against a loopback HTTP server, so protocol changes can be tested without network access or an npm account.

`test/protocol.test.ts` 用回环 HTTP 服务器验证协议契约，改协议不需要联网，也不需要 npm 账号。

Never commit tokens, OTP codes, real package names under someone else's account, or captured responses containing credentials.

不要提交 token、OTP 验证码、他人账号下的真实包名，或包含凭据的抓包响应。

## Commits and pull requests 提交与 PR

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `chore: ...`. Subject lines may be written in English or Chinese.

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/) 格式：`feat(scope): ...`、`fix(scope): ...`、`docs: ...`、`chore: ...`。标题可用中文或英文。

A pull request should keep one concern, include tests for behavior changes, and pass all checks above. Describe what changed and why — a link to the failing case is worth more than a long description.

一个 PR 只处理一件事，行为变化要带测试，并通过上面全部检查。描述改了什么、为什么改，附上可复现的失败用例比长篇说明更有用。

## UI text 界面文案

The CLI is bilingual. New user-facing strings go through `t(en, zh)` in `src/i18n.ts` and need both languages; error messages stay in English so they are searchable.

CLI 界面是中英双语。新增的用户可见文案统一走 `src/i18n.ts` 的 `t(en, zh)`，两种语言都要给；错误信息保持英文，便于检索。

## Releases 发布

Maintainers only. Publishing runs through GitHub Actions with npm Trusted Publishing (OIDC), triggered by a published GitHub Release. There is no npm token in CI, and no manual `npm publish` from a laptop.

仅维护者操作。发布由 GitHub Release 触发 GitHub Actions，通过 npm 可信任发布（OIDC）完成。CI 中没有 npm token，也不从本地手动执行 `npm publish`。

## License 许可

Contributions are dual-licensed under MIT OR Apache-2.0, matching the project.

贡献内容采用与项目一致的 MIT OR Apache-2.0 双许可。
