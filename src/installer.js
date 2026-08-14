import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DEFAULT_TIMEOUT_MS } from './constants.js'
import { dshCommand } from './compatibility.js'
import { diffLines } from './diff.js'
import { doctorPlugin } from './doctor.js'
import { acquireSource, inferRegistry } from './source.js'
import { loadConfig } from './config.js'
import { runDsh, sanitizedRuntimeEnv, startWeb } from './isolation.js'
import { backupDirectory, pathExists, redact, resolveDshHome, restoreDirectory, splitCommand, validateProfileName } from './utils.js'

export async function installPlugin(spec, options = {}) {
  const profile = validateProfileName(options.profile ?? 'web')
  const report = await doctorPlugin(spec, options)
  if (report.status !== 'pass') return { status: 'blocked', report }

  const config = await loadConfig(options.config)
  const source = await acquireSource(spec, { timeoutMs: options.timeoutMs, registry: inferRegistry(spec, config) })
  try {
    const home = resolveDshHome(options.home)
    const profileDir = join(home, 'profiles', profile)
    const backupRoot = join(home, '.plugin-doctor', 'backups', profile)
    const commandSpec = dshCommand('current', options.dshCommand ? splitCommand(options.dshCommand) : undefined)
    const installEnv = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
    const runtimeEnv = { ...sanitizedRuntimeEnv(process.env), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const before = await runDsh(commandSpec, ['--profile', profile, '--dump-config'], { env: runtimeEnv, timeoutMs })
    const backup = await backupDirectory(profileDir, backupRoot, source.manifest.name ?? 'plugin')
    const args = ['plugin', '--profile', profile, 'add', source.installSpec]
    if (!options.allowScripts) args.push('--ignore-scripts')
    if (source.registry) args.push('--registry', source.registry)
    const install = await runDsh(commandSpec, args, { env: installEnv, timeoutMs: Math.max(timeoutMs, 120_000) })
    const after = install.code === 0
      ? await runDsh(commandSpec, ['--profile', profile, '--dump-config'], { env: runtimeEnv, timeoutMs })
      : undefined
    let startup
    if (after?.code === 0 && profile === 'web') startup = await startWeb(commandSpec, runtimeEnv, timeoutMs)
    const success = install.code === 0 && after?.code === 0 && (profile !== 'web' || startup?.ready)
    if (!success) {
      const failedCopy = await restoreDirectory(backup, profileDir)
      return {
        status: 'rolled-back', report, backup, failedCopy,
        install: sanitize(install), config: sanitize(after), startup,
        message: 'Installation or startup validation failed; the original Profile was restored automatically.',
      }
    }
    return {
      status: 'installed', report, backup,
      install: sanitize(install), startup,
      configDiff: diffLines(before.stdout, after.stdout),
      message: `Installed ${source.manifest.name}@${source.manifest.version} into Profile ${profile}.`,
    }
  } finally {
    await source.cleanup()
  }
}

function sanitize(value) {
  if (!value) return value
  return { ...value, command: value.command?.map(redact), stdout: redact(value.stdout), stderr: redact(value.stderr) }
}

export async function rollbackProfile(options = {}) {
  const profile = validateProfileName(options.profile ?? 'web')
  const home = resolveDshHome(options.home)
  const profileDir = join(home, 'profiles', profile)
  const backupRoot = join(home, '.plugin-doctor', 'backups', profile)
  let backup = options.backup ? resolve(options.backup) : undefined
  if (!backup) {
    if (!(await pathExists(backupRoot))) throw new Error(`No backups found for Profile ${profile}`)
    const entries = (await readdir(backupRoot, { withFileTypes: true }))
      .filter(item => item.isDirectory()).map(item => item.name).sort().reverse()
    if (!entries.length) throw new Error(`No backups found for Profile ${profile}`)
    backup = join(backupRoot, entries[0])
  }
  if (!(await pathExists(join(backup, 'backup.json')))) throw new Error(`Invalid Doctor backup: ${backup}`)
  const failedCopy = await restoreDirectory(backup, profileDir)
  return { status: 'restored', profile, backup, failedCopy }
}
