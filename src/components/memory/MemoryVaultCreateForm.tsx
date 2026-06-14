import { useState } from 'react'
import type { createTranslator } from '../../lib/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { DEFAULT_MEMORY_VAULT_PATH } from './memoryVaultPresence'

type Translate = ReturnType<typeof createTranslator>

interface MemoryVaultCreateFormProps {
  t: Translate
  creating: boolean
  errorMessage: string | null
  onCreate: (path: string) => void
}

/** Path input + create button for scaffolding a new memory vault. */
export function MemoryVaultCreateForm({
  t,
  creating,
  errorMessage,
  onCreate,
}: MemoryVaultCreateFormProps) {
  const [path, setPath] = useState(DEFAULT_MEMORY_VAULT_PATH)
  const trimmedPath = path.trim()
  const canSubmit = trimmedPath.length > 0 && !creating

  const handleSubmit = () => {
    if (!canSubmit) return
    onCreate(trimmedPath)
  }

  return (
    <div className="space-y-3" data-testid="memory-vault-create-form">
      <p className="text-xs leading-5 text-muted-foreground">{t('memoryVault.intro')}</p>

      <div className="space-y-1">
        <div className="text-sm font-medium text-foreground">{t('memoryVault.pathLabel')}</div>
        <Input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              handleSubmit()
            }
          }}
          placeholder={t('memoryVault.pathPlaceholder')}
          aria-label={t('memoryVault.pathLabel')}
          disabled={creating}
          data-testid="memory-vault-path-input"
          className="bg-transparent"
        />
        <div className="text-xs leading-5 text-muted-foreground">{t('memoryVault.pathDescription')}</div>
      </div>

      {errorMessage ? (
        <p className="text-xs leading-5 text-destructive" data-testid="memory-vault-error" role="alert">
          {t('memoryVault.error', { message: errorMessage })}
        </p>
      ) : null}

      <Button
        type="button"
        variant="default"
        size="sm"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-fit"
        data-testid="memory-vault-create-button"
      >
        {creating ? t('memoryVault.creating') : t('memoryVault.create')}
      </Button>
    </div>
  )
}
