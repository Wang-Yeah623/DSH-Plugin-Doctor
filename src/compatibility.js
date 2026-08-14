import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import semver from 'semver'
import { commandExists, run } from './utils.js'

function check(id, level, message, details) { return { id, level, message, details } }

export function nodeCompatibility(manifest) {
  const range = manifest.engines?.node
  if (!range) return check('runtime.node', 'warning', `Plugin declares no engines.node; current Node is ${process.version}`)
  if (!semver.validRange(range)) return check('runtime.node', 'error', `Invalid engines.node range: ${range}`)
  const ok = semver.satisfies(process.versions.node, range, { includePrerelease: true })
  return check('runtime.node', ok ? 'pass' : 'error', `Node ${process.version} ${ok ? 'satisfies' : 'does not satisfy'} ${range}`)
}

export function dshCommand(version, explicit) {
  if (explicit) {
    const [command, ...prefix] = explicit
    return { command, prefix, label: explicit.join(' ') }
  }
  if (version && version !== 'current') {
    return { command: 'npx', prefix: ['--yes', '--package', `@deepseek-ai/dsh@${version}`, 'dsh'], label: `@deepseek-ai/dsh@${version}` }
  }
  return { command: 'dsh', prefix: [], label: 'dsh on PATH' }
}

export async function probeDsh(commandSpec, env, timeoutMs = 20_000) {
  if (!commandExists(commandSpec.command)) {
    return { check: check('runtime.dsh', 'error', `${commandSpec.command} is not available on PATH`), version: undefined }
  }
  const output = await run(commandSpec.command, [...commandSpec.prefix, '--version'], { env, timeoutMs })
  const versionText = `${output.stdout}\n${output.stderr}`.match(/\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/)?.[0]
  const version = versionText ? semver.clean(versionText) ?? undefined : undefined
  return {
    check: check('runtime.dsh', output.code === 0 ? 'pass' : 'error',
      output.code === 0 ? `DSH ${version ?? 'version unknown'} is executable` : `DSH version probe failed`, output),
    version,
  }
}

export function checkDeclaredDsh(manifest, installedVersion) {
  const range = manifest.engines?.dsh ?? manifest.peerDependencies?.['@deepseek-ai/dsh'] ?? manifest.dsh?.compatibility?.dsh
  if (!range) return check('compat.dsh-range', 'warning', 'Plugin declares no DSH compatibility range')
  if (!semver.validRange(range)) return check('compat.dsh-range', 'error', `Invalid DSH compatibility range: ${range}`)
  if (!installedVersion) return check('compat.dsh-range', 'warning', `Declared DSH range ${range} could not be compared because DSH version is unknown`)
  const ok = semver.satisfies(installedVersion, range, { includePrerelease: true })
  return check('compat.dsh-range', ok ? 'pass' : 'error', `DSH ${installedVersion} ${ok ? 'satisfies' : 'does not satisfy'} ${range}`)
}

export async function checkInstalledPeers(profileDir, manifest) {
  const checks = []
  const versions = {}
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const candidates = [
      join(profileDir, 'node_modules', ...name.split('/'), 'package.json'),
      join(dirname(profileDir), 'node_modules', ...name.split('/'), 'package.json'),
    ]
    try {
      let installed
      for (const path of candidates) {
        try { installed = JSON.parse(await readFile(path, 'utf8')).version; break } catch {}
      }
      if (!installed) throw new Error('not installed')
      versions[name] = installed
      const ok = semver.validRange(range) && semver.satisfies(installed, range, { includePrerelease: true })
      checks.push(check(`installed-peer.${name}`, ok ? 'pass' : 'error', `${name} ${installed} ${ok ? 'satisfies' : 'does not satisfy'} ${range}`))
    } catch {
      checks.push(check(`installed-peer.${name}`, 'warning', `${name} is not profile-local; DSH may provide it through the shared profile fallback`))
    }
  }
  return { checks, versions }
}
