import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { vaultContext } from './vault.js'

/**
 * Condensed memory protocol (ADR-0142) surfaced to agents whenever a memory
 * vault is mounted. The in-vault AGENTS.md remains the normative schema; this
 * summary only points agents at the right tools and invariants.
 */
const MEMORY_PROTOCOL_SUMMARY = [
  'A shared memory vault (LLM wiki) is mounted alongside the active vaults.',
  '- Recall: call memory_recall first; for manual navigation start at wiki/index.md and follow [[wikilinks]].',
  '- Capture: call memory_ingest to drop new material into raw/inbox/ for later wiki ingestion.',
  '- Activity: call memory_log to append "## [YYYY-MM-DD] <kind> | <entry>" lines to wiki/log.md (append-only).',
  '- Never edit, rename, or delete files under raw/ — raw sources are immutable.',
  '- Every wiki claim must cite a raw/ source; the full schema lives in the memory vault AGENTS.md.',
].join('\n')

export async function readAgentInstructions(vaultPath) {
  const instructionsPath = path.join(vaultPath, 'AGENTS.md')
  try {
    return {
      path: instructionsPath,
      content: await readFile(instructionsPath, 'utf8'),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function memoryProtocolSummary(memoryVaultPath) {
  return {
    memoryVaultPath,
    schemaPath: path.join(memoryVaultPath, 'AGENTS.md'),
    summary: MEMORY_PROTOCOL_SUMMARY,
  }
}

export async function vaultContextWithInstructions(vaultPath, { memoryVaultPath = null } = {}) {
  const context = {
    ...(await vaultContext(vaultPath)),
    agentInstructions: await readAgentInstructions(vaultPath),
  }
  if (!memoryVaultPath) return context
  return { ...context, memoryProtocol: memoryProtocolSummary(memoryVaultPath) }
}
