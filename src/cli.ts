#!/usr/bin/env node
//! `npt` — npm Trusted Publishing (OIDC). Run with no subcommand for the menu.

import { Command } from 'commander'

import { t } from './i18n'
import { runMenu } from './menu'
import { runWizard } from './wizard'
import { runScan } from './commands/scan'
import { runSync } from './commands/sync'
import { runProvision } from './provision'
import { runAudit } from './commands/audit'

import type { OptionValues } from 'commander'

const VERSION = '0.2.0'

// Shared option help lines (functions so `t()` runs after language detection).
const ORG_HELP = (): string =>
  t('enumerate this GitHub org/user via the REST API', '通过 REST API 枚举该 GitHub org/用户的仓库')
const DIR_HELP = (): string =>
  t('local directories to scan (repeatable)', '要扫描的本地目录(可多个)')
const WORKFLOW_HELP = (): string =>
  t(
    'override the workflow filename (default: publish.yml)',
    '覆盖 workflow 文件名(默认 publish.yml)',
  )
const LIMIT_HELP = (): string => t('max repos to enumerate', '枚举仓库数量上限')
const ENV_HELP = (): string =>
  t('GitHub environment claim for the binding', '绑定使用的 GitHub environment 声明')

async function main(): Promise<number> {
  const program = new Command()
  let exitCode = 0

  program
    .name('npt')
    .description(
      t(
        'npm Trusted Publishing (OIDC) — run with no subcommand for the interactive menu',
        'npm 可信任发布(OIDC)—— 不带子命令运行进入交互式菜单',
      ),
    )
    .version(VERSION)

  program
    .command('init')
    .description(
      t(
        'One-shot setup wizard for the package in the current directory.',
        '当前目录包的一键配置向导。',
      ),
    )
    .option('--dir <path>', t('package directory', '包目录'), '.')
    .option('--workflow <file>', WORKFLOW_HELP())
    .option('--environment <name>', ENV_HELP())
    .option(
      '--dry-run',
      t(
        'no registry writes or publishes; local files still written',
        '不写 registry、不发布;本地文件仍会写入',
      ),
      false,
    )
    .action(async (opts: OptionValues) => {
      await runWizard({
        dir: opts.dir,
        workflow: opts.workflow,
        environment: opts.environment,
        dryRun: opts.dryRun,
      })
    })

  program
    .command('provision')
    .description(
      t(
        'Batch-reserve a primary package and/or its platform sub-packages, then bind them all to one repository. No local package or directory required.',
        '批量占位发布主包 / 跨平台子包,并统一绑定到同一个仓库。无需本地包或目录。',
      ),
    )
    .option('--workflow <file>', WORKFLOW_HELP())
    .option('--environment <name>', ENV_HELP())
    .option(
      '--dry-run',
      t('plan the names only; publish nothing', '只推演包名清单,不发布、不绑定'),
      false,
    )
    .action(async (opts: OptionValues) => {
      await runProvision({
        workflow: opts.workflow,
        environment: opts.environment,
        dryRun: opts.dryRun,
      })
    })

  program
    .command('scan')
    .description(
      t(
        'Read-only inventory: package existence + current trust binding vs. target.',
        '只读清单:包是否存在 + 当前绑定与目标的对比。',
      ),
    )
    .option('--org <owner>', ORG_HELP())
    .option('--dir <path...>', DIR_HELP(), [])
    .option('--workflow <file>', WORKFLOW_HELP())
    .option('--environment <name>', ENV_HELP())
    .option('--limit <n>', LIMIT_HELP(), parseIntArg, 200)
    .action(async (opts: OptionValues) => {
      await runScan({
        org: opts.org,
        dir: opts.dir,
        workflow: opts.workflow,
        environment: opts.environment,
        limit: opts.limit,
      })
    })

  program
    .command('sync')
    .description(
      t(
        'Reconcile bindings toward the desired state (create/revoke, first-publish).',
        '将绑定调整到目标状态(创建/撤销、首发)。',
      ),
    )
    .option('--org <owner>', ORG_HELP())
    .option('--dir <path...>', DIR_HELP(), [])
    .option('--workflow <file>', WORKFLOW_HELP())
    .option(
      '--dry-run',
      t('print planned actions without applying them', '只打印计划,不实际执行'),
      false,
    )
    .option(
      '--yes',
      t('skip confirmations (still prompts for OTP)', '跳过确认(仍会提示 OTP)'),
      false,
    )
    .option(
      '--placeholder',
      t('publish a placeholder for unpublished packages', '为未发布的包发布占位版本'),
      false,
    )
    .option('--no-publish', t('do not first-publish unpublished packages', '不对未发布的包做首发'))
    .option('--environment <name>', ENV_HELP())
    .option('--limit <n>', LIMIT_HELP(), parseIntArg, 200)
    .action(async (opts: OptionValues) => {
      const noPublish = opts.publish === false
      if (opts.placeholder && noPublish) {
        throw new Error('--placeholder cannot be combined with --no-publish')
      }
      await runSync({
        org: opts.org,
        dir: opts.dir,
        workflow: opts.workflow,
        environment: opts.environment,
        dryRun: opts.dryRun,
        yes: opts.yes,
        placeholder: opts.placeholder,
        noPublish,
        limit: opts.limit,
      })
    })

  program
    .command('audit')
    .description(
      t(
        'CI-friendly drift check (exit != 0 on drift).',
        '面向 CI 的漂移检查(有漂移时退出码非 0)。',
      ),
    )
    .option('--org <owner>', ORG_HELP())
    .option('--dir <path...>', DIR_HELP(), [])
    .option('--workflow <file>', WORKFLOW_HELP())
    .option('--json', t('emit JSON', '输出 JSON'), false)
    .option('--environment <name>', ENV_HELP())
    .option('--limit <n>', LIMIT_HELP(), parseIntArg, 200)
    .action(async (opts: OptionValues) => {
      exitCode = await runAudit({
        org: opts.org,
        dir: opts.dir,
        workflow: opts.workflow,
        environment: opts.environment,
        json: opts.json,
        limit: opts.limit,
      })
    })

  // No subcommand → interactive menu.
  program.action(async () => {
    await runMenu()
  })

  await program.parseAsync(process.argv)
  return exitCode
}

function parseIntArg(value: string): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) throw new Error(`expected an integer, got "${value}"`)
  return n
}

// Ctrl+C outside of an interactive prompt.
process.on('SIGINT', () => {
  process.stderr.write('\n' + t('Cancelled.', '已取消。') + '\n')
  process.exit(130)
})

try {
  const code = await main()
  // Piped stdout flushes asynchronously (notably on Windows); exit only after
  // the buffer reaches the OS so `npt audit --json | …` never loses output.
  process.stdout.write('', () => process.exit(code))
} catch (error) {
  // Ctrl+C during an @inquirer prompt rejects with ExitPromptError.
  if (
    error &&
    typeof error === 'object' &&
    (error as { name?: string }).name === 'ExitPromptError'
  ) {
    process.stderr.write('\n' + t('Cancelled.', '已取消。') + '\n')
    process.exit(130)
  }
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}
