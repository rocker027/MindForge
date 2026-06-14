import { Check, Copy } from '@phosphor-icons/react'
import { useCallback, useState } from 'react'
import type { createTranslator } from '../../lib/i18n'
import { Button } from '../ui/button'
import type { MemoryVaultScaffoldReport, QmdStatusReport } from './memoryVaultApi'

type Translate = ReturnType<typeof createTranslator>

/** qmd availability summary: ready, or install guidance when the CLI is absent. */
export function QmdStatusBlock({ t, status }: { t: Translate; status: QmdStatusReport | null }) {
  if (status?.installed) {
    return (
      <p className="text-xs leading-5 text-muted-foreground" data-testid="memory-vault-qmd-ready">
        {status.version
          ? t('memoryVault.qmdReady', { version: status.version })
          : t('memoryVault.qmdReadyNoVersion')}
      </p>
    )
  }

  return (
    <div
      className="rounded-md border border-border bg-card p-3"
      data-testid="memory-vault-qmd-missing"
    >
      <div className="text-sm font-medium text-foreground">{t('memoryVault.qmdMissingTitle')}</div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">
        {t('memoryVault.qmdMissingDescription')}
      </div>
      <div className="mt-2 text-xs leading-5 text-muted-foreground">{t('memoryVault.qmdInstallHint')}</div>
      <CommandSnippet t={t} command={t('memoryVault.qmdInstallCommand')} />
    </div>
  )
}

/** Read-only command line with a copy-to-clipboard affordance. */
export function CommandSnippet({ t, command }: { t: Translate; command: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }, [command])

  return (
    <div className="mt-2 flex items-center gap-2">
      <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
        {command}
      </code>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={handleCopy}
        aria-label={copied ? t('memoryVault.copied') : t('memoryVault.copyCommand')}
        data-testid="memory-vault-copy-command"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </Button>
    </div>
  )
}

/** Summary of a successful scaffold: created/skipped counts, git and mount state. */
export function ScaffoldSummary({ t, report }: { t: Translate; report: MemoryVaultScaffoldReport }) {
  return (
    <div
      className="rounded-md border border-border bg-card p-3"
      data-testid="memory-vault-scaffold-summary"
    >
      <div className="text-sm font-medium text-foreground">{t('memoryVault.createdTitle')}</div>
      <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
        <li>{t('memoryVault.createdFiles', { count: report.createdFiles.length })}</li>
        {report.skippedFiles.length > 0 ? (
          <li data-testid="memory-vault-skipped-files">
            {t('memoryVault.skippedFiles', { count: report.skippedFiles.length })}
          </li>
        ) : null}
        <li>{report.gitInitialized ? t('memoryVault.gitInitialized') : t('memoryVault.gitExisting')}</li>
        {report.registered ? <li>{t('memoryVault.registered')}</li> : null}
      </ul>
    </div>
  )
}

/** Background-indexing notice shown after a successful scaffold when qmd is present. */
export function IndexingNotice({ t }: { t: Translate }) {
  return (
    <div
      className="rounded-md border border-border bg-card p-3"
      data-testid="memory-vault-indexing-notice"
    >
      <div className="text-sm font-medium text-foreground">{t('memoryVault.indexingTitle')}</div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">
        {t('memoryVault.indexingFirstRun')}
      </div>
    </div>
  )
}
