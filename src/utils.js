import { access, cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

export async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function readJson(path) {
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error.message}`)
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function resolveDshHome(explicit) {
  return resolve(explicit ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

export function validateProfileName(name) {
  if (!name || name === '.' || name === '..' || name === 'node_modules' || /[/\\]/.test(name)) {
    throw new Error(`Invalid profile name: ${JSON.stringify(name)}`)
  }
  return name
}

export function sanitizeFileName(value) {
  return value.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'plugin'
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  return spawnSync(probe, [command], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0
}

export function splitCommand(command) {
  if (Array.isArray(command)) return command
  const tokens = []
  let token = ''
  let quote
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = undefined
      else if (char === '\\' && quote === '"' && index + 1 < command.length) token += command[++index]
      else token += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (/\s/.test(char)) {
      if (token) tokens.push(token), token = ''
    } else {
      token += char
    }
  }
  if (quote) throw new Error('Unterminated quote in --dsh-command')
  if (token) tokens.push(token)
  if (tokens.length === 0) throw new Error('Empty command')
  return tokens
}

export function run(command, args, options = {}) {
  const startedAt = Date.now()
  return new Promise(resolvePromise => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const limit = options.outputLimit ?? 1024 * 1024
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-limit) })
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-limit) })
    child.on('error', error => {
      stderr += `\n${error.message}`
    })
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }, options.timeoutMs) : undefined
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolvePromise({
        command: [command, ...args], code: code ?? 1, signal, stdout, stderr,
        timedOut, durationMs: Date.now() - startedAt,
      })
    })
  })
}

export async function backupDirectory(source, backupRoot, label) {
  await mkdir(backupRoot, { recursive: true })
  const destination = join(backupRoot, `${timestamp()}-${sanitizeFileName(label)}`)
  const existed = await pathExists(source)
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'backup.json'), `${JSON.stringify({ source, existed, createdAt: new Date().toISOString() }, null, 2)}\n`)
  if (existed) await cp(source, join(destination, 'profile'), { recursive: true, verbatimSymlinks: true })
  return destination
}

export async function restoreDirectory(sourceBackup, target) {
  const failed = `${target}.failed-${timestamp()}`
  if (await pathExists(target)) await rename(target, failed)
  const metadata = await readJson(join(sourceBackup, 'backup.json'))
  if (metadata.existed) await cp(join(sourceBackup, 'profile'), target, { recursive: true, verbatimSymlinks: true })
  return failed
}

export async function isDirectory(path) {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

export function redact(text) {
  return String(text)
    .replace(/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|npm)_[A-Za-z0-9_\-]{12,}\b/g, '[REDACTED]')
}
