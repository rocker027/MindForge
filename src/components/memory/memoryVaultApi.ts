import { invoke } from '@tauri-apps/api/core'
import { isTauri, mockInvoke } from '../../mock-tauri'

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
