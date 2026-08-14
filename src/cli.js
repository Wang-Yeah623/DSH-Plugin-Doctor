#!/usr/bin/env node
import { Command } from 'commander'
import { doctorPlugin } from './doctor.js'
import { installPlugin, rollbackProfile } from './installer.js'
import { TOOL_VERSION } from './constants.js'
import { writeJson } from './utils.js'

function collect(value, previous = []) { return [...previous, value] }

function addDoctorOptions(command) {
  return command
    .option('-c, --config <path>', 'policy, private registry and allowlist configuration')
    .option('-o, --report-dir <path>', 'report output directory', 'reports')
    .option('--dsh-version <version>', 'DSH version to test; repeat for a regression matrix', collect, [])
    .option('--dsh-command <command>', 'explicit DSH command (for source checkouts or wrappers)')
    .option('--timeout <seconds>', 'startup and command timeout', value => Number(value) * 1_000, 30_000)
    .option('--no-isolate', 'skip temporary DSH_HOME install and Web startup')
    .option('--keep-temp', 'keep isolated DSH_HOME directories for diagnosis')
    .option('--allow-scripts', 'allow package lifecycle scripts during installation')
    .option('--allow-permission <permission>', 'acknowledge a permission for this run; repeatable', collect, [])
    .option('--strict', 'block high as well as critical findings')
}

function normalizeOptions(options) {
  return {
    config: options.config,
    reportDir: options.reportDir,
    dshVersions: options.dshVersion,
    dshCommand: options.dshCommand,
    timeoutMs: options.timeout,
    isolate: options.isolate,
    keepTemp: options.keepTemp,
    allowScripts: options.allowScripts,
    allowPermissions: options.allowPermission,
    strict: options.strict,
    profile: options.profile,
    home: options.home,
  }
}

function printReport(report) {
  const icon = report.status === 'pass' ? '✓' : '✗'
  process.stdout.write(`${icon} ${report.plugin.name ?? report.source}: ${report.status.toUpperCase()}\n`)
  process.stdout.write(`  JSON: ${report.artifacts.jsonPath}\n  Markdown: ${report.artifacts.markdownPath}\n  Badge: ${report.artifacts.badgePath}\n`)
  if (report.policy.blockers.length) {
    process.stdout.write('  Blockers:\n')
    for (const blocker of report.policy.blockers) process.stdout.write(`    - ${blocker.reason}\n`)
  }
}

const program = new Command()
program.name('dsh-plugin-doctor').description('Audit, isolate-test and safely install DeepSeek Harness plugin bundles').version(TOOL_VERSION)

addDoctorOptions(program.command('check <plugin>').description('run compatibility, security and isolated startup checks'))
  .action(async (plugin, options) => {
    const report = await doctorPlugin(plugin, normalizeOptions(options))
    printReport(report)
    if (report.status !== 'pass') process.exitCode = 1
  })

addDoctorOptions(program.command('install <plugin>').description('audit, install into a real Profile, verify startup and roll back on failure'))
  .requiredOption('--profile <name>', 'target DSH Profile')
  .option('--home <path>', 'target DSH_HOME (defaults to DSH_HOME or ~/.dsh)')
  .action(async (plugin, options) => {
    const result = await installPlugin(plugin, normalizeOptions(options))
    printReport(result.report)
    process.stdout.write(`${result.message ?? result.status}\n`)
    if (result.backup) process.stdout.write(`Backup: ${result.backup}\n`)
    if (result.status !== 'installed') process.exitCode = 1
  })

program.command('rollback').description('restore a Profile from the latest Doctor backup')
  .requiredOption('--profile <name>', 'Profile to restore')
  .option('--home <path>', 'target DSH_HOME')
  .option('--backup <path>', 'specific backup directory; defaults to latest')
  .action(async options => {
    const result = await rollbackProfile(options)
    process.stdout.write(`Restored Profile ${result.profile} from ${result.backup}\n`)
    process.stdout.write(`Replaced Profile preserved at ${result.failedCopy}\n`)
  })

program.command('init').description('write a team policy and allowlist template')
  .option('-o, --output <path>', 'configuration path', '.dsh-doctor.json')
  .option('--force', 'overwrite an existing file')
  .action(async options => {
    const config = {
      policy: {
        blockSeverities: ['critical'],
        allowedPermissions: [],
        packagePermissions: { '@your-team/*': ['hooks'] },
      },
      allowlist: [
        { package: '@your-team/*', owner: 'platform-team' },
      ],
      registries: {
        '@your-team': 'https://registry.npmjs.org',
      },
    }
    if (!options.force) {
      const { access } = await import('node:fs/promises')
      try { await access(options.output); throw new Error(`${options.output} already exists; use --force to overwrite`) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    await writeJson(options.output, config)
    process.stdout.write(`Wrote ${options.output}\n`)
  })

program.parseAsync().catch(error => {
  process.stderr.write(`dsh-plugin-doctor: ${error.message}\n`)
  process.exitCode = 2
})
