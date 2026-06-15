import { ArrowClockwise, Tray } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_AI_AGENT } from '../../lib/aiAgents'
import { createTranslator, type AppLocale } from '../../lib/i18n'
import { trackMemoryInboxIngestStarted } from '../../lib/productAnalytics'
import type { VaultOption } from '../status-bar/types'
import { streamAiAgent } from '../../utils/streamAiAgent'
import { Button } from '../ui/button'
import {
  listMemoryInboxSources as defaultListInboxSources,
  type MemoryInboxSource,
} from './memoryVaultApi'

type Translate = ReturnType<typeof createTranslator>

/** Stable status machine for an ingest run; drives the banner and button state. */
type IngestStatus = 'idle' | 'running' | 'done' | 'error'

interface MemoryInboxProps {
  locale: AppLocale
  /** The configured memory vault (kind === 'memory'); supplies the real root path. */
  vault: VaultOption
  /** Injectable for tests so listing never touches a live Tauri command. */
  listInboxSources?: typeof defaultListInboxSources
  /** Injectable for tests so ingest never spawns a live agent. */
  streamAgent?: typeof streamAiAgent
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Build the ingest instruction. The agent runs inside the vault root, so it
 * follows the vault's own AGENTS.md `## Ingest workflow` rather than receiving
 * the steps inline — keeping a single source of truth for the protocol.
 */
function buildIngestPrompt(): string {
  return (
    'Ingest every unprocessed source under raw/inbox/ into this memory vault. ' +
    'Follow the "## Ingest workflow" section of AGENTS.md in this vault exactly: ' +
    'read each source fully, write or extend the matching wiki page with cited ' +
    'claims, update wiki/index.md, fix cross-references, move each source from ' +
    'raw/inbox/ to its dated home under raw/, and append an ingest entry to ' +
    'wiki/log.md. Obey every rule in the "## Safety rules" section.'
  )
}

interface InboxState {
  sources: MemoryInboxSource[]
  loadError: string | null
}

/**
 * Inbox ingest panel for a configured memory vault (ADR-0142, Task 4.1).
 *
 * Lists unprocessed sources under `raw/inbox/` and lets the user kick off an
 * ingest run through the existing CLI-agent streaming flow. It re-lists the
 * inbox once a run finishes so the queue reflects the moved sources.
 */
export function MemoryInbox({
  locale,
  vault,
  listInboxSources = defaultListInboxSources,
  streamAgent = streamAiAgent,
}: MemoryInboxProps) {
  const t = createTranslator(locale)
  const [state, setState] = useState<InboxState>({ sources: [], loadError: null })
  const [status, setStatus] = useState<IngestStatus>('idle')
  const [ingestError, setIngestError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const sources = await listInboxSources(vault.path)
      setState({ sources, loadError: null })
    } catch (error) {
      setState({ sources: [], loadError: toErrorMessage(error) })
    }
  }, [listInboxSources, vault.path])

  useEffect(() => {
    let active = true
    listInboxSources(vault.path)
      .then((sources) => { if (active) setState({ sources, loadError: null }) })
      .catch((error) => { if (active) setState({ sources: [], loadError: toErrorMessage(error) }) })
    return () => { active = false }
  }, [listInboxSources, vault.path])

  const handleIngest = useCallback(async () => {
    setStatus('running')
    setIngestError(null)
    trackMemoryInboxIngestStarted(state.sources.length)
    let failure: string | null = null
    await streamAgent({
      agent: DEFAULT_AI_AGENT,
      message: buildIngestPrompt(),
      vaultPath: vault.path,
      permissionMode: 'power_user',
      callbacks: {
        onText: () => {},
        onThinking: () => {},
        onToolStart: () => {},
        onToolDone: () => {},
        onError: (message) => {
          failure = message
        },
        onDone: () => {},
      },
    })
    if (failure) {
      setIngestError(failure)
      setStatus('error')
      return
    }
    setStatus('done')
    await refresh()
  }, [refresh, state.sources.length, streamAgent, vault.path])

  const isRunning = status === 'running'
  const isEmpty = state.sources.length === 0

  return (
    <div className="space-y-3" data-testid="memory-inbox">
      <InboxHeader
        t={t}
        isRunning={isRunning}
        canIngest={!isEmpty}
        onIngest={handleIngest}
        onRefresh={refresh}
      />
      <InboxBody t={t} state={state} />
      <IngestStatusBanner t={t} status={status} ingestError={ingestError} />
    </div>
  )
}

function InboxHeader({
  t,
  isRunning,
  canIngest,
  onIngest,
  onRefresh,
}: {
  t: Translate
  isRunning: boolean
  canIngest: boolean
  onIngest: () => void
  onRefresh: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Tray size={16} aria-hidden="true" />
        {t('memoryVault.inbox.title')}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={onRefresh}
          disabled={isRunning}
          aria-label={t('memoryVault.inbox.refresh')}
          data-testid="memory-inbox-refresh"
        >
          <ArrowClockwise size={14} />
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onIngest}
          disabled={isRunning || !canIngest}
          data-testid="memory-inbox-ingest"
        >
          {isRunning ? t('memoryVault.inbox.ingesting') : t('memoryVault.inbox.ingestAll')}
        </Button>
      </div>
    </div>
  )
}

function InboxBody({ t, state }: { t: Translate; state: InboxState }) {
  if (state.loadError) {
    return (
      <p
        className="text-xs leading-5 text-destructive"
        data-testid="memory-inbox-load-error"
      >
        {t('memoryVault.inbox.loadError', { message: state.loadError })}
      </p>
    )
  }

  if (state.sources.length === 0) {
    return (
      <p className="text-xs leading-5 text-muted-foreground" data-testid="memory-inbox-empty">
        {t('memoryVault.inbox.empty')}
      </p>
    )
  }

  return (
    <div className="rounded-md border border-border bg-card p-3" data-testid="memory-inbox-list">
      <div className="text-xs leading-5 text-muted-foreground">
        {t('memoryVault.inbox.pending', { count: state.sources.length })}
      </div>
      <ul className="mt-2 space-y-1">
        {state.sources.map((source) => (
          <li
            key={source.relativePath}
            className="truncate font-mono text-xs text-foreground"
            data-testid={`memory-inbox-item-${source.name}`}
          >
            {source.name}
          </li>
        ))}
      </ul>
    </div>
  )
}

function IngestStatusBanner({
  t,
  status,
  ingestError,
}: {
  t: Translate
  status: IngestStatus
  ingestError: string | null
}) {
  if (status === 'done') {
    return (
      <p className="text-xs leading-5 text-muted-foreground" data-testid="memory-inbox-done">
        {t('memoryVault.inbox.done')}
      </p>
    )
  }

  if (status === 'error') {
    return (
      <p className="text-xs leading-5 text-destructive" data-testid="memory-inbox-error">
        {t('memoryVault.inbox.error', { message: ingestError ?? '' })}
      </p>
    )
  }

  return null
}
