export function evaluatePolicy({ checks, findings, packageName, allowlist, allowedPermissions, blockSeverities }) {
  const blockers = []
  for (const item of checks) {
    if (item.level === 'error') blockers.push({ type: 'check', id: item.id, reason: item.message })
  }
  if (!allowlist.allowed) blockers.push({ type: 'allowlist', id: 'team-allowlist', reason: allowlist.reason })
  const blockedLevels = new Set(blockSeverities ?? ['critical'])
  for (const item of findings) {
    if (blockedLevels.has(item.severity) && !allowedPermissions.has(item.permission)) {
      blockers.push({ type: 'risk', id: item.id, reason: `${item.severity} ${item.permission} at ${item.file}${item.line ? `:${item.line}` : ''}` })
    }
  }
  return {
    status: blockers.length === 0 ? 'pass' : 'fail',
    blockers,
    packageName,
    acknowledgedPermissions: [...allowedPermissions].sort(),
  }
}
