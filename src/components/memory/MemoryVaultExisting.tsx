import type { createTranslator } from '../../lib/i18n'
import type { VaultOption } from '../status-bar/types'
import type { QmdStatusReport } from './memoryVaultApi'
import { QmdStatusBlock } from './MemoryVaultStatusBlocks'

type Translate = ReturnType<typeof createTranslator>

interface MemoryVaultExistingProps {
  t: Translate
  vault: VaultOption
  qmdStatus: QmdStatusReport | null
}

/** Read-only summary shown when a memory vault is already configured. */
export function MemoryVaultExisting({ t, vault, qmdStatus }: MemoryVaultExistingProps) {
  return (
    <div className="space-y-3" data-testid="memory-vault-existing">
      <div className="rounded-md border border-border bg-card p-3">
        <div className="text-sm font-medium text-foreground">{t('memoryVault.existingTitle')}</div>
        <dl className="mt-2 space-y-2 text-xs leading-5 text-muted-foreground">
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">{t('memoryVault.existingPath')}</dt>
            <dd className="truncate font-mono" data-testid="memory-vault-existing-path">{vault.path}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="font-medium text-foreground">{t('memoryVault.existingStatus')}</dt>
            <dd>
              <QmdStatusBlock t={t} status={qmdStatus} />
            </dd>
          </div>
        </dl>
      </div>
    </div>
  )
}
