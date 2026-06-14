import type { VaultOption } from '../status-bar/types'

/** Workspace kind marking an LLM memory vault (ADR-0140). */
export const MEMORY_VAULT_KIND = 'memory'

/** Default location offered when creating a memory vault. */
export const DEFAULT_MEMORY_VAULT_PATH = '~/MemoryVault'

/**
 * Find the first configured memory vault among the workspace list.
 *
 * A vault is a memory vault when its `kind` is "memory" (ADR-0140). Returns
 * `null` when none exist, which drives the onboarding-vs-status branch.
 */
export function findMemoryVault(vaults: readonly VaultOption[]): VaultOption | null {
  return vaults.find((vault) => vault.kind === MEMORY_VAULT_KIND) ?? null
}

export function hasMemoryVault(vaults: readonly VaultOption[]): boolean {
  return findMemoryVault(vaults) !== null
}
