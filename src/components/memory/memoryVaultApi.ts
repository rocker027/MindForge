import { invoke } from '@tauri-apps/api/core'
import { isTauri, mockInvoke } from '../../mock-tauri'
import type { VaultEntry } from '../../types'
import { normalizeNotePathSeparators } from '../../utils/notePathIdentity'

/** Mirror of the Rust `MemoryVaultScaffoldReport` (serde camelCase). */
export interface MemoryVaultScaffoldReport {
  path: string
  createdFiles: string[]
  skippedFiles: string[]
  gitInitialized: boolean
  registered: boolean
}

/** Mirror of the Rust `QmdStatus`. `installed: false` means qmd is absent. */
export interface QmdStatusReport {
  installed: boolean
  version: string | null
}

/** A single unprocessed source waiting under the memory vault's `raw/inbox/`. */
export interface MemoryInboxSource {
  /** Vault-relative path, e.g. `raw/inbox/notes.md`. Stable identity for list keys. */
  relativePath: string
  /** Display filename, e.g. `notes.md`. */
  name: string
}

/** Folder prefix (vault-relative) that holds sources awaiting ingestion. */
const INBOX_PREFIX = 'raw/inbox/'

/** Vault-relative path of the lint report the lint agent overwrites each run. */
const LINT_REPORT_RELATIVE_PATH = 'wiki/lint-report.md'

function tauriCall<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return isTauri() ? invoke<T>(command, args) : mockInvoke<T>(command, args)
}

/** Scaffold (idempotent) and mount a memory vault at `path`. */
export function scaffoldMemoryVault(path: string): Promise<MemoryVaultScaffoldReport> {
  return tauriCall<MemoryVaultScaffoldReport>('scaffold_memory_vault', { path })
}

/** Probe whether the external qmd CLI is installed for semantic recall. */
export function getQmdStatus(): Promise<QmdStatusReport> {
  return tauriCall<QmdStatusReport>('qmd_status', {})
}

/**
 * Rescan a vault from disk via the existing `reload_vault` command. Composing on
 * top of it keeps inbox listing free of any new Rust surface (ADR-0142).
 */
export function reloadVault(path: string): Promise<VaultEntry[]> {
  return tauriCall<VaultEntry[]>('reload_vault', { path })
}

/** Build the `raw/inbox/`-relative prefix used to detect inbox sources. */
function inboxPrefixFor(vaultPath: string): string {
  const root = normalizeNotePathSeparators(vaultPath).replace(/\/+$/u, '')
  return `${root}/${INBOX_PREFIX}`
}

/** Strip the vault root + `raw/inbox/` prefix, returning the vault-relative path. */
function toInboxSource(entryPath: string, vaultPrefix: string): MemoryInboxSource | null {
  const normalized = normalizeNotePathSeparators(entryPath)
  if (!normalized.startsWith(vaultPrefix)) return null
  const inboxRelative = normalized.slice(vaultPrefix.length)
  if (inboxRelative.length === 0) return null
  const name = inboxRelative.split('/').pop() ?? inboxRelative
  return { relativePath: `${INBOX_PREFIX}${inboxRelative}`, name }
}

/**
 * List unprocessed sources under the memory vault's `raw/inbox/`. Rescans the
 * vault, then keeps only entries whose vault-relative path lives in the inbox.
 * Results are sorted by relative path so the list order is deterministic.
 */
export async function listMemoryInboxSources(vaultPath: string): Promise<MemoryInboxSource[]> {
  const entries = await reloadVault(vaultPath)
  const vaultPrefix = inboxPrefixFor(vaultPath)
  return entries
    .map((entry) => toInboxSource(entry.path, vaultPrefix))
    .filter((source): source is MemoryInboxSource => source !== null)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

/** Build the absolute path of the vault's lint report from its root. */
function lintReportPathFor(vaultPath: string): string {
  const root = normalizeNotePathSeparators(vaultPath).replace(/\/+$/u, '')
  return `${root}/${LINT_REPORT_RELATIVE_PATH}`
}

/**
 * Read the free-form markdown lint report the lint agent writes to
 * `wiki/lint-report.md`. Composes on the existing `get_note_content` command
 * (scoped to the vault root) so no new Rust surface is added (ADR-0142).
 * Returns `null` when no report exists yet, so callers can show a "not run"
 * state instead of surfacing a missing-file error.
 */
export async function readMemoryLintReport(vaultPath: string): Promise<string | null> {
  const path = lintReportPathFor(vaultPath)
  try {
    const content = await tauriCall<string>('get_note_content', { path, vaultPath })
    return content.trim().length > 0 ? content : null
  } catch {
    return null
  }
}
