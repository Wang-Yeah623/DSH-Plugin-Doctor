import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { diffLines } from '../src/diff.js'
import { parseDshVersion } from '../src/compatibility.js'
import { collectPatchReferences, validateManifest } from '../src/manifest.js'
import { sanitizedRuntimeEnv } from '../src/isolation.js'
import { evaluatePolicy } from '../src/policy.js'
import { badgeSvg, markdownReport } from '../src/report.js'
import { permissionManifest, scanSource, excludedRoots } from '../src/scanner.js'
import { acquireSource } from '../src/source.js'
import { backupDirectory, commandExists, pathExists, restoreDirectory, splitCommand } from '../src/utils.js'

const fixtures = resolve('test/fixtures')

test('validates a DSH bundle manifest and YAML patch', async () => {
  const root = join(fixtures, 'safe-plugin')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const result = await validateManifest(root, manifest)
  assert.equal(result.checks.some(item => item.level === 'error'), false)
  assert.equal(result.patchEntries.length, 1)
})

test('detects install, shell, hook, network and credential permissions', async () => {
  const root = join(fixtures, 'risky-plugin')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const findings = await scanSource(root, manifest)
  const permissions = new Set(findings.map(item => item.permission))
  assert.deepEqual([...['install-script', 'shell', 'hooks', 'network', 'credentials'].filter(item => !permissions.has(item))], [])
  const summary = permissionManifest(findings)
  assert.ok(summary.permissions.length >= 5)
})

test('critical findings block unless permission is acknowledged', () => {
  const input = {
    checks: [], packageName: 'x', allowlist: { allowed: true }, blockSeverities: ['critical'],
    findings: [{ id: 'install-script', severity: 'critical', permission: 'install-script', file: 'package.json' }],
  }
  assert.equal(evaluatePolicy({ ...input, allowedPermissions: new Set() }).status, 'fail')
  assert.equal(evaluatePolicy({ ...input, allowedPermissions: new Set(['install-script']) }).status, 'pass')
})

test('isolated runtime strips inherited credentials', () => {
  assert.deepEqual(sanitizedRuntimeEnv({ PATH: '/bin', DEEPSEEK_API_KEY: 'secret', NODE_AUTH_TOKEN: 'secret', HTTP_PROXY: 'proxy' }), {
    PATH: '/bin', HTTP_PROXY: 'proxy',
  })
})

test('parses a quoted Windows DSH command without dropping path separators', () => {
  const command = String.raw`"C:\Program Files\nodejs\node.exe" --import "F:\DSH Work\tsx\index.mjs" "F:\DSH Work\cli.ts"`
  assert.deepEqual(splitCommand(command), [
    String.raw`C:\Program Files\nodejs\node.exe`,
    '--import',
    String.raw`F:\DSH Work\tsx\index.mjs`,
    String.raw`F:\DSH Work\cli.ts`,
  ])
})

test('recognizes an explicit executable path as an available command', () => {
  assert.equal(commandExists(process.execPath), true)
})

test('packs a local plugin path with spaces and Unicode before isolated installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor source with spaces-'))
  const plugin = join(root, '插件 fixture')
  await cp(join(fixtures, 'safe-plugin'), plugin, { recursive: true })
  let source
  try {
    source = await acquireSource(plugin, { timeoutMs: 30_000 })
    assert.equal(source.root, plugin)
    assert.notEqual(source.installSpec, plugin)
    assert.match(source.installSpec, /\.tgz$/)
    assert.equal(await pathExists(source.installSpec), true)
  } finally {
    await source?.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('uses the DSH version rather than an earlier package-manager version', () => {
  assert.equal(parseDshVersion('using pnpm 11.22.0\n0.1.0-rc.5\n'), '0.1.0-rc.5')
})

test('redacts secrets from configuration preview', () => {
  const [entry] = collectPatchReferences([{ id: 'x', name: 'p', config: { apiKey: 'sk-secret-value', endpoint: 'https://user:pass@example.com' } }])
  assert.equal(entry.config.apiKey, '[REDACTED]')
  assert.equal(entry.config.endpoint, 'https://[REDACTED]@example.com')
})

test('renders config diff and reports', () => {
  const diff = diffLines('a\nb', 'a\nc')
  assert.match(diff, /-b/)
  assert.match(diff, /\+c/)
  const report = {
    status: 'pass', source: '.', plugin: { name: 'x', version: '1.0.0' }, generatedAt: new Date().toISOString(),
    tool: { version: '0.1.0' }, checks: [], findings: [],
    permissions: { permissions: [], cordisEntries: [] }, regressions: [], policy: { blockers: [] },
  }
  assert.match(markdownReport(report), /DSH Plugin Doctor/)
  assert.match(badgeSvg('pass'), /compatible/)
})

test('backs up and restores a profile without deleting the failed state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-backup-test-'))
  const profile = join(root, 'profile')
  const backups = join(root, 'backups')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(profile, { recursive: true }))
  await writeFile(join(profile, 'state'), 'before')
  const backup = await backupDirectory(profile, backups, 'test')
  await writeFile(join(profile, 'state'), 'after')
  const failed = await restoreDirectory(backup, profile)
  assert.equal(await readFile(join(profile, 'state'), 'utf8'), 'before')
  assert.equal(await readFile(join(failed, 'state'), 'utf8'), 'after')
  assert.equal(await pathExists(backup), true)
  await rm(root, { recursive: true, force: true })
})

test('excludedRoots only excludes a report directory nested inside the scan root', () => {
  const root = resolve('/tmp/plugin')
  assert.deepEqual([...excludedRoots(root, '/tmp/plugin/reports')], [resolve('/tmp/plugin/reports')])
  assert.deepEqual([...excludedRoots(root, '/tmp/elsewhere')], [])
  assert.deepEqual([...excludedRoots(root, '/tmp/plugin')], [])
  assert.deepEqual([...excludedRoots(root, undefined)], [])
})

test('scanSource ignores its own report directory so repeat runs stay stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-reportdir-test-'))
  const { mkdir } = await import('node:fs/promises')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
  await writeFile(join(root, 'index.js'), 'export const name = "p"\n')

  // Simulate the artifacts a previous run left behind: the JSON report quotes
  // risk keywords, which used to be rescanned as fresh source findings.
  const reports = join(root, 'reports')
  await mkdir(reports, { recursive: true })
  await writeFile(join(reports, 'p.doctor.json'), JSON.stringify({ findings: [{ evidence: 'const bindings = require("child_process")' }] }))

  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const withExclusion = await scanSource(root, manifest, { reportDir: join(root, 'reports') })
  assert.deepEqual(withExclusion.filter(item => item.file.startsWith('reports/')), [])

  const withoutExclusion = await scanSource(root, manifest)
  assert.ok(withoutExclusion.some(item => item.file.startsWith('reports/')),
    'without the exclusion the stale report is still scanned, proving the fix is what suppresses it')

  await rm(root, { recursive: true, force: true })
})

test('a directory named reports is still scanned when reports go elsewhere', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-samename-test-'))
  const { mkdir } = await import('node:fs/promises')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
  const sourceDir = join(root, 'reports')
  await mkdir(sourceDir, { recursive: true })
  await writeFile(join(sourceDir, 'builder.js'), 'import { exec } from "node:child_process"\nexec("ls")\n')

  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const findings = await scanSource(root, manifest, { reportDir: join(tmpdir(), 'doctor-out') })
  assert.ok(findings.some(item => item.file === 'reports/builder.js'),
    'business source under reports/ must not be skipped when artifacts are written outside the scan root')

  await rm(root, { recursive: true, force: true })
})
