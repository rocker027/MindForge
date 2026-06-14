import { Brain, MagnifyingGlass } from '@phosphor-icons/react'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import type { createTranslator } from '../../lib/i18n'
import type { SearchMode } from './memorySearchAvailability'

interface SearchModeToggleProps {
  mode: SearchMode
  onModeChange: (mode: SearchMode) => void
  t: ReturnType<typeof createTranslator>
}

/**
 * Keyword/Memory mode switch, shown only when qmd-backed memory recall is
 * available for the current vault set. shadcn `ToggleGroup` keeps it native to
 * the app and keyboard-operable (ADR-0020).
 */
export function SearchModeToggle({ mode, onModeChange, t }: SearchModeToggleProps) {
  const handleValueChange = (value: string) => {
    if (value === 'keyword' || value === 'memory') onModeChange(value)
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={handleValueChange}
        aria-label={t('memorySearch.modeKeyword')}
      >
        <ToggleGroupItem value="keyword">
          <MagnifyingGlass size={13} aria-hidden="true" />
          {t('memorySearch.modeKeyword')}
        </ToggleGroupItem>
        <ToggleGroupItem value="memory">
          <Brain size={13} aria-hidden="true" />
          {t('memorySearch.modeMemory')}
        </ToggleGroupItem>
      </ToggleGroup>
      <span className="truncate text-[11px] text-muted-foreground">
        {mode === 'memory' ? t('memorySearch.modeMemoryHint') : t('memorySearch.modeKeywordHint')}
      </span>
    </div>
  )
}
