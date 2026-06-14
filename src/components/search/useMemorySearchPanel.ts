import { useCallback, useEffect, useRef, useState } from 'react'
import type { VaultEntry } from '../../types'
import type { VaultOption } from '../status-bar/types'
import { getQmdStatus } from '../memory/memoryVaultApi'
import { trackMemorySearchUsed } from '../../lib/productAnalytics'
import { type MemoryHit, useMemorySearch } from '../../hooks/useMemorySearch'
import { scrollSelectedHTMLChildIntoView } from '../../utils/domScroll'
import { useSearchKeyboard, useSearchSelectionRefs } from './searchKeyboard'
import { resolveMemorySearchTarget, type MemorySearchTarget, type SearchMode } from './memorySearchAvailability'
import { memoryHitToEntry } from './openMemoryHit'

interface MemorySearchPanelOptions {
  open: boolean
  mode: SearchMode
  query: string
  vaults: readonly VaultOption[]
  onSelectNote: (entry: VaultEntry) => void
  onClose: () => void
}

/** Probe qmd availability whenever the panel opens; absence is the default. */
function useQmdInstalled(open: boolean): boolean {
  const [installed, setInstalled] = useState(false)
  useEffect(() => {
    if (!open) return
    let active = true
    getQmdStatus()
      .then((status) => { if (active) setInstalled(status.installed) })
      .catch(() => { if (active) setInstalled(false) })
    return () => { active = false }
  }, [open])
  return installed
}

function useMemoryHitSelection(target: MemorySearchTarget | null, options: MemorySearchPanelOptions) {
  const { onSelectNote, onClose } = options
  return useCallback((hit: MemoryHit) => {
    if (!target) return
    onSelectNote(memoryHitToEntry(hit, target.vaultPath))
    onClose()
  }, [onClose, onSelectNote, target])
}

/**
 * Drives the memory-recall side of the search panel: qmd detection, target
 * resolution, debounced recall, and keyboard/scroll handling. Returns
 * `available: false` whenever qmd or a mounted memory vault is missing, which
 * keeps the panel keyword-only and behaviourally identical to before.
 */
export function useMemorySearchPanel(options: MemorySearchPanelOptions) {
  const { open, mode, query, vaults } = options
  const qmdInstalled = useQmdInstalled(open)
  const target = resolveMemorySearchTarget(vaults, qmdInstalled)
  const isMemoryMode = mode === 'memory' && target !== null

  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const handleSelectHit = useMemoryHitSelection(target, options)

  // Reset the highlighted row and emit analytics as each new result lands;
  // both run from the hook's async resolution, never a synchronous effect.
  const handleResults = useCallback((hitCount: number) => {
    setSelectedIndex(0)
    trackMemorySearchUsed(hitCount)
  }, [])

  const { hits, loading, unavailable } = useMemorySearch({
    collection: target?.collection ?? null,
    query,
    enabled: open && isMemoryMode,
    onResults: handleResults,
  })

  useEffect(() => {
    scrollSelectedHTMLChildIntoView(listRef.current, selectedIndex)
  }, [selectedIndex])

  const { resultsRef, selectedIndexRef } = useSearchSelectionRefs(hits, selectedIndex)
  useSearchKeyboard<MemoryHit>({
    open: open && isMemoryMode,
    onClose: options.onClose,
    handleSelect: handleSelectHit,
    resultsRef,
    selectedIndexRef,
    setSelectedIndex,
  })

  return {
    available: target !== null,
    isMemoryMode,
    hits,
    loading,
    unavailable,
    selectedIndex,
    setSelectedIndex,
    listRef,
    handleSelectHit,
  }
}
