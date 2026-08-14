import { resolve } from 'node:path'
import { pathExists, readJson } from './utils.js'

const DEFAULT_CONFIG = {
  policy: {
    blockSeverities: ['critical'],
    allowedPermissions: [],
    packagePermissions: {},
  },
  allowlist: [],
  registries: {},
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    policy: { ...base.policy, ...override?.policy },
    registries: { ...base.registries, ...override?.registries },
  }
}

export async function loadConfig(path) {
  const candidate = resolve(path ?? '.dsh-doctor.json')
  if (!(await pathExists(candidate))) return { ...DEFAULT_CONFIG, configPath: undefined }
  const parsed = await readJson(candidate)
  return { ...mergeConfig(DEFAULT_CONFIG, parsed), configPath: candidate }
}

function matchPattern(name, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(name)
}

export function allowedPackage(name, source, config) {
  if (!config.allowlist?.length) return { allowed: true, reason: 'No team allowlist configured' }
  const candidates = [name, source].filter(Boolean)
  const entry = config.allowlist.find(item => {
    const pattern = typeof item === 'string' ? item : item.package
    return candidates.some(value => matchPattern(value, pattern))
  })
  return entry
    ? { allowed: true, reason: 'Matched team allowlist', entry }
    : { allowed: false, reason: 'Plugin is not present in the team allowlist' }
}

export function allowedPermissions(name, config, cliPermissions = []) {
  const global = config.policy?.allowedPermissions ?? []
  const packageRules = config.policy?.packagePermissions ?? {}
  const matched = Object.entries(packageRules)
    .filter(([pattern]) => matchPattern(name, pattern))
    .flatMap(([, permissions]) => permissions)
  return new Set([...global, ...matched, ...cliPermissions])
}
