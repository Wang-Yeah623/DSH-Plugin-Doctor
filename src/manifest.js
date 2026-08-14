import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import YAML from 'yaml'
import semver from 'semver'
import { pathExists, redact } from './utils.js'

const JS_YAML_TAG = { tag: 'tag:yaml.org,2002:js', resolve: value => value }

function result(id, level, message, extra = {}) {
  return { id, level, message, ...extra }
}

function validRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) return false
  const normalized = normalize(value)
  return normalized !== '..' && !normalized.startsWith(`..${sep}`)
}

function listedInFiles(path, files) {
  if (!Array.isArray(files)) return true
  const clean = path.replace(/^\.\//, '').replace(/\\/g, '/')
  if (clean === 'package.json' || /^readme(?:\.|$)/i.test(clean) || /^licen[cs]e(?:\.|$)/i.test(clean)) return true
  return files.some(entry => clean === entry || clean.startsWith(`${String(entry).replace(/\/$/, '')}/`))
}

export async function validateManifest(root, manifest) {
  const checks = []
  const patch = manifest?.dsh?.bundle?.patch
  if (!manifest.name || typeof manifest.name !== 'string') checks.push(result('manifest.name', 'error', 'package.json must declare a package name'))
  else checks.push(result('manifest.name', 'pass', `Package name: ${manifest.name}`))
  if (!manifest.version || !semver.valid(manifest.version)) checks.push(result('manifest.version', 'error', 'package.json version must be valid semver'))
  else checks.push(result('manifest.version', 'pass', `Package version: ${manifest.version}`))

  if (!validRelativePath(patch)) {
    checks.push(result('manifest.dsh-bundle', 'error', 'dsh.bundle.patch must be a non-empty relative path inside the package'))
    return { checks, patch: undefined, patchEntries: [], patchText: '' }
  }
  const patchPath = resolve(root, patch)
  if (!(await pathExists(patchPath))) {
    checks.push(result('manifest.dsh-bundle', 'error', `dsh.bundle.patch does not exist: ${patch}`))
    return { checks, patch: patchPath, patchEntries: [], patchText: '' }
  }
  if (!(await stat(patchPath)).isFile()) {
    checks.push(result('manifest.dsh-bundle', 'error', `dsh.bundle.patch is not a file: ${patch}`))
    return { checks, patch: patchPath, patchEntries: [], patchText: '' }
  }
  const [realRoot, realPatch] = await Promise.all([realpath(root), realpath(patchPath)])
  if (realPatch !== realRoot && !realPatch.startsWith(`${realRoot}${sep}`)) {
    checks.push(result('manifest.dsh-bundle', 'error', `dsh.bundle.patch resolves outside the package through a symlink: ${patch}`))
    return { checks, patch: patchPath, patchEntries: [], patchText: '' }
  }
  checks.push(result('manifest.dsh-bundle', 'pass', `Bundle patch found: ${patch}`))
  if (!listedInFiles(patch, manifest.files)) {
    checks.push(result('manifest.files', 'error', `${patch} is excluded by package.json files and will not be published`))
  } else {
    checks.push(result('manifest.files', 'pass', 'Bundle patch is included in the published package'))
  }

  const patchText = await readFile(patchPath, 'utf8')
  let patchEntries = []
  try {
    patchEntries = YAML.parse(patchText, { customTags: [JS_YAML_TAG] })
    if (!Array.isArray(patchEntries)) throw new Error('top-level value must be an array')
    checks.push(result('bundle.yaml', 'pass', `Bundle patch is valid YAML with ${patchEntries.length} top-level operation(s)`))
  } catch (error) {
    checks.push(result('bundle.yaml', 'error', `Bundle patch cannot be parsed: ${error.message}`))
  }

  if (manifest.type !== 'module') {
    checks.push(result('manifest.esm', 'warning', 'DSH uses ESM; package.json should normally declare "type": "module"'))
  } else checks.push(result('manifest.esm', 'pass', 'Package declares ESM'))

  if (manifest.dsh?.profile !== undefined) {
    checks.push(result('manifest.role', 'error', 'An installable Bundle must not also declare dsh.profile'))
  }

  const entrypoints = new Set()
  if (typeof manifest.main === 'string') entrypoints.add(manifest.main)
  collectExportTargets(manifest.exports, entrypoints)
  if (entrypoints.size === 0) checks.push(result('manifest.entrypoints', 'warning', 'No main or exports entrypoint is declared; patch-only Bundles may ignore this'))
  for (const entry of entrypoints) {
    if (entry.includes('*')) {
      checks.push(result(`manifest.entrypoint.${entry}`, 'warning', `Wildcard export requires publish-time verification: ${entry}`))
      continue
    }
    if (!entry.startsWith('./') && entry !== manifest.main) continue
    const entryPath = resolve(root, entry)
    const exists = await pathExists(entryPath)
    const included = listedInFiles(entry, manifest.files)
    checks.push(result(`manifest.entrypoint.${entry}`, exists && included ? 'pass' : 'error',
      !exists ? `Entrypoint does not exist: ${entry}` : !included ? `Entrypoint is excluded by package.json files: ${entry}` : `Entrypoint is publishable: ${entry}`))
  }

  return { checks, patch: patchPath, patchEntries, patchText }
}

function collectExportTargets(value, output) {
  if (typeof value === 'string') output.add(value)
  else if (Array.isArray(value)) value.forEach(item => collectExportTargets(item, output))
  else if (value && typeof value === 'object') Object.values(value).forEach(item => collectExportTargets(item, output))
}

export function collectPatchReferences(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectPatchReferences(item, refs)
  } else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' || typeof value.name === 'string') {
      refs.push({ id: value.id, name: value.name, inject: value.inject, config: redactValue(value.config), disabled: redactValue(value.disabled) })
    }
    for (const child of Object.values(value)) collectPatchReferences(child, refs)
  }
  return refs
}

function redactValue(value, key = '') {
  if (/(?:token|secret|password|api[_-]?key|credential|auth)/i.test(key) && value !== undefined) return '[REDACTED]'
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(item => redactValue(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]))
  return value
}

export function validatePeerRanges(manifest) {
  const checks = []
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (semver.validRange(range)) checks.push(result(`peer.${name}`, 'pass', `${name}: ${range}`))
    else checks.push(result(`peer.${name}`, 'error', `Invalid peer dependency range for ${name}: ${range}`))
  }
  if (!Object.keys(manifest.peerDependencies ?? {}).some(name => name === '@deepseek-ai/cordis')) {
    checks.push(result('peer.cordis', 'warning', 'No @deepseek-ai/cordis peer dependency is declared; direct Cordis users should share DSH\'s instance'))
  }
  return checks
}
