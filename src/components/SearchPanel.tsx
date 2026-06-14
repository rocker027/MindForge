import { createElement, forwardRef, useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { SearchResult, VaultEntry } from '../types'
import { useUnifiedSearch } from '../hooks/useUnifiedSearch'
import { getTypeColor, buildTypeEntryMap } from '../utils/typeColors'
import { formatSearchSubtitle } from '../utils/noteListHelpers'
import type { DateDisplayFormat } from '../utils/dateDisplay'
import { scrollSelectedHTMLChildIntoView } from '../utils/domScroll'
import { getTypeIcon } from './NoteItem'
import { NoteTitleIcon } from './NoteTitleIcon'
import { WorkspaceInitialsBadge } from './WorkspaceInitialsBadge'
import { useDateDisplayFormat } from '../hooks/useAppPreferences'
import { createTranslator, DEFAULT_APP_LOCALE, type AppLocale } from '../lib/i18n'
import type { VaultOption } from './status-bar/types'
import { useSearchKeyboard, useSearchSelectionRefs } from './search/searchKeyboard'
import { useMemorySearchPanel } from './search/useMemorySearchPanel'
import { SearchModeToggle } from './search/SearchModeToggle'
import { MemorySearchResults } from './search/MemorySearchResults'
import type { SearchMode } from './search/memorySearchAvailability'

interface SearchPanelProps {
  open: boolean
  vaultPath: string
  entries: VaultEntry[]
  /** Workspace list, used to detect a mounted memory vault for recall mode. */
  vaults?: readonly VaultOption[]
  locale?: AppLocale
  onSelectNote: (entry: VaultEntry) => void
  onClose: () => void
}

function searchVaultPathsForEntries(entries: VaultEntry[], fallbackVaultPath: string): string | string[] {
  const paths = entries
    .map((entry) => entry.workspace?.path)
    .filter((path): path is string => !!path)
  return paths.length > 0 ? [...new Set(paths)] : fallbackVaultPath
}

function shouldShowWorkspace(entries: VaultEntry[]): boolean {
  return new Set(entries.map((entry) => entry.workspace?.alias).filter(Boolean)).size > 1
}

function useSearchEntryData(entries: VaultEntry[]) {
  const typeEntryMap = useMemo(() => buildTypeEntryMap(entries), [entries])
  const entryLookup = useMemo(() => {
    const map = new Map<string, VaultEntry>()
    for (const e of entries) map.set(e.path, e)
    return map
  }, [entries])
  const showWorkspace = useMemo(() => shouldShowWorkspace(entries), [entries])

  return { entryLookup, showWorkspace, typeEntryMap }
}

function useSearchPanelController(
  { open, vaultPath, entries, onSelectNote, onClose }: SearchPanelProps,
  keyboardActive: boolean,
) {
  const searchVaultPaths = useMemo(() => searchVaultPathsForEntries(entries, vaultPath), [entries, vaultPath])
  const {
    query, setQuery, results, selectedIndex, setSelectedIndex, loading, elapsedMs,
  } = useUnifiedSearch(searchVaultPaths, open)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { resultsRef, selectedIndexRef } = useSearchSelectionRefs(results, selectedIndex)

  useEffect(() => {
    scrollSelectedHTMLChildIntoView(listRef.current, selectedIndex)
  }, [selectedIndex])

  const handleSelect = useCallback((result: SearchResult) => {
    const entry = entries.find(e => e.path === result.path)
    if (entry) {
      onSelectNote(entry)
      onClose()
    }
  }, [entries, onSelectNote, onClose])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  useSearchKeyboard({
    open: open && keyboardActive,
    onClose,
    handleSelect,
    resultsRef,
    selectedIndexRef,
    setSelectedIndex,
  })
  const entryData = useSearchEntryData(entries)

  return {
    elapsedMs,
    handleSelect,
    inputRef,
    listRef,
    loading,
    query,
    results,
    selectedIndex,
    setQuery,
    setSelectedIndex,
    ...entryData,
  }
}

/**
 * Mode state for the panel; resets to keyword after the panel closes. The reset
 * is deferred to a microtask so it runs while the panel is hidden (no flash) and
 * stays clear of synchronous setState inside an effect.
 */
function useSearchPanelMode(open: boolean): [SearchMode, (mode: SearchMode) => void] {
  const [mode, setMode] = useState<SearchMode>('keyword')
  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => setMode('keyword'), 0)
    return () => clearTimeout(timer)
  }, [open])
  return [mode, setMode]
}

function useRootOverlayDismiss(
  open: boolean,
  rootRef: React.RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return
    const root = rootRef.current
    if (!root) return

    const handleRootClick = (event: MouseEvent) => {
      if (event.target === root) onClose()
    }

    root.addEventListener('click', handleRootClick)
    return () => root.removeEventListener('click', handleRootClick)
  }, [open, onClose, rootRef])
}

export function SearchPanel({
  open,
  vaultPath,
  entries,
  vaults = [],
  locale = DEFAULT_APP_LOCALE,
  onSelectNote,
  onClose,
}: SearchPanelProps) {
  const t = createTranslator(locale)
  const rootRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useSearchPanelMode(open)
  const keyword = useSearchPanelController(
    { open, vaultPath, entries, vaults, locale, onSelectNote, onClose },
    mode === 'keyword',
  )
  const { inputRef, query, setQuery, loading: keywordLoading } = keyword
  const memory = useMemorySearchPanel({ open, mode, query, vaults, onSelectNote, onClose })
  useRootOverlayDismiss(open, rootRef, onClose)

  if (!open) return null

  const isMemoryMode = mode === 'memory'

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[1000] flex justify-center bg-[var(--shadow-dialog)] pt-[15vh]"
    >
      <button
        type="button"
        aria-label="Close search"
        className="absolute inset-0 z-0 cursor-default border-0 bg-transparent p-0"
        onClick={onClose}
      />
      <div
        className="relative z-10 flex w-[540px] max-w-[90vw] max-h-[480px] flex-col self-start overflow-hidden rounded-xl border border-[var(--border-dialog)] bg-popover shadow-[0_8px_32px_var(--shadow-dialog)]"
      >
        <SearchInput
          ref={inputRef}
          query={query}
          loading={isMemoryMode ? memory.loading : keywordLoading}
          placeholder={isMemoryMode ? t('memorySearch.placeholder') : 'Search in all notes...'}
          onChange={setQuery}
        />
        {memory.available && <SearchModeToggle mode={mode} onModeChange={setMode} t={t} />}
        {isMemoryMode
          ? (
            <MemorySearchResults
              hits={memory.hits}
              query={query}
              loading={memory.loading}
              unavailable={memory.unavailable}
              selectedIndex={memory.selectedIndex}
              listRef={memory.listRef}
              onSelect={memory.handleSelectHit}
              onHover={memory.setSelectedIndex}
              t={t}
            />
          )
          : <KeywordSearchResults controller={keyword} />}
      </div>
    </div>
  )
}

/** Keyword result surface; isolates hover handling so the shell stays thin. */
function KeywordSearchResults({ controller }: { controller: ReturnType<typeof useSearchPanelController> }) {
  const dateDisplayFormat = useDateDisplayFormat()
  const { setSelectedIndex } = controller
  const handleResultHover = useCallback((index: number, event: React.MouseEvent<HTMLDivElement>) => {
    if (shouldApplySearchResultHover(event)) setSelectedIndex(index)
  }, [setSelectedIndex])

  return (
    <SearchContent
      query={controller.query}
      results={controller.results}
      selectedIndex={controller.selectedIndex}
      loading={controller.loading}
      elapsedMs={controller.elapsedMs}
      entryLookup={controller.entryLookup}
      typeEntryMap={controller.typeEntryMap}
      showWorkspace={controller.showWorkspace}
      dateDisplayFormat={dateDisplayFormat}
      listRef={controller.listRef}
      onSelect={controller.handleSelect}
      onHover={handleResultHover}
    />
  )
}

interface SearchInputProps {
  query: string
  loading: boolean
  placeholder?: string
  onChange: (value: string) => void
}

const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput({ query, loading, placeholder = 'Search in all notes...', onChange }, ref) {
    return (
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          ref={ref}
          className="flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={e => onChange(e.target.value)}
        />
        {loading && (
          <svg
            aria-hidden="true"
            className="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
            data-testid="search-spinner"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
      </div>
    )
  },
)

interface SearchContentProps {
  query: string
  results: SearchResult[]
  selectedIndex: number
  loading: boolean
  elapsedMs: number | null
  entryLookup: Map<string, VaultEntry>
  typeEntryMap: Record<string, VaultEntry>
  showWorkspace: boolean
  dateDisplayFormat: DateDisplayFormat
  listRef: React.RefObject<HTMLDivElement | null>
  onSelect: (result: SearchResult) => void
  onHover: (index: number, event: React.MouseEvent<HTMLDivElement>) => void
}

interface SearchResultRowProps {
  result: SearchResult
  entry: VaultEntry | undefined
  selected: boolean
  index: number
  typeEntryMap: Record<string, VaultEntry>
  showWorkspace: boolean
  dateDisplayFormat: DateDisplayFormat
  onSelect: (result: SearchResult) => void
  onHover: (index: number, event: React.MouseEvent<HTMLDivElement>) => void
}

interface SearchResultPresentation {
  TypeIcon: ReturnType<typeof getTypeIcon>
  icon?: string | null
  noteType: string | null
  subtitle: string | null
  title: string
  typeColor?: string
  workspace: VaultEntry['workspace'] | null
}

function resolveSearchResultPresentation({
  result,
  entry,
  typeEntryMap,
  showWorkspace,
  dateDisplayFormat,
}: Pick<SearchResultRowProps, 'result' | 'entry' | 'typeEntryMap' | 'showWorkspace' | 'dateDisplayFormat'>): SearchResultPresentation {
  const isA = entry?.isA ?? result.noteType
  const noteType = isA || null
  const typeEntry = typeEntryMap[isA ?? '']

  return {
    TypeIcon: getTypeIcon(isA ?? null, typeEntry?.icon),
    icon: entry?.icon,
    noteType,
    subtitle: entry ? formatSearchSubtitle(entry, dateDisplayFormat) : null,
    title: entry?.title ?? result.title,
    typeColor: resolveSearchResultTypeColor(noteType, isA, typeEntry),
    workspace: resolveSearchResultWorkspace(showWorkspace, entry),
  }
}

function resolveSearchResultTypeColor(
  noteType: string | null,
  isA: string | null,
  typeEntry: VaultEntry | undefined,
): string | undefined {
  return noteType ? getTypeColor(isA, typeEntry?.color) : undefined
}

function resolveSearchResultWorkspace(showWorkspace: boolean, entry: VaultEntry | undefined): VaultEntry['workspace'] | null {
  return showWorkspace ? entry?.workspace ?? null : null
}

function SearchResultRow({
  result, entry, selected, index, typeEntryMap, showWorkspace, dateDisplayFormat, onSelect, onHover,
}: SearchResultRowProps) {
  const presentation = resolveSearchResultPresentation({
    result,
    entry,
    typeEntryMap,
    showWorkspace,
    dateDisplayFormat,
  })

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      className={cn(
        "w-full cursor-pointer border-0 bg-transparent px-4 py-2.5 text-left transition-colors",
        selected ? "bg-accent" : "hover:bg-secondary",
      )}
      onClick={() => onSelect(result)}
      onMouseMove={(event) => onHover(index, event)}
    >
      <div className="flex items-center gap-2">
        {createElement(presentation.TypeIcon, {
          width: 14,
          height: 14,
          className: 'shrink-0',
          style: { color: presentation.typeColor ?? 'var(--muted-foreground)' },
        })}
        <SearchResultTitle icon={presentation.icon} title={presentation.title} />
        <SearchResultTypeLabel noteType={presentation.noteType} />
        <WorkspaceInitialsBadge workspace={presentation.workspace} testId="search-result-workspace-badge" />
      </div>
      <SearchResultSubtitle subtitle={presentation.subtitle} />
    </div>
  )
}

function SearchResultTitle({ icon, title }: { icon?: string | null; title: string }) {
  return (
    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
      <NoteTitleIcon icon={icon} size={14} className="mr-1" />
      {title}
    </span>
  )
}

function SearchResultTypeLabel({ noteType }: { noteType: string | null }) {
  return noteType ? <span className="shrink-0 text-[11px] text-muted-foreground/70">{noteType}</span> : null
}

function SearchResultSubtitle({ subtitle }: { subtitle: string | null }) {
  return subtitle ? <p className="mt-0.5 pl-[22px] text-[11px] text-muted-foreground">{subtitle}</p> : null
}

function SearchIdleMessage() {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-[13px] text-muted-foreground">Search across all note contents</p>
      <p className="mt-1 text-[11px] text-muted-foreground/60">Enter to open · Esc to close</p>
    </div>
  )
}

function SearchLoadingMessage() {
  return <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">Searching...</div>
}

function SearchNoResultsMessage() {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-[13px] text-muted-foreground">No results found</p>
    </div>
  )
}

function SearchResultsHeader({ count, elapsedMs }: { count: number; elapsedMs: number | null }) {
  return (
    <div className="border-b border-border/50 px-4 py-1.5">
      <span className="text-[11px] text-muted-foreground">
        {count} result{count !== 1 ? 's' : ''}{elapsedMs !== null ? ` · ${elapsedMs}ms` : ''}
      </span>
    </div>
  )
}

function SearchContent({
  query, results, selectedIndex, loading, elapsedMs, entryLookup, typeEntryMap, showWorkspace, dateDisplayFormat, listRef, onSelect, onHover,
}: SearchContentProps) {
  const hasQuery = query.trim().length > 0
  const hasResults = results.length > 0
  return (
    <div className="flex-1 overflow-y-auto">
      {!hasQuery && <SearchIdleMessage />}
      {hasQuery && !hasResults && loading && <SearchLoadingMessage />}
      {hasQuery && !hasResults && !loading && <SearchNoResultsMessage />}
      {hasResults && (
        <>
          <SearchResultsHeader count={results.length} elapsedMs={elapsedMs} />
          <div ref={listRef} role="listbox" aria-label="Search results">
            {results.map((result, i) => (
              <SearchResultRow
                key={result.path}
                result={result}
                entry={entryLookup.get(result.path)}
                selected={i === selectedIndex}
                index={i}
                typeEntryMap={typeEntryMap}
                showWorkspace={showWorkspace}
                dateDisplayFormat={dateDisplayFormat}
                onSelect={onSelect}
                onHover={onHover}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function shouldApplySearchResultHover(event: React.MouseEvent<HTMLDivElement>): boolean {
  return event.movementX !== 0 || event.movementY !== 0
}
