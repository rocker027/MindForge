import { Brain } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { createTranslator, type AppLocale } from '../../lib/i18n'
import { ensureMemoryIndex, getMemoryCollectionAlias } from '../../lib/memoryIndex'
import {
  trackMemoryVaultCreated,
  trackMemoryVaultScaffoldFailed,
} from '../../lib/productAnalytics'
import { SectionHeading } from '../SettingsControls'
import type { VaultOption } from '../status-bar/types'
import {
  getQmdStatus as defaultGetQmdStatus,
  scaffoldMemoryVault as defaultScaffoldMemoryVault,
  type MemoryVaultScaffoldReport,
  type QmdStatusReport,
} from './memoryVaultApi'
import { MemoryIntegrationGuide } from './MemoryIntegrationGuide'
import { MemoryVaultCreateForm } from './MemoryVaultCreateForm'
import { MemoryVaultExisting } from './MemoryVaultExisting'
import { IndexingNotice, QmdStatusBlock, ScaffoldSummary } from './MemoryVaultStatusBlocks'
import { findMemoryVault } from './memoryVaultPresence'

interface MemoryVaultSetupProps {
  locale: AppLocale
  vaults: VaultOption[]
  /** Reload the workspace list after a vault is created (props-down, no global state). */
  onVaultCreated?: () => void
  scaffoldMemoryVault?: typeof defaultScaffoldMemoryVault
  getQmdStatus?: typeof defaultGetQmdStatus
  ensureIndex?: typeof ensureMemoryIndex
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Kick off the first qmd index in the background; failures never block the UI. */
function startBackgroundIndexing(
  report: MemoryVaultScaffoldReport,
  qmdStatus: QmdStatusReport | null,
  ensureIndex: typeof ensureMemoryIndex,
): void {
  if (!qmdStatus?.installed) return
  const collection = getMemoryCollectionAlias({ alias: null })
  void ensureIndex(report.path, collection)
}

/**
 * Memory Vault onboarding (ADR-0140). Shows a creation flow when no memory
 * vault exists, or a read-only status summary when one is already configured.
 */
export function MemoryVaultSetup({
  locale,
  vaults,
  onVaultCreated,
  scaffoldMemoryVault = defaultScaffoldMemoryVault,
  getQmdStatus = defaultGetQmdStatus,
  ensureIndex = ensureMemoryIndex,
}: MemoryVaultSetupProps) {
  const t = createTranslator(locale)
  const existingVault = findMemoryVault(vaults)

  const [qmdStatus, setQmdStatus] = useState<QmdStatusReport | null>(null)
  const [creating, setCreating] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [report, setReport] = useState<MemoryVaultScaffoldReport | null>(null)

  useEffect(() => {
    let active = true
    getQmdStatus()
      .then((status) => {
        if (active) setQmdStatus(status)
      })
      .catch(() => {
        if (active) setQmdStatus({ installed: false, version: null })
      })
    return () => {
      active = false
    }
  }, [getQmdStatus])

  const handleCreate = useCallback(
    async (path: string) => {
      setCreating(true)
      setErrorMessage(null)
      try {
        const result = await scaffoldMemoryVault(path)
        setReport(result)
        trackMemoryVaultCreated({
          gitInitialized: result.gitInitialized,
          registered: result.registered,
        })
        startBackgroundIndexing(result, qmdStatus, ensureIndex)
        onVaultCreated?.()
      } catch (error) {
        setErrorMessage(toErrorMessage(error))
        trackMemoryVaultScaffoldFailed()
      } finally {
        setCreating(false)
      }
    },
    [ensureIndex, onVaultCreated, qmdStatus, scaffoldMemoryVault],
  )

  return (
    <div className="space-y-3" data-testid="memory-vault-setup">
      <SectionHeading
        icon={<Brain size={16} aria-hidden="true" />}
        title={t('memoryVault.title')}
      />
      <p className="text-xs leading-5 text-muted-foreground">{t('memoryVault.description')}</p>

      {existingVault ? (
        <>
          <MemoryVaultExisting t={t} vault={existingVault} qmdStatus={qmdStatus} />
          <MemoryIntegrationGuide locale={locale} vault={existingVault} />
        </>
      ) : (
        <MemoryVaultCreateBody
          t={t}
          creating={creating}
          errorMessage={errorMessage}
          report={report}
          qmdStatus={qmdStatus}
          onCreate={handleCreate}
        />
      )}
    </div>
  )
}

function MemoryVaultCreateBody({
  t,
  creating,
  errorMessage,
  report,
  qmdStatus,
  onCreate,
}: {
  t: ReturnType<typeof createTranslator>
  creating: boolean
  errorMessage: string | null
  report: MemoryVaultScaffoldReport | null
  qmdStatus: QmdStatusReport | null
  onCreate: (path: string) => void
}) {
  if (report) {
    return (
      <div className="space-y-3">
        <ScaffoldSummary t={t} report={report} />
        {qmdStatus?.installed ? <IndexingNotice t={t} /> : null}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <MemoryVaultCreateForm
        t={t}
        creating={creating}
        errorMessage={errorMessage}
        onCreate={onCreate}
      />
      {qmdStatus?.installed === false ? <QmdStatusBlock t={t} status={qmdStatus} /> : null}
    </div>
  )
}
