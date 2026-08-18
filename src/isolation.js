import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DEFAULT_TIMEOUT_MS } from './constants.js'
import { checkInstalledPeers, probeDsh } from './compatibility.js'
import { diffLines } from './diff.js'
import { redact, resolveCommand, run } from './utils.js'

function safeProcessResult(value) {
  if (!value) return value
  return { ...value, command: value.command?.map(redact), stdout: redact(value.stdout), stderr: redact(value.stderr) }
}

export function dshArgs(commandSpec, args) {
  return [...commandSpec.prefix, ...args]
}

export async function runDsh(commandSpec, args, options) {
  return run(commandSpec.command, dshArgs(commandSpec, args), options)
}

async function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolvePromise(address.port))
    })
  })
}

function httpReady(port) {
  return new Promise(resolvePromise => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 800 }, response => {
      response.resume()
      resolvePromise(response.statusCode >= 200 && response.statusCode < 500)
    })
    request.on('error', () => resolvePromise(false))
    request.on('timeout', () => request.destroy())
  })
}

function stopProcessTree(child, force = false) {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  child.kill(force ? 'SIGKILL' : 'SIGTERM')
}

export async function startWeb(commandSpec, env, timeoutMs = DEFAULT_TIMEOUT_MS, cwd) {
  const port = await freePort()
  const startedAt = Date.now()
  const args = dshArgs(commandSpec, ['--profile', 'web', '--host', '127.0.0.1', '--port', String(port)])
  const invocation = resolveCommand(commandSpec.command, env)
  const executable = invocation?.command ?? commandSpec.command
  const commandArgs = [...(invocation?.prefix ?? []), ...args]
  const child = spawn(executable, commandArgs, {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    shell: invocation?.shell ?? (process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandSpec.command)),
  })
  let stdout = ''
  let stderr = ''
  let exitCode
  child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-512_000) })
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-512_000) })
  child.on('close', code => { exitCode = code ?? 1 })
  child.on('error', error => { stderr += `\n${error.message}`; exitCode = 1 })

  let ready = false
  while (Date.now() - startedAt < timeoutMs && exitCode === undefined) {
    if (await httpReady(port)) { ready = true; break }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
  }
  stopProcessTree(child)
  const stopped = new Promise(resolvePromise => child.once('close', resolvePromise))
  await Promise.race([stopped, new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))])
  if (child.exitCode === null && child.signalCode === null) stopProcessTree(child, true)
  return {
    ready, port, code: exitCode, durationMs: Date.now() - startedAt,
    stdout: redact(stdout), stderr: redact(stderr),
    message: ready ? `Web profile became ready on 127.0.0.1:${port}` : `Web profile did not become ready within ${timeoutMs}ms`,
  }
}

export async function isolatedInstallTest({ commandSpec, installSpec, manifest, registry, timeoutMs, keepTemp = false, allowScripts = false }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-home-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const runtimeEnv = {
    ...sanitizedRuntimeEnv(process.env),
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    CI: '1',
  }
  const installEnv = { ...runtimeEnv }
  for (const key of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig']) {
    if (process.env[key] !== undefined) installEnv[key] = process.env[key]
  }
  const profileDir = join(home, 'profiles', 'web')
  const packageRunner = commandSpec.command === 'npx' || commandSpec.prefix.some(argument => argument === '--package' || argument.startsWith('--package='))
  const probe = await probeDsh(commandSpec, runtimeEnv, packageRunner ? Math.max(timeoutMs, 180_000) : timeoutMs)
  if (probe.check.level === 'error') {
    if (!keepTemp) await rm(root, { recursive: true, force: true })
    return { status: 'fail', home, checks: [probe.check], probe, kept: keepTemp }
  }

  const before = await runDsh(commandSpec, ['--profile', 'web', '--dump-config'], { cwd: workspace, env: runtimeEnv, timeoutMs })
  const installArgs = ['plugin', '--profile', 'web', 'add', installSpec]
  if (!allowScripts) installArgs.push('--ignore-scripts')
  if (registry) installArgs.push('--registry', registry)
  const install = await runDsh(commandSpec, installArgs, { cwd: workspace, env: installEnv, timeoutMs: Math.max(timeoutMs, 120_000) })
  const after = install.code === 0
    ? await runDsh(commandSpec, ['--profile', 'web', '--dump-config'], { cwd: workspace, env: runtimeEnv, timeoutMs })
    : undefined
  const startup = after?.code === 0 ? await startWeb(commandSpec, runtimeEnv, timeoutMs, workspace) : undefined
  const peers = install.code === 0 ? await checkInstalledPeers(profileDir, manifest) : { checks: [], versions: {} }
  const checks = [
    probe.check,
    { id: 'isolate.base-config', level: before.code === 0 ? 'pass' : 'error', message: before.code === 0 ? 'Base Web profile composed' : 'Base Web profile failed to compose' },
    { id: 'isolate.install', level: install.code === 0 ? 'pass' : 'error', message: install.code === 0 ? 'Plugin installed into temporary DSH_HOME' : 'Plugin installation failed in temporary DSH_HOME' },
    ...(after ? [{ id: 'isolate.config', level: after.code === 0 ? 'pass' : 'error', message: after.code === 0 ? 'Plugin configuration composed' : 'Plugin configuration failed to compose' }] : []),
    ...(startup ? [{ id: 'isolate.startup', level: startup.ready ? 'pass' : 'error', message: startup.message }] : []),
    ...peers.checks,
  ]
  const status = checks.some(item => item.level === 'error') ? 'fail' : 'pass'
  const result = {
    status, home, kept: keepTemp, dshVersion: probe.version,
    checks,
    commands: { before: safeProcessResult(before), install: safeProcessResult(install), after: safeProcessResult(after) },
    startup,
    installedPeers: peers.versions,
    configDiff: after?.code === 0 ? diffLines(before.stdout, after.stdout) : '',
  }
  if (!keepTemp) await rm(root, { recursive: true, force: true })
  return result
}

export function sanitizedRuntimeEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|CREDENTIAL|AUTH)/i.test(key)))
}
