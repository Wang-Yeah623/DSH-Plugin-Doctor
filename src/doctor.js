import { collectPatchReferences, validateManifest, validatePeerRanges } from './manifest.js'
import { acquireSource, inferRegistry, sourceDisplay } from './source.js'
import { allowedPackage, allowedPermissions, loadConfig } from './config.js'
import { checkDeclaredDsh, dshCommand, nodeCompatibility } from './compatibility.js'
import { isolatedInstallTest } from './isolation.js'
import { evaluatePolicy } from './policy.js'
import { baseReport, writeReports } from './report.js'
import { permissionManifest, scanSource } from './scanner.js'
import { splitCommand } from './utils.js'

export async function doctorPlugin(spec, options = {}) {
  const config = await loadConfig(options.config)
  const registry = inferRegistry(spec, config)
  const reportDir = options.reportDir ?? 'reports'
  const source = await acquireSource(spec, { registry, timeoutMs: options.timeoutMs })
  try {
    const manifestResult = await validateManifest(source.root, source.manifest)
    const findings = await scanSource(source.root, source.manifest, { reportDir })
    const references = collectPatchReferences(manifestResult.patchEntries)
    const permissions = permissionManifest(findings, references)
    const checks = [
      ...manifestResult.checks,
      nodeCompatibility(source.manifest),
      ...validatePeerRanges(source.manifest),
    ]
    const allowlist = allowedPackage(source.manifest.name, source.originalSpec, config)
    checks.push({ id: 'policy.allowlist', level: allowlist.allowed ? 'pass' : 'error', message: allowlist.reason })

    const versions = options.dshVersions?.length ? options.dshVersions : ['current']
    const explicitCommand = options.dshCommand ? splitCommand(options.dshCommand) : undefined
    if (explicitCommand && versions.length > 1) throw new Error('--dsh-command cannot represent more than one --dsh-version; run each explicit command separately')
    const regressions = []
    if (options.isolate !== false) {
      for (const version of versions) {
        const commandSpec = dshCommand(version, explicitCommand)
        const regression = await isolatedInstallTest({
          commandSpec,
          installSpec: source.installSpec,
          manifest: source.manifest,
          registry: source.registry,
          timeoutMs: options.timeoutMs,
          keepTemp: options.keepTemp,
          allowScripts: options.allowScripts,
        })
        regression.version = version
        regressions.push(regression)
        checks.push(...regression.checks.map(item => ({ ...item, id: `${item.id}[${version}]` })))
        checks.push({ ...checkDeclaredDsh(source.manifest, regression.dshVersion), id: `compat.dsh-range[${version}]` })
      }
    } else {
      checks.push({ id: 'isolate.skipped', level: 'warning', message: 'Isolated install and startup were skipped' })
    }

    const grantedPermissions = allowedPermissions(source.manifest.name ?? source.originalSpec, config, options.allowPermissions)
    const policy = evaluatePolicy({
      checks, findings, packageName: source.manifest.name, allowlist,
      allowedPermissions: grantedPermissions,
      blockSeverities: options.strict ? ['high', 'critical'] : config.policy?.blockSeverities,
    })
    const report = {
      ...baseReport(sourceDisplay(source), source.manifest),
      status: policy.status,
      integrity: { integrity: source.integrity, shasum: source.shasum },
      checks,
      findings,
      permissions,
      policy,
      regressions,
    }
    report.artifacts = await writeReports(report, reportDir)
    return report
  } finally {
    await source.cleanup()
  }
}
