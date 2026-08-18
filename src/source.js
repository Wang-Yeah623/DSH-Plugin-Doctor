import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { x as extractTar } from 'tar'
import { isDirectory, pathExists, readJson, redact, run } from './utils.js'

function looksLikePath(spec) {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')
    || spec.startsWith('file:') || isAbsolute(spec)
}

async function findPackageRoot(extractDir) {
  const conventional = join(extractDir, 'package')
  if (await pathExists(join(conventional, 'package.json'))) return conventional
  const entries = await readdir(extractDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && await pathExists(join(extractDir, entry.name, 'package.json'))) {
      return join(extractDir, entry.name)
    }
  }
  throw new Error('Downloaded archive contains no package.json')
}

async function packSource(spec, work, options) {
  const npmArgs = ['pack', spec, '--ignore-scripts', '--json']
  if (options.registry) npmArgs.push('--registry', options.registry)
  const packed = await run(options.npmCommand ?? 'npm', npmArgs, {
    cwd: work,
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? 60_000,
  })
  if (packed.code !== 0) throw new Error(`Unable to pack ${spec} without scripts: ${packed.stderr || packed.stdout}`)
  let metadata
  try {
    const parsed = JSON.parse(packed.stdout)
    metadata = Array.isArray(parsed) ? parsed[0] : parsed
  } catch {
    throw new Error(`npm pack returned invalid JSON for ${spec}`)
  }
  if (!metadata?.filename) throw new Error(`npm pack returned no archive filename for ${spec}`)
  return { archive: resolve(work, metadata.filename), metadata }
}

export async function acquireSource(spec, options = {}) {
  const normalizedPath = spec.startsWith('file:') ? spec.slice(5) : spec
  const candidatePath = resolve(options.cwd ?? process.cwd(), normalizedPath)
  if (looksLikePath(spec) || await isDirectory(candidatePath)) {
    const root = candidatePath
    if (!(await isDirectory(root))) throw new Error(`Plugin path is not a directory: ${root}`)
    const manifestPath = join(root, 'package.json')
    if (!(await pathExists(manifestPath))) throw new Error(`Plugin path has no package.json: ${root}`)
    const work = await mkdtemp(join(tmpdir(), 'dsh-doctor-source-'))
    try {
      const { archive, metadata } = await packSource(root, work, options)
      return {
        kind: 'directory', root, installSpec: archive, originalSpec: spec,
        registry: options.registry,
        integrity: metadata.integrity, shasum: metadata.shasum,
        manifest: await readJson(manifestPath), cleanup: () => rm(work, { recursive: true, force: true }),
      }
    } catch (error) {
      await rm(work, { recursive: true, force: true })
      throw error
    }
  }

  const work = await mkdtemp(join(tmpdir(), 'dsh-doctor-source-'))
  try {
    const { archive, metadata } = await packSource(spec, work, options)
    const extractDir = join(work, 'unpacked')
    await mkdir(extractDir, { recursive: true })
    await extractTar({ file: archive, cwd: extractDir, gzip: true })
    const root = await findPackageRoot(extractDir)
    const manifest = await readJson(join(root, 'package.json'))
    return {
      kind: 'package', root, originalSpec: spec,
      installSpec: isRegistrySpec(spec) ? `${manifest.name}@${manifest.version}` : spec,
      registry: options.registry,
      integrity: metadata.integrity, shasum: metadata.shasum,
      manifest,
      cleanup: () => rm(work, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(work, { recursive: true, force: true })
    throw error
  }
}

function isRegistrySpec(spec) {
  return /^(?:@[^/]+\/[^@/]+|[^@/:/]+)(?:@[^/]+)?$/.test(spec)
}

export function inferRegistry(name, config) {
  if (!name?.startsWith('@')) return config.registries?.default
  const scope = name.slice(0, name.indexOf('/'))
  return config.registries?.[scope] ?? config.registries?.default
}

export function sourceDisplay(source) {
  return source.kind === 'directory' ? source.root : redact(source.originalSpec)
}
