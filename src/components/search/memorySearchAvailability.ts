import type { VaultOption } from '../status-bar/types'
import { getMemoryCollectionAlias, isMountedMemoryVault } from '../../lib/memoryIndex'
import { findMemoryVault } from '../memory/memoryVaultPresence'

export type SearchMode = 'keyword' | 'memory'

/** Resolved memory-recall target: the mounted vault and its qmd collection alias. */
export interface MemorySearchTarget {
  vaultPath: string
  collection: string
}

/**
 * Resolve the memory-search target when one is available.
 *
 * Memory recall is offered only when qmd is installed *and* a mounted memory
 * vault exists (ADR-0140/0141). Otherwise the panel stays keyword-only and the
 * mode toggle is hidden, keeping behaviour identical to the pre-memory build.
 */
export function resolveMemorySearchTarget(
  vaults: readonly VaultOption[],
  qmdInstalled: boolean,
): MemorySearchTarget | null {
  if (!qmdInstalled) return null
  const memoryVault = findMemoryVault(vaults)
  if (!memoryVault || !isMountedMemoryVault(memoryVault)) return null

  return {
    vaultPath: memoryVault.path,
    collection: getMemoryCollectionAlias({ alias: memoryVault.alias ?? null }),
  }
}
