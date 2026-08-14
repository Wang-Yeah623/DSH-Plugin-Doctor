import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { diffLines } from '../src/diff.js'
import { collectPatchReferences, validateManifest } from '../src/manifest.js'
import { sanitizedRuntimeEnv } from '../src/isolation.js'
import { evaluatePolicy } from '../src/policy.js'
import { badgeSvg, markdownReport } from '../src/report.js'
import { permissionManifest, scanSource } from '../src/scanner.js'
import { backupDirectory, pathExists, restoreDirectory } from '../src/utils.js'

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
