# Security Policy 安全策略

## Supported versions 支持范围

Security fixes land on the latest published release of `@qwqo/npm-trust`. Older versions are not patched.

安全修复只发布在 `@qwqo/npm-trust` 的最新版本上，旧版本不再回补。

## Reporting a vulnerability 上报漏洞

Report privately through GitHub's [private vulnerability reporting](https://github.com/sj817/npm-trust/security/advisories/new). Do not open a public issue for a security problem.

请通过 GitHub 的[私密漏洞上报](https://github.com/sj817/npm-trust/security/advisories/new)提交，不要用公开 issue 报告安全问题。

A useful report includes the affected version, the steps to reproduce, and what an attacker gains. Expect an initial reply within 7 days.

一份可用的报告包含：受影响的版本、复现步骤、攻击者能获得什么。首次回复通常在 7 天内。

Never include a real npm token, OTP code, or session credential in a report. Redact them, or describe their shape instead.

报告中不要附带真实的 npm token、OTP 验证码或会话凭据，请打码或只描述格式。

## Scope 关注范围

This tool reads npm credentials and performs authenticated writes against the registry. The parts most worth scrutiny:

本工具会读取 npm 凭据并对 registry 发起带认证的写操作，以下部分最值得审视：

- **Credential handling** — token lookup in `.npmrc` / `NPM_TOKEN`, `${VAR}` expansion, and anything that could leak a token into logs, error output, or a subprocess argument list. 凭据处理：`.npmrc` 与 `NPM_TOKEN` 的读取、`${VAR}` 展开，以及任何可能把 token 泄漏到日志、错误输出或子进程参数里的路径。
- **OTP reuse** — the batch flow holds one OTP in memory across a run. 批量流程会在一次运行中把单个 OTP 保留在内存里。
- **Binding derivation** — an incorrect `github:<owner/repo>@<workflow>` binding grants publish rights to the wrong workflow. 绑定推导：错误的 `github:<owner/repo>@<workflow>` 会把发布权授予错误的 workflow。
- **Subprocess invocation** — how `npm` is spawned, including the Windows `cmd /C` path. 子进程调用：`npm` 的启动方式，含 Windows 下的 `cmd /C` 路径。
- **Supply chain** — the published tarball, its dependency set, and the OIDC publish workflow. 供应链：发布产物、依赖集合，以及 OIDC 发布流程。

## Out of scope 不在范围内

Vulnerabilities in npm's registry or in GitHub Actions themselves belong to those vendors — report them to [npm](https://www.npmjs.com/support) or [GitHub](https://hackerone.com/github). Findings that require an attacker to already control the machine, the `.npmrc`, or the npm account are not treated as vulnerabilities here.

npm registry 或 GitHub Actions 自身的漏洞属于对应厂商，请报告给 [npm](https://www.npmjs.com/support) 或 [GitHub](https://hackerone.com/github)。需要攻击者已控制本机、`.npmrc` 或 npm 账号才能成立的问题，本项目不按漏洞处理。
