import { Stethoscope } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_AI_AGENT } from '../../lib/aiAgents'
import { createTranslator, type AppLocale } from '../../lib/i18n'
import { trackMemoryLintStarted } from '../../lib/productAnalytics'
import type { VaultOption } from '../status-bar/types'
import { streamAiAgent } from '../../utils/streamAiAgent'
import { MarkdownContent } from '../MarkdownContent'
import { Button } from '../ui/button'
import { readMemoryLintReport as defaultReadLintReport } from './memoryVaultApi'

type Translate = ReturnType<typeof createTranslator>

/** Stable status machine for a lint run; drives the banner and button state. */
type LintStatus = 'idle' | 'running' | 'done' | 'error'

interface MemoryLintProps {
  locale: AppLocale
  /** The configured memory vault (kind === 'memory'); supplies the real root path. */
  vault: VaultOption
  /** Injectable for tests so the report read never touches a live Tauri command. */
  readLintReport?: typeof defaultReadLintReport
  /** Injectable for tests so the lint run never spawns a live agent. */
  streamAgent?: typeof streamAiAgent
}

/**
 * Build the lint instruction. The agent runs inside the vault root, so it
 * follows the vault's own AGENTS.md `## Lint workflow` rather than receiving
 * the steps inline — keeping a single source of truth for the protocol.
 */
function buildLintPrompt(): string {
  return (
    'Health-check this memory vault wiki. Follow the "## Lint workflow" section ' +
    'of AGENTS.md in this vault exactly: detect contradictions, stale claims, ' +
    'orphan pages not reachable from wiki/index.md, missing cross-references, and ' +
    'citation gaps. Write the findings to wiki/lint-report.md (overwrite the ' +
    'previous report) and append a lint entry to wiki/log.md. Obey every rule in ' +
    'the "## Safety rules" section.'
  )
}

/**
 * Wiki lint panel for a configured memory vault (ADR-0142, Task 4.2).
 *
 * Runs an AI lint pass through the existing CLI-agent streaming flow, then reads
 * the free-form `wiki/lint-report.md` the agent writes and renders it with the
 * app's shared markdown renderer. It loads any existing report on mount so a
 * previous run's findings stay visible across sessions.
 */
export function MemoryLint({
  locale,
  vault,
  readLintReport = defaultReadLintReport,
  streamAgent = streamAiAgent,
}: MemoryLintProps) {
  const t = createTranslator(locale)
  const [report, setReport] = useState<string | null>(null)
  const [status, setStatus] = useState<LintStatus>('idle')
  const [lintError, setLintError] = useState<string | null>(null)

  const loadReport = useCallback(async (): Promise<string | null> => {
    const content = await readLintReport(vault.path)
    setReport(content)
    return content
  }, [readLintReport, vault.path])

  useEffect(() => {
    let active = true
    readLintReport(vault.path)
      .then((content) => { if (active) setReport(content) })
      .catch(() => { if (active) setReport(null) })
    return () => { active = false }
  }, [readLintReport, vault.path])

  const handleLint = useCallback(async () => {
    setStatus('running')
    setLintError(null)
    trackMemoryLintStarted()
    let failure: string | null = null
    await streamAgent({
      agent: DEFAULT_AI_AGENT,
      message: buildLintPrompt(),
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
      setLintError(failure)
      setStatus('error')
      return
    }
    const content = await loadReport()
    setStatus(content ? 'done' : 'idle')
    if (!content) setLintError(null)
  }, [loadReport, streamAgent, vault.path])

  const isRunning = status === 'running'

  return (
    <div className="space-y-3" data-testid="memory-lint">
      <LintHeader t={t} isRunning={isRunning} onLint={handleLint} />
      <LintStatusBanner t={t} status={status} lintError={lintError} hasReport={report !== null} />
      <LintReportBody t={t} report={report} isRunning={isRunning} />
    </div>
  )
}

function LintHeader({
  t,
  isRunning,
  onLint,
}: {
  t: Translate
  isRunning: boolean
  onLint: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Stethoscope size={16} aria-hidden="true" />
        {t('memoryVault.lint.title')}
      </div>
      <Button
        type="button"
        size="sm"
        onClick={onLint}
        disabled={isRunning}
        data-testid="memory-lint-run"
      >
        {isRunning ? t('memoryVault.lint.running') : t('memoryVault.lint.run')}
      </Button>
    </div>
  )
}

function LintStatusBanner({
  t,
  status,
  lintError,
  hasReport,
}: {
  t: Translate
  status: LintStatus
  lintError: string | null
  hasReport: boolean
}) {
  if (status === 'done') {
    return (
      <p className="text-xs leading-5 text-muted-foreground" data-testid="memory-lint-done">
        {t('memoryVault.lint.done')}
      </p>
    )
  }

  if (status === 'error') {
    return (
      <p className="text-xs leading-5 text-destructive" data-testid="memory-lint-error">
        {t('memoryVault.lint.error', { message: lintError ?? '' })}
      </p>
    )
  }

  if (status === 'idle' && !hasReport) {
    return (
      <p className="text-xs leading-5 text-muted-foreground" data-testid="memory-lint-no-report">
        {t('memoryVault.lint.noReport')}
      </p>
    )
  }

  return (
    <p className="text-xs leading-5 text-muted-foreground" data-testid="memory-lint-description">
      {t('memoryVault.lint.description')}
    </p>
  )
}

function LintReportBody({
  t,
  report,
  isRunning,
}: {
  t: Translate
  report: string | null
  isRunning: boolean
}) {
  if (report === null) {
    if (isRunning) return null
    return (
      <p className="text-xs leading-5 text-muted-foreground" data-testid="memory-lint-empty">
        {t('memoryVault.lint.empty')}
      </p>
    )
  }

  return (
    <div className="rounded-md border border-border bg-card p-3" data-testid="memory-lint-report">
      <div className="text-sm font-medium text-foreground">{t('memoryVault.lint.reportTitle')}</div>
      <div className="mt-2 text-xs leading-5 text-muted-foreground">
        <MarkdownContent content={report} />
      </div>
    </div>
  )
}
