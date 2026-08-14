export const TOOL_NAME = 'DSH Plugin Doctor'
export const TOOL_VERSION = '0.1.0'
export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024
export const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
  '.json', '.yml', '.yaml', '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat',
])
