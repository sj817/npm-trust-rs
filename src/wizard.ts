//! One-shot Trusted Publishing setup wizard for the package in a directory.

import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { t } from './i18n'
import * as color from './color'
import { PkgJson } from './pkgjson'
import { repoExists } from './github'
import { errMsg } from './commands/util'
import { validateOwnerRepo } from './discover'
import { githubPublishWorkflow } from './templates'
import { confirm, promptOtpOptional, promptValidated } from './prompts'
import { DEFAULT_REGISTRY, githubTrust, Permission } from './registry/index'
import {
  bindingRepo,
  DEFAULT_WORKFLOW,
  describeBinding,
  npmCommand,
  resolveClient,
  validateWorkflowFile,
  Writer,
} from './engine'

import type { TrustConfig } from './registry/index'

export interface WizardArgs {
  dir: string
  dryRun: boolean
  environment?: string
  workflow?: string
}

export function defaultWizardArgs(): WizardArgs {
  return { dir: '.', workflow: undefined, environment: undefined, dryRun: false }
}

export function ensureWorkflowFile(dir: string, workflow: string): void {
  const wfPath = path.join(dir, '.github', 'workflows', workflow)
  if (existsSync(wfPath)) {
    console.log(t(`→ workflow file exists: ${wfPath}`, `→ workflow 文件已存在:${wfPath}`))
    return
  }
  mkdirSync(path.dirname(wfPath), { recursive: true })
  writeFileSync(wfPath, githubPublishWorkflow())
  console.log(
    color.ok(t(`✓ created workflow template: ${wfPath}`, `✓ 已创建 workflow 模板:${wfPath}`)),
  )
}

/**
 * Ask for the OTP `npm publish` will need, before the publish runs.
 *
 * npm picks its 2FA path from the registry's EOTP response (npm `lib/utils/auth.js`
 * → `otplease`): when the body carries `authUrl`/`doneUrl` — which registry.npmjs.org
 * always does — it opens a browser, and no npm config switches that off. Supplying
 * `--otp` up front means the challenge never happens, so the flow stays in the
 * terminal. A blank answer keeps npm's own behaviour, for accounts that do not need
 * an OTP to publish; a non-TTY skips the prompt entirely, matching npm's own guard.
 */
export function promptPublishOtp(): Promise<string | undefined> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return Promise.resolve(undefined)
  return promptOtpOptional(
    t(
      'OTP for npm publish (blank: let npm handle 2FA, which opens a browser)',
      'npm publish 用的 OTP(留空则交给 npm 处理 2FA,会打开浏览器)',
    ),
  )
}

/** Publish a minimal placeholder to reserve the package name. */
export function publishPlaceholder(name: string, otp?: string): void {
  const slug = name.replaceAll(/[@/]/g, '-')
  const tmp = path.join(tmpdir(), `npt-placeholder-${slug}-${process.pid}`)
  mkdirSync(tmp, { recursive: true })

  const pkg = {
    name,
    version: '0.0.1',
    description: 'Placeholder release to reserve the package name for Trusted Publishing.',
    license: 'MIT',
  }
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  writeFileSync(
    path.join(tmp, 'README.md'),
    `# ${name}\n\nPlaceholder release. Real content is published via CI (OIDC).\n`,
  )

  console.log(
    t(
      `→ publishing placeholder ${name}@0.0.1 (npm will prompt for OTP if needed)…`,
      `→ 正在发布占位版 ${name}@0.0.1(如需要 npm 会提示输入 OTP)…`,
    ),
  )

  const { cmd, prefix } = npmCommand()
  // Pin the registry: the trust API always talks to npmjs, so the placeholder
  // must land there too even when the local npm config points at a mirror.
  const publishArgs = [...prefix, 'publish', '--registry', DEFAULT_REGISTRY]
  // Scoped packages default to restricted; make the first publish public.
  if (name.startsWith('@')) publishArgs.push('--access', 'public')
  if (otp) publishArgs.push(`--otp=${otp}`)

  const res = spawnSync(cmd, publishArgs, { cwd: tmp, stdio: 'inherit' })
  rmSync(tmp, { recursive: true, force: true }) // best-effort cleanup

  if (res.error) throw new Error(`failed to spawn npm publish: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`npm publish failed for placeholder ${name}`)
  console.log(color.ok(t('✓ placeholder published', '✓ 占位版已发布')))
}

export async function runWizard(args: WizardArgs): Promise<void> {
  console.log(
    color.title(
      t('npt — Trusted Publishing setup wizard', 'npt — 可信任发布(Trusted Publishing)配置向导'),
    ),
  )
  console.log()

  if (args.dryRun) {
    console.log(
      color.dim(
        t(
          '(dry run — no registry writes or publishes; local files may still be written)',
          '(演练模式 —— 不做 registry 写入或发布;本地文件仍可能被写入)',
        ),
      ),
    )
  }

  requirePackageDir(args.dir)

  const { client } = await resolveClient(true)
  const writer = new Writer(client)

  const pkg = PkgJson.load(args.dir)
  const name = pkg.name()
  if (!name) throw new Error('package.json has no "name" — set one first')
  console.log(t(`→ package: ${color.accent(name)}`, `→ 包名:${color.accent(name)}`))

  if (pkg.isPrivate()) {
    process.stderr.write(
      color.warn(
        t(
          '⚠ package.json has "private": true — it cannot be published to the public registry.',
          '⚠ package.json 设置了 "private": true —— 无法发布到公共 registry。',
        ),
      ) + '\n',
    )
    if (!(await confirm(t('Continue anyway?', '仍然继续?')))) return
  }

  const published = await client.packageExists(name)
  console.log(
    published
      ? t('→ registry: already published', '→ registry:已发布')
      : t('→ registry: not published yet', '→ registry:尚未发布'),
  )

  const ownerRepo = await ensureRepository(pkg)

  let existing: TrustConfig | undefined
  if (published) {
    const configs = await writer.list(name)
    existing = configs[0]
    if (existing) {
      const desc = describeBinding(existing)
      if (bindingRepo(existing) === ownerRepo) {
        console.log(
          color.ok(
            t(`✓ already bound: ${desc} — nothing to do.`, `✓ 已绑定:${desc} —— 无需操作。`),
          ),
        )
        console.log(
          color.dim(
            t(
              '  (to change repo/workflow, revoke it first, or use the menu.)',
              '  (若要更改 repo/workflow,请先撤销,或使用菜单。)',
            ),
          ),
        )
        return
      }
      process.stderr.write(
        color.warn(
          t(
            `⚠ existing binding points elsewhere (drift): ${desc}`,
            `⚠ 现有绑定指向别处(drift):${desc}`,
          ),
        ) + '\n',
      )
      if (
        !(await confirm(
          t('Rebind to the repository from package.json?', '改绑到 package.json 指定的仓库?'),
        ))
      ) {
        return
      }
    }
  }

  const defaultWf = args.workflow ?? DEFAULT_WORKFLOW
  const workflow = await promptWorkflow(defaultWf)
  ensureWorkflowFile(args.dir, workflow)

  await checkGithubRepo(ownerRepo)

  const desired = githubTrust(ownerRepo, workflow, args.environment, [Permission.Publish])

  if (args.dryRun) {
    console.log(
      t(
        `\n(dry run) would ensure binding: ${describeBinding(desired)}`,
        `\n(演练)将确保绑定:${describeBinding(desired)}`,
      ),
    )
    if (!published) {
      console.log(
        t(
          `(dry run) would first-publish a placeholder version of ${name}`,
          `(演练)将先首发 ${name} 的占位版本`,
        ),
      )
    }
    return
  }

  if (!published) {
    console.log(
      t(
        `\n${name} is not published; a package must exist before it can be bound.`,
        `\n${name} 尚未发布;绑定前包必须已存在。`,
      ),
    )
    if (
      !(await confirm(
        t('Publish a minimal placeholder version now?', '现在发布一个最小占位版本吗?'),
      ))
    ) {
      console.log(
        t(
          'Aborted — publish the package first, then re-run the wizard.',
          '已中止 —— 请先发布该包,再重新运行向导。',
        ),
      )
      return
    }
    const otp = await promptPublishOtp()
    publishPlaceholder(name, otp)
    // The trust write below lands inside the same ~5-minute 2FA window.
    if (otp) writer.setOtp(otp)
  }

  const desiredDesc = describeBinding(desired)
  if (existing) {
    if (!existing.id) throw new Error(`registry returned a trust config without an id for ${name}`)
    await writer.revoke(name, existing.id)
    await writer.create(name, desired)
    console.log(color.ok(t(`✓ binding updated: ${desiredDesc}`, `✓ 绑定已更新:${desiredDesc}`)))
  } else {
    console.log(t(`desired binding: ${desiredDesc}`, `目标绑定:${desiredDesc}`))
    if (!(await confirm(t('Create this trusted-publisher binding?', '创建这个可信任发布绑定?'))))
      return
    await writer.create(name, desired)
    console.log(color.ok(t(`✓ binding created: ${desiredDesc}`, `✓ 绑定已创建:${desiredDesc}`)))
  }

  printNextSteps(ownerRepo, workflow)
}

async function checkGithubRepo(ownerRepo: string): Promise<void> {
  let exists: boolean
  try {
    exists = await repoExists(ownerRepo)
  } catch (error) {
    const msg = errMsg(error)
    process.stderr.write(
      color.warn(t(`⚠ could not verify GitHub repo: ${msg}`, `⚠ 无法验证 GitHub 仓库:${msg}`)) +
        '\n',
    )
    if (!(await confirm(t('Continue anyway?', '仍然继续?')))) throw new Error('cancelled')
    return
  }
  if (exists) {
    console.log(t(`→ GitHub: ${ownerRepo} exists`, `→ GitHub:${ownerRepo} 存在`))
    return
  }
  process.stderr.write(
    color.warn(
      t(
        `⚠ GitHub repo ${ownerRepo} does not exist (or is not visible). Trusted publishing will fail until the repo exists and the workflow runs there.`,
        `⚠ GitHub 仓库 ${ownerRepo} 不存在(或不可见)。在仓库存在并运行该 workflow 之前,可信发布会失败。`,
      ),
    ) + '\n',
  )
  if (!(await confirm(t('Continue setting up the binding anyway?', '仍然继续设置绑定?')))) {
    throw new Error('cancelled')
  }
}

async function ensureRepository(pkg: PkgJson): Promise<string> {
  const existing = pkg.repositoryOwnerRepo()
  if (existing) {
    console.log(
      t(
        `→ repository (from package.json): ${color.accent(existing)}`,
        `→ 仓库(来自 package.json):${color.accent(existing)}`,
      ),
    )
    return existing
  }
  process.stderr.write(
    color.warn(
      t(
        'package.json has no valid GitHub repository field.',
        'package.json 没有有效的 GitHub repository 字段。',
      ),
    ) + '\n',
  )
  const ownerRepo = await promptValidated(
    t('GitHub repository (owner/repo)', 'GitHub 仓库(owner/repo)'),
    undefined,
    validateOwnerRepo,
  )
  pkg.setRepository(ownerRepo)
  pkg.save()
  console.log(
    color.ok(
      t(
        `✓ wrote repository to ${pkg.path} → ${ownerRepo}`,
        `✓ 已写入 repository 到 ${pkg.path} → ${ownerRepo}`,
      ),
    ),
  )
  return ownerRepo
}

function printNextSteps(ownerRepo: string, workflow: string): void {
  console.log(color.title(t('\nDone. Next step:', '\n完成。下一步:')))
  console.log(
    t(
      `  Commit .github/workflows/${workflow}, push it to ${ownerRepo}'s default branch,\n  then publish by creating a GitHub Release — CI will publish via OIDC (no token).`,
      `  提交 .github/workflows/${workflow},推送到 ${ownerRepo} 的默认分支,\n  然后通过创建 GitHub Release 发布 —— CI 会用 OIDC 发布(无需 token)。`,
    ),
  )
}

function promptWorkflow(dflt: string): Promise<string> {
  return promptValidated(
    t('CI workflow filename', 'CI workflow 文件名'),
    dflt,
    validateWorkflowFile,
  )
}

function requirePackageDir(dir: string): void {
  if (existsSync(path.join(dir, 'package.json'))) return
  const abs = path.resolve(dir)
  process.stderr.write(
    color.err(
      t(
        `✗ Not an npm package — no package.json in this directory.\n  here: ${abs}\n  → cd into your package directory and re-run, or pass --dir <path>.`,
        `✗ 这不是一个 npm 包 —— 当前目录没有 package.json。\n  当前:${abs}\n  → 请进入你的包目录后重新运行,或用 --dir <path> 指定。`,
      ),
    ) + '\n',
  )
  process.exit(2)
}
