import { createTranslator, type AppLocale, type TranslationKey } from '../../lib/i18n'
import { getMemoryCollectionAlias } from '../../lib/memoryIndex'
import { trackMemoryIntegrationCommandCopied } from '../../lib/productAnalytics'
import type { VaultOption } from '../status-bar/types'
import { CommandSnippet } from './MemoryVaultStatusBlocks'

type Translate = ReturnType<typeof createTranslator>

interface MemoryIntegrationGuideProps {
  locale: AppLocale
  /** The configured memory vault (kind === 'memory'); supplies the real path/alias. */
  vault: VaultOption
}

/** External AI tool that can connect to the memory vault. Product names stay literal. */
interface MemoryToolGuide {
  id: 'claude_code' | 'codex' | 'cursor' | 'opencode' | 'antigravity'
  label: string
  noteKey: TranslationKey
}

const MEMORY_TOOLS: readonly MemoryToolGuide[] = [
  { id: 'claude_code', label: 'Claude Code', noteKey: 'memoryVault.integration.tool.claudeCode' },
  { id: 'codex', label: 'Codex', noteKey: 'memoryVault.integration.tool.codex' },
  { id: 'cursor', label: 'Cursor', noteKey: 'memoryVault.integration.tool.cursor' },
  { id: 'opencode', label: 'OpenCode', noteKey: 'memoryVault.integration.tool.opencode' },
  { id: 'antigravity', label: 'Antigravity', noteKey: 'memoryVault.integration.tool.antigravity' },
] as const

/** Build the copyable qmd collection-registration command (matches the Rust adapter). */
function buildQmdCommand(vaultPath: string, collection: string): string {
  return (
    `qmd collection add ${vaultPath} --name ${collection}` +
    ` && qmd collection update-cmd ${collection} 'git pull --rebase'`
  )
}

/** Absolute path to the vault's AGENTS.md filesystem schema (path ① baseline). */
function buildAgentsPath(vaultPath: string): string {
  const trimmed = vaultPath.replace(/\/+$/, '')
  return `${trimmed}/AGENTS.md`
}

/**
 * Read-only guide for connecting external AI tools to a configured memory vault.
 * Displays copyable commands and paths the user runs themselves — it never
 * mutates config or invokes Tauri (ADR-0141).
 */
export function MemoryIntegrationGuide({ locale, vault }: MemoryIntegrationGuideProps) {
  const t = createTranslator(locale)
  const collection = getMemoryCollectionAlias({ alias: vault.alias })
  const qmdCommand = buildQmdCommand(vault.path, collection)
  const agentsPath = buildAgentsPath(vault.path)

  return (
    <div className="space-y-3" data-testid="memory-integration-guide">
      <div className="text-sm font-medium text-foreground">{t('memoryVault.integration.title')}</div>
      <p className="text-xs leading-5 text-muted-foreground">
        {t('memoryVault.integration.description')}
      </p>
      <QmdRegistrationBlock t={t} command={qmdCommand} />
      <ToolNoteList t={t} />
      <SchemaPathBlock t={t} agentsPath={agentsPath} />
    </div>
  )
}

/** Shared, tool-agnostic qmd collection-registration command block. */
function QmdRegistrationBlock({ t, command }: { t: Translate; command: string }) {
  return (
    <div
      className="rounded-md border border-border bg-card p-3"
      data-testid="memory-integration-qmd"
    >
      <div className="text-sm font-medium text-foreground">
        {t('memoryVault.integration.qmdTitle')}
      </div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">
        {t('memoryVault.integration.qmdDescription')}
      </div>
      <CommandSnippet
        t={t}
        command={command}
        testId="memory-integration-qmd-copy"
        onCopy={() => trackMemoryIntegrationCommandCopied('qmd')}
      />
    </div>
  )
}

/** Per-tool one-line notes on how each tool consumes the registered vault. */
function ToolNoteList({ t }: { t: Translate }) {
  return (
    <div
      className="rounded-md border border-border bg-card p-3"
      data-testid="memory-integration-tools"
    >
      <div className="text-sm font-medium text-foreground">
        {t('memoryVault.integration.toolsTitle')}
      </div>
      <ul className="mt-2 space-y-2">
        {MEMORY_TOOLS.map((tool) => (
          <li key={tool.id} data-testid={`memory-integration-tool-${tool.id}`}>
            <div className="text-sm font-medium text-foreground">{tool.label}</div>
            <div className="text-xs leading-5 text-muted-foreground">{t(tool.noteKey)}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Copyable AGENTS.md filesystem-schema path (zero-retrieval-engine baseline). */
function SchemaPathBlock({ t, agentsPath }: { t: Translate; agentsPath: string }) {
  return (
    <div
      className="rounded-md border border-border bg-card p-3"
      data-testid="memory-integration-schema"
    >
      <div className="text-sm font-medium text-foreground">
        {t('memoryVault.integration.schemaTitle')}
      </div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">
        {t('memoryVault.integration.schemaNote')}
      </div>
      <CommandSnippet
        t={t}
        command={agentsPath}
        testId="memory-integration-schema-copy"
        onCopy={() => trackMemoryIntegrationCommandCopied('schema')}
      />
    </div>
  )
}
