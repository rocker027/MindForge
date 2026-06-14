import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

const APP_CONFIG_DIR = 'com.tolaria.app'
const LEGACY_APP_CONFIG_DIR = 'com.laputa.app'

function parseVaultPathList(rawValue) {
  if (!rawValue?.trim()) return []

  try {
    const parsed = JSON.parse(rawValue)
    if (Array.isArray(parsed)) return parsed.filter(value => typeof value === 'string')
  } catch {
    // Older clients only set VAULT_PATH; keep VAULT_PATHS strict JSON so paths
    // with platform separators are never split incorrectly.
  }

  return []
}

function uniqueVaultPaths(paths) {
  const seen = new Set()
  const unique = []
  for (const path of paths) {
    const trimmed = path.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    unique.push(trimmed)
  }
  return unique
}

function appConfigBaseDir(env = process.env) {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (platform() === 'win32') return env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

/** Where vaults.json is written: always the current app namespace. */
export function preferredVaultsJsonPath({ configDir = appConfigBaseDir() } = {}) {
  return join(configDir, APP_CONFIG_DIR, 'vaults.json')
}

export function vaultsJsonPath({ configDir = appConfigBaseDir() } = {}) {
  const preferred = preferredVaultsJsonPath({ configDir })
  if (existsSync(preferred)) return preferred

  const legacy = join(configDir, LEGACY_APP_CONFIG_DIR, 'vaults.json')
  return existsSync(legacy) ? legacy : preferred
}

function pushUniquePath(paths, value) {
  const path = typeof value === 'string' ? value.trim() : ''
  if (!path || paths.includes(path)) return
  paths.push(path)
}

function activeVaultPathsFromList(list) {
  const paths = []
  pushUniquePath(paths, list?.active_vault)

  for (const vault of list?.vaults ?? []) {
    if (vault?.mounted === false) continue
    pushUniquePath(paths, vault?.path)
  }

  return paths
}

export function configuredVaultPaths({ configDir } = {}) {
  const filePath = vaultsJsonPath({ configDir })
  if (!existsSync(filePath)) return []

  return activeVaultPathsFromList(JSON.parse(readFileSync(filePath, 'utf-8')))
}

function memoryVaultEntryFromList(list) {
  for (const vault of list?.vaults ?? []) {
    if (vault?.kind !== 'memory' || vault?.mounted === false) continue
    const vaultPath = typeof vault.path === 'string' ? vault.path.trim() : ''
    if (vaultPath) return { ...vault, path: vaultPath }
  }
  return null
}

/**
 * Find the mounted memory vault entry (vaults.json entry with kind "memory").
 * Returns null when no memory vault is configured or it is unmounted.
 */
export function configuredMemoryVaultEntry({ configDir } = {}) {
  const filePath = vaultsJsonPath({ configDir })
  if (!existsSync(filePath)) return null

  return memoryVaultEntryFromList(JSON.parse(readFileSync(filePath, 'utf-8')))
}

/**
 * Find the mounted memory vault path (vaults.json entry with kind "memory").
 * Returns null when no memory vault is configured or it is unmounted.
 */
export function configuredMemoryVaultPath({ configDir } = {}) {
  return configuredMemoryVaultEntry({ configDir })?.path ?? null
}

/**
 * Resolve a target path against a vault root and reject anything that lands
 * outside the vault (path traversal, absolute paths escaping the root).
 * Accepts relative or absolute targets; returns the resolved absolute path.
 */
export function resolveInsideVault(vaultRoot, targetPath) {
  const resolved = resolve(vaultRoot, targetPath)
  const relation = relative(vaultRoot, resolved)
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error(`Path must stay inside the vault: ${targetPath}`)
  }
  return resolved
}

export function requireVaultPaths(env = process.env, options = {}) {
  const vaultPaths = uniqueVaultPaths([
    env.VAULT_PATH?.trim() ?? '',
    ...parseVaultPathList(env.VAULT_PATHS),
  ])
  if (vaultPaths.length === 0) {
    const configuredPaths = configuredVaultPaths(options)
    if (configuredPaths.length > 0) return configuredPaths
    throw new Error('VAULT_PATH is required. Open a vault in Tolaria before starting MCP tools.')
  }
  return vaultPaths
}

export function requireVaultPath(env = process.env, options = {}) {
  return requireVaultPaths(env, options)[0]
}
