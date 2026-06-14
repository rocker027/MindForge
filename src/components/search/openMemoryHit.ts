import type { VaultEntry } from '../../types'
import type { MemoryHit } from '../../hooks/useMemorySearch'
import { joinVaultPath, vaultRelativePathLabel } from '../../utils/notePathIdentity'

/**
 * Build a minimal {@link VaultEntry} for a memory hit so it can be opened
 * through the regular note-open path.
 *
 * qmd returns vault-relative paths; we join them onto the memory vault root to
 * get an absolute path. `onSelectNote` normalizes the partial entry and loads
 * the note content from disk, so only `path`, `filename`, `title` and `snippet`
 * need to be supplied here.
 */
export function memoryHitToEntry(hit: MemoryHit, vaultPath: string): VaultEntry {
  const absolutePath = joinVaultPath(vaultPath, hit.path)
  const filename = vaultRelativePathLabel(hit.path)
  return {
    path: absolutePath,
    filename,
    title: hit.title.trim() || filename,
    snippet: hit.snippet,
  } as VaultEntry
}
