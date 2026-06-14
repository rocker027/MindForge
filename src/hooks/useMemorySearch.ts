import { useState, useRef, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, mockInvoke } from '../mock-tauri'

/** One hit from `qmd_memory_query`. `path` is relative to the memory vault. */
export interface MemoryHit {
  path: string
  title: string
  score: number
  snippet: string
}

/** Mirror of the Rust `QmdQueryResponse`. `available: false` means qmd is absent. */
interface MemoryQueryResponse {
  available: boolean
  hits: MemoryHit[]
}

const DEBOUNCE_MS = 300
const DEFAULT_LIMIT = 20

function memoryQueryCall(args: Record<string, unknown>): Promise<MemoryQueryResponse> {
  return isTauri()
    ? invoke<MemoryQueryResponse>('qmd_memory_query', args)
    : mockInvoke<MemoryQueryResponse>('qmd_memory_query', args)
}

interface MemorySearchOptions {
  /** qmd collection alias for the active memory vault. */
  collection: string | null
  query: string
  /** When false the search is dormant: no calls, no pending timers. */
  enabled: boolean
  onResults?: (hitCount: number) => void
}

export interface MemorySearchState {
  hits: MemoryHit[]
  loading: boolean
  /** True once a query resolves with qmd reporting itself unavailable. */
  unavailable: boolean
}

const IDLE_STATE: MemorySearchState = { hits: [], loading: false, unavailable: false }

/** Stable identity for a search request; null when no search should run. */
function searchKey(enabled: boolean, collection: string | null, query: string): string | null {
  const trimmed = query.trim()
  if (!enabled || !collection || !trimmed) return null
  return `${collection} ${trimmed}`
}

interface ResolvedSearch extends MemorySearchState {
  /** The key this result belongs to, so stale results never render. */
  key: string
}

/**
 * Debounced memory recall against a qmd collection. State is only mutated from
 * the async resolution path (never synchronously inside an effect), and the
 * visible state is derived from whether the resolved result matches the current
 * request key — so disabling or clearing the query yields idle without a
 * cascading setState. Mirrors the generation discipline of {@link useUnifiedSearch}.
 */
export function useMemorySearch({ collection, query, enabled, onResults }: MemorySearchOptions): MemorySearchState {
  const key = searchKey(enabled, collection, query)
  const [resolved, setResolved] = useState<ResolvedSearch | null>(null)
  const searchGenRef = useRef(0)
  const onResultsRef = useRef(onResults)
  useEffect(() => { onResultsRef.current = onResults })

  const runSearch = useCallback(async (activeKey: string, activeCollection: string, trimmedQuery: string) => {
    searchGenRef.current++
    const gen = searchGenRef.current
    try {
      const response = await memoryQueryCall({ query: trimmedQuery, collection: activeCollection, limit: DEFAULT_LIMIT })
      if (gen !== searchGenRef.current) return
      const hits = response.available ? response.hits : []
      setResolved({ key: activeKey, hits, loading: false, unavailable: !response.available })
      onResultsRef.current?.(hits.length)
    } catch {
      if (gen !== searchGenRef.current) return
      setResolved({ key: activeKey, hits: [], loading: false, unavailable: false })
    }
  }, [])

  useEffect(() => {
    if (!key || !collection) {
      searchGenRef.current++
      return
    }
    const trimmed = query.trim()
    const timer = setTimeout(() => { void runSearch(key, collection, trimmed) }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [collection, key, query, runSearch])

  return deriveMemorySearchState(key, resolved)
}

/**
 * Idle when no request is active; otherwise the resolved result when it matches
 * the live key, or a loading placeholder while the newest request is in flight.
 */
function deriveMemorySearchState(key: string | null, resolved: ResolvedSearch | null): MemorySearchState {
  if (!key) return IDLE_STATE
  if (resolved && resolved.key === key) {
    return { hits: resolved.hits, loading: false, unavailable: resolved.unavailable }
  }
  return { hits: [], loading: true, unavailable: false }
}
