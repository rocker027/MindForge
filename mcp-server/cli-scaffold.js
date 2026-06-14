/**
 * Memory vault scaffolding for the tolaria-mem CLI — the structural twin of
 * the Rust `scaffold_memory_vault` Tauri command (ADR-0140).
 *
 * Both sides must stay in lockstep: the same template files (sourced from
 * src-tauri/resources/memory-vault-template/, copied next to the bundled CLI
 * by scripts/bundle-mcp-server.mjs), the same {{DATE}} rendering, idempotent
 * writes that never overwrite, git init with an initial commit, and a
 * vaults.json registration that is byte-identical to the serde output.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { preferredVaultsJsonPath, vaultsJsonPath } from './vault-path.js'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DATE_PLACEHOLDER = '{{DATE}}'
const TEMPLATE_DIRS = ['raw/inbox', 'raw/assets', 'wiki']

/** Mirrors TEMPLATE_FILES in src-tauri/src/commands/memory_vault.rs. */
const TEMPLATE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.gitignore',
  'wiki/index.md',
  'wiki/log.md',
  'wiki/overview.md',
  'raw/inbox/.gitkeep',
  'raw/assets/.gitkeep',
]

/** Mirrors the git author fallback in src-tauri/src/git/mod.rs. */
const FALLBACK_AUTHOR_NAME = 'Tolaria'
const FALLBACK_AUTHOR_EMAIL = 'vault@tolaria.default'

/**
 * Locate the memory vault template directory. The bundled CLI ships the
 * template alongside itself; a dev checkout reads the Tauri resource source.
 */
export function resolveTemplateDir(moduleDir = MODULE_DIR) {
  const candidates = [
    path.join(moduleDir, 'memory-vault-template'),
    path.join(moduleDir, '..', 'src-tauri', 'resources', 'memory-vault-template'),
  ]
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) {
    throw new Error(`Memory vault template not found. Looked in: ${candidates.join(', ')}`)
  }
  return found
}

/** Expand a leading `~` to the home directory (mirrors Rust expand_tilde). */
export function expandTilde(targetPath) {
  if (targetPath === '~') return homedir()
  if (targetPath.startsWith('~/')) return path.join(homedir(), targetPath.slice(2))
  return targetPath
}

/**
 * Scaffold a memory vault from the template and register it in vaults.json.
 *
 * Idempotent: existing files are never overwritten, an existing git repo is
 * left untouched, and an already-registered path is not duplicated.
 * Returns the same report shape as the Rust command: `{path, createdFiles,
 * skippedFiles, gitInitialized, registered}`.
 */
export function scaffoldMemoryVault(targetPath, {
  templateDir = resolveTemplateDir(),
  configDir,
  now = () => new Date(),
  runGit = defaultRunGit,
} = {}) {
  const root = path.resolve(expandTilde(targetPath))

  const { createdFiles, skippedFiles } = scaffoldTemplateFiles(root, templateDir, formatLocalDate(now()))
  const gitInitialized = ensureGitRepo(root, runGit)
  const canonicalPath = canonicalPathString(root)
  const registered = registerInVaultList(canonicalPath, configDir)

  return { path: canonicalPath, createdFiles, skippedFiles, gitInitialized, registered }
}

// --- template files ---

function scaffoldTemplateFiles(root, templateDir, date) {
  for (const dir of TEMPLATE_DIRS) {
    mkdirSync(path.join(root, dir), { recursive: true })
  }

  const createdFiles = []
  const skippedFiles = []
  for (const relativePath of TEMPLATE_FILES) {
    const target = path.join(root, relativePath)
    if (existsSync(target)) {
      skippedFiles.push(relativePath)
      continue
    }
    writeFileSync(target, renderTemplateFile(templateDir, relativePath, date), 'utf-8')
    createdFiles.push(relativePath)
  }
  return { createdFiles, skippedFiles }
}

function renderTemplateFile(templateDir, relativePath, date) {
  return readFileSync(path.join(templateDir, relativePath), 'utf-8').replaceAll(DATE_PLACEHOLDER, date)
}

// --- git ---

/**
 * Initialize git with an initial commit unless `root` already is a repo
 * (mirrors Rust ensure_git_repo + git::init_repo). The legacy-identity
 * healing in the Rust path only applies to repos it initialized earlier,
 * which this fresh-init path can never encounter.
 */
function ensureGitRepo(root, runGit) {
  if (existsSync(path.join(root, '.git'))) return false

  runGit(['init'], root)
  ensureAuthorIdentity(root, runGit)
  runGit(['add', '.'], root)
  runGit(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial vault setup'], root)
  return true
}

/** Set a local fallback identity so the initial commit never fails. */
function ensureAuthorIdentity(root, runGit) {
  const fallbacks = [
    ['user.name', FALLBACK_AUTHOR_NAME],
    ['user.email', FALLBACK_AUTHOR_EMAIL],
  ]
  for (const [key, fallback] of fallbacks) {
    if (gitConfigValue(root, runGit, key)) continue
    runGit(['config', '--local', key, fallback], root)
  }
}

function gitConfigValue(root, runGit, key) {
  try {
    return runGit(['config', key], root).trim()
  } catch {
    // `git config <key>` exits non-zero when the key is unset.
    return ''
  }
}

function defaultRunGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// --- vaults.json registration ---

/**
 * Register the vault as a mounted `kind: "memory"` entry. The write goes
 * through the same normalize-everything round trip as the Rust
 * load_vault_list/save_vault_list pair so both sides produce identical JSON.
 */
function registerInVaultList(canonicalPath, configDir) {
  const list = loadVaultList(configDir)
  if (list.vaults.some(vault => vault.path === canonicalPath)) return false

  const vaults = [...list.vaults, memoryVaultEntry(canonicalPath)]
  saveVaultList({ ...list, vaults }, configDir)
  return true
}

function memoryVaultEntry(canonicalPath) {
  return {
    label: path.basename(canonicalPath) || 'Memory',
    path: canonicalPath,
    alias: null,
    shortLabel: null,
    color: null,
    icon: null,
    mounted: true,
    kind: 'memory',
  }
}

function loadVaultList(configDir) {
  const filePath = vaultsJsonPath(configDirOptions(configDir))
  if (!existsSync(filePath)) return normalizeVaultList({})
  return normalizeVaultList(JSON.parse(readFileSync(filePath, 'utf-8')))
}

function saveVaultList(list, configDir) {
  const filePath = preferredVaultsJsonPath(configDirOptions(configDir))
  mkdirSync(path.dirname(filePath), { recursive: true })
  // serde_json::to_string_pretty uses two-space indent and no trailing newline.
  writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf-8')
}

function configDirOptions(configDir) {
  return configDir ? { configDir } : {}
}

/** Mirror the Rust VaultList round trip: full field set, tildes expanded. */
function normalizeVaultList(raw) {
  return {
    vaults: (raw?.vaults ?? []).map(normalizeVaultEntry),
    active_vault: expandOptionalTilde(raw?.active_vault),
    default_workspace_path: expandOptionalTilde(raw?.default_workspace_path),
    hidden_defaults: (raw?.hidden_defaults ?? []).map(expandTilde),
  }
}

/** Field order matches the Rust VaultEntry serialization exactly. */
function normalizeVaultEntry(entry) {
  return {
    label: entry?.label ?? '',
    path: expandTilde(entry?.path ?? ''),
    alias: entry?.alias ?? null,
    shortLabel: entry?.shortLabel ?? null,
    color: entry?.color ?? null,
    icon: entry?.icon ?? null,
    mounted: entry?.mounted ?? null,
    kind: entry?.kind ?? 'notes',
  }
}

function expandOptionalTilde(value) {
  return typeof value === 'string' ? expandTilde(value) : null
}

// --- shared helpers ---

function canonicalPathString(root) {
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

function formatLocalDate(date) {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
