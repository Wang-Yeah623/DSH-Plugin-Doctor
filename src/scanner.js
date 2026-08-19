import { lstat, readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { MAX_SCAN_FILE_BYTES, SOURCE_EXTENSIONS } from './constants.js'
import { redact } from './utils.js'

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'coverage', '.next', '.cache'])

const RULES = [
  {
    id: 'install-script', permission: 'install-script', severity: 'critical', confidence: 'high',
    description: 'Executes code during package installation', manifestScripts: ['preinstall', 'install', 'postinstall', 'prepare'],
  },
  {
    id: 'shell-execution', permission: 'shell', severity: 'high', confidence: 'high',
    description: 'Can execute child processes or shell commands',
    patterns: [/\b(?:node:)?child_process\b/, /\b(?:exec|execFile|spawn|fork|spawnSync|execSync)\s*\(/, /\bBun\.spawn\s*\(/],
  },
  {
    id: 'filesystem-write', permission: 'filesystem-write', severity: 'high', confidence: 'medium',
    description: 'Can modify or delete files',
    patterns: [/\b(?:writeFile|appendFile|createWriteStream|unlink|rm|rmdir|rename|chmod|chown|symlink|truncate)\s*(?:Sync)?\s*\(/, /\bfs\.promises\.(?:writeFile|appendFile|unlink|rm|rename|chmod)\s*\(/],
  },
  {
    id: 'filesystem-read', permission: 'filesystem-read', severity: 'medium', confidence: 'medium',
    description: 'Can read local files',
    patterns: [/\b(?:readFile|createReadStream|readdir|opendir|readlink|realpath)\s*(?:Sync)?\s*\(/, /\bfs\.promises\.(?:readFile|readdir|opendir|readlink|realpath)\s*\(/],
  },
  {
    id: 'network-client', permission: 'network', severity: 'high', confidence: 'medium',
    description: 'Can make outbound network connections',
    patterns: [/\b(?:fetch|WebSocket)\s*\(/, /\b(?:node:)?(?:http|https|net|tls|dns|dgram)\b/, /\b(?:axios|got|undici)\b/, /\.request\s*\(/],
  },
  {
    id: 'credential-access', permission: 'credentials', severity: 'high', confidence: 'medium',
    description: 'Can read environment variables or credential stores',
    patterns: [/\bprocess\.env\b/, /\b(?:keytar|keychain|credential|secret|api[_-]?key|access[_-]?token)\b/i, /\.credentials\.ya?ml\b/, /\b(?:\.env|npmrc)\b/],
  },
  {
    id: 'cordis-hooks', permission: 'hooks', severity: 'medium', confidence: 'high',
    description: 'Registers lifecycle or event hooks',
    patterns: [/\bctx\.(?:on|once|effect|before|middleware)\s*\(/, /\b(?:agent|tools|session|llm|turn|step)\/[\w-]+\b/],
  },
  {
    id: 'dynamic-code', permission: 'dynamic-code', severity: 'critical', confidence: 'high',
    description: 'Evaluates dynamically constructed code',
    patterns: [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bvm\.(?:runIn|runInNewContext|compileFunction)\w*\s*\(/],
  },
  {
    id: 'native-code', permission: 'native-code', severity: 'critical', confidence: 'high',
    description: 'Loads or builds native code',
    patterns: [/\bnode-gyp\b/, /\.node["']/, /\b(?:ffi-napi|node-addon-api|bindings)\b/],
  },
  {
    id: 'global-path', permission: 'host-filesystem', severity: 'high', confidence: 'medium',
    description: 'References paths outside the DSH workspace/home',
    patterns: [/(?:["'`](?:\/etc\/|\/var\/|\/usr\/|C:\\Windows\\|C:\\Users\\))/, /\b(?:homedir\s*\(|process\.env\.(?:HOME|USERPROFILE))\b/],
  },
]

/**
 * Resolve directories that must never be scanned for a given run.
 *
 * The report directory is the important case: doctor writes its own findings
 * there, so a second run would rescan those artifacts and re-flag the risk
 * keywords they quote. Matching is done on resolved absolute paths rather than
 * directory names so a plugin's own `reports/` source folder is still scanned
 * when reports are written elsewhere.
 */
export function excludedRoots(root, reportDir) {
  const excluded = new Set()
  if (typeof reportDir !== 'string' || reportDir.trim() === '') return excluded
  const resolved = resolve(reportDir)
  const scanRoot = resolve(root)
  if (resolved === scanRoot) return excluded
  if (resolved.startsWith(`${scanRoot}/`) || resolved.startsWith(`${scanRoot}\\`)) excluded.add(resolved)
  return excluded
}

async function walk(root, directory = root, output = [], excluded = new Set()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const path = join(directory, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      if (excluded.has(resolve(path))) continue
      await walk(root, path, output, excluded)
    } else if (info.isFile() && info.size <= MAX_SCAN_FILE_BYTES
      && (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()) || extname(entry.name) === '.node' || (info.mode & 0o111) !== 0)) output.push(path)
  }
  return output
}

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length
}

function snippet(text, index) {
  const lineStart = text.lastIndexOf('\n', index) + 1
  const lineEnd = text.indexOf('\n', index)
  return text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 240)
}

function finding(rule, file, line, evidence, source = 'source') {
  return {
    id: rule.id, category: rule.permission, permission: rule.permission,
    severity: rule.severity, confidence: rule.confidence, description: rule.description,
    file, line, evidence: redact(evidence), source,
  }
}

export async function scanSource(root, manifest, options = {}) {
  const findings = []
  const scripts = manifest.scripts ?? {}
  for (const rule of RULES.filter(item => item.manifestScripts)) {
    for (const name of rule.manifestScripts) {
      if (typeof scripts[name] === 'string') findings.push(finding(rule, 'package.json', undefined, `${name}: ${scripts[name]}`, 'manifest'))
    }
  }

  const excluded = excludedRoots(root, options.reportDir)
  for (const path of await walk(root, root, [], excluded)) {
    const relativePath = relative(root, path).replace(/\\/g, '/')
    if (extname(path) === '.node') {
      const rule = RULES.find(item => item.id === 'native-code')
      findings.push(finding(rule, relativePath, undefined, 'Native .node binary is included'))
      continue
    }
    let text
    try { text = await readFile(path, 'utf8') } catch { continue }
    for (const rule of RULES.filter(item => item.patterns)) {
      let matched = false
      for (const pattern of rule.patterns) {
        const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
        const globalPattern = new RegExp(pattern.source, flags)
        for (const match of text.matchAll(globalPattern)) {
          findings.push(finding(rule, relativePath, lineNumber(text, match.index), snippet(text, match.index)))
          matched = true
          break
        }
        if (matched) break
      }
    }
  }
  return dedupeFindings(findings)
}

function dedupeFindings(findings) {
  const seen = new Set()
  return findings.filter(item => {
    const key = `${item.id}:${item.file}:${item.line ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function permissionManifest(findings, patchReferences = []) {
  const grouped = new Map()
  for (const item of findings) {
    const current = grouped.get(item.permission) ?? { permission: item.permission, severity: item.severity, reasons: [], files: new Set() }
    if (!current.reasons.includes(item.description)) current.reasons.push(item.description)
    current.files.add(item.file)
    grouped.set(item.permission, current)
  }
  return {
    permissions: [...grouped.values()].map(item => ({ ...item, files: [...item.files].sort() })),
    cordisEntries: patchReferences,
  }
}
