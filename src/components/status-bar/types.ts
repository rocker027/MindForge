export interface VaultOption {
  label: string
  path: string
  alias?: string
  shortLabel?: string | null
  color?: string | null
  icon?: string | null
  mounted?: boolean
  /** Workspace kind: "notes" (default) or "memory" for LLM memory vaults (ADR-0140). */
  kind?: string | null
  managedDefault?: boolean
  available?: boolean
}
