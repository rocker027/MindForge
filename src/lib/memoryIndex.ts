import { invoke } from '@tauri-apps/api/core'
import { isTauri, mockInvoke } from '../mock-tauri'

/** Workspace kind marking an LLM memory vault (ADR-0140). */
const MEMORY_VAULT_KIND = 'memory'
const MEMORY_COLLECTION_PREFIX = 'tolaria-'
const DEFAULT_MEMORY_COLLECTION = 'tolaria-memory'
/** Trailing debounce so bursts of sync events collapse into one qmd refresh. */
export const MEMORY_INDEX_REFRESH_DEBOUNCE_MS = 30_000

function tauriCall<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return isTauri() ? invoke<T>(command, args) : mockInvoke<T>(command, args)
}

export interface MemoryVaultEntry {
  path: string
  alias?: string | null
  mounted?: boolean | null
  kind?: string | null
}

/** Mirror of the Rust `QmdIndexReport`. `available: false` means qmd is not installed. */
export interface MemoryIndexReport {
  available: boolean
  collectionCreated: boolean
  indexed: boolean
}

/** qmd collection naming convention: "tolaria-" + vault alias, or "tolaria-memory". */
export function getMemoryCollectionAlias(entry: Pick<MemoryVaultEntry, 'alias'>): string {
  const alias = entry.alias?.trim()
  return alias ? `${MEMORY_COLLECTION_PREFIX}${alias}` : DEFAULT_MEMORY_COLLECTION
}

export function isMountedMemoryVault(entry: Pick<MemoryVaultEntry, 'kind' | 'mounted'>): boolean {
  return entry.kind === MEMORY_VAULT_KIND && entry.mounted !== false
}

/**
 * Register the vault as a qmd collection (idempotent) and refresh its index.
 * qmd being absent is a supported state (`available: false`), never an error;
 * real failures are logged and swallowed so callers never block on indexing.
 */
export async function ensureMemoryIndex(
  vaultPath: string,
  collection: string,
): Promise<MemoryIndexReport | null> {
  try {
    return await tauriCall<MemoryIndexReport>('qmd_update_index', { vaultPath, collection })
  } catch (error) {
    console.warn('[memory-index] Failed to refresh qmd index:', error)
    return null
  }
}

async function loadMountedMemoryVaults(): Promise<MemoryVaultEntry[]> {
  try {
    const list = await tauriCall<{ vaults?: MemoryVaultEntry[] }>('load_vault_list', {})
    return (list.vaults ?? []).filter(isMountedMemoryVault)
  } catch (error) {
    console.warn('[memory-index] Failed to load vault list:', error)
    return []
  }
}

/** Refresh the qmd index of every mounted memory vault. No-op when none exist. */
export async function refreshMountedMemoryIndexes(): Promise<void> {
  const memoryVaults = await loadMountedMemoryVaults()
  await Promise.all(memoryVaults.map((entry) => (
    ensureMemoryIndex(entry.path, getMemoryCollectionAlias(entry))
  )))
}

export interface MemoryIndexScheduler {
  schedule: () => void
  cancel: () => void
}

interface MemoryIndexSchedulerOptions {
  delayMs?: number
  refresh?: () => Promise<void>
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void
}

/**
 * Trailing-debounce scheduler: repeated `schedule()` calls within the delay
 * window collapse into a single background refresh. Timers are injectable
 * for deterministic tests.
 */
export function createMemoryIndexScheduler(
  options: MemoryIndexSchedulerOptions = {},
): MemoryIndexScheduler {
  const {
    delayMs = MEMORY_INDEX_REFRESH_DEBOUNCE_MS,
    refresh = refreshMountedMemoryIndexes,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (id) => clearTimeout(id),
  } = options
  let pendingTimer: ReturnType<typeof setTimeout> | null = null

  const cancel = () => {
    if (pendingTimer === null) return
    clearTimer(pendingTimer)
    pendingTimer = null
  }

  const schedule = () => {
    cancel()
    pendingTimer = setTimer(() => {
      pendingTimer = null
      void refresh()
    }, delayMs)
  }

  return { schedule, cancel }
}

const defaultScheduler = createMemoryIndexScheduler()

/**
 * Debounced entry point for sync hooks: call after a successful git pull/push
 * to keep memory-vault qmd indexes fresh without blocking the UI.
 */
export function scheduleMemoryIndexRefresh(): void {
  defaultScheduler.schedule()
}
