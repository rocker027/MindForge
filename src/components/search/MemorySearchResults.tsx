import { Brain } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import type { MemoryHit } from '../../hooks/useMemorySearch'
import type { createTranslator } from '../../lib/i18n'

interface MemorySearchResultsProps {
  hits: MemoryHit[]
  query: string
  loading: boolean
  unavailable: boolean
  selectedIndex: number
  listRef: React.RefObject<HTMLDivElement | null>
  onSelect: (hit: MemoryHit) => void
  onHover: (index: number) => void
  t: ReturnType<typeof createTranslator>
}

function MemoryIdleMessage({ t }: { t: MemorySearchResultsProps['t'] }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-[13px] text-muted-foreground">{t('memorySearch.idleTitle')}</p>
      <p className="mt-1 text-[11px] text-muted-foreground/60">{t('memorySearch.idleHint')}</p>
    </div>
  )
}

function MemoryEmptyMessage({ message }: { message: string }) {
  return <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">{message}</div>
}

function MemoryUnavailableMessage({ t }: { t: MemorySearchResultsProps['t'] }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-[13px] text-muted-foreground">{t('memorySearch.unavailableTitle')}</p>
      <p className="mt-1 text-[11px] text-muted-foreground/60">{t('memorySearch.unavailableHint')}</p>
    </div>
  )
}

function MemoryHitRow({
  hit, selected, index, onSelect, onHover,
}: {
  hit: MemoryHit
  selected: boolean
  index: number
  onSelect: (hit: MemoryHit) => void
  onHover: (index: number) => void
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      className={cn(
        'w-full cursor-pointer border-0 bg-transparent px-4 py-2.5 text-left transition-colors',
        selected ? 'bg-accent' : 'hover:bg-secondary',
      )}
      onClick={() => onSelect(hit)}
      onMouseMove={() => onHover(index)}
    >
      <div className="flex items-center gap-2">
        <Brain size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{hit.title}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">{hit.score.toFixed(2)}</span>
      </div>
      {hit.snippet ? <p className="mt-0.5 line-clamp-2 pl-[22px] text-[11px] text-muted-foreground">{hit.snippet}</p> : null}
    </div>
  )
}

/** Result surface for memory recall: idle/loading/empty/unavailable states plus the hit list. */
export function MemorySearchResults({
  hits, query, loading, unavailable, selectedIndex, listRef, onSelect, onHover, t,
}: MemorySearchResultsProps) {
  const hasQuery = query.trim().length > 0
  const hasHits = hits.length > 0

  return (
    <div className="flex-1 overflow-y-auto">
      {!hasQuery && !unavailable && <MemoryIdleMessage t={t} />}
      {unavailable && <MemoryUnavailableMessage t={t} />}
      {hasQuery && !unavailable && !hasHits && loading && (
        <MemoryEmptyMessage message={t('memorySearch.searching')} />
      )}
      {hasQuery && !unavailable && !hasHits && !loading && (
        <MemoryEmptyMessage message={t('memorySearch.noResults')} />
      )}
      {hasHits && !unavailable && (
        <div ref={listRef} role="listbox" aria-label={t('memorySearch.modeMemory')}>
          {hits.map((hit, index) => (
            <MemoryHitRow
              key={hit.path}
              hit={hit}
              selected={index === selectedIndex}
              index={index}
              onSelect={onSelect}
              onHover={onHover}
            />
          ))}
        </div>
      )}
    </div>
  )
}
