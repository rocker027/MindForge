import { describe, it, expect } from 'vitest'
import { findMemoryVault, hasMemoryVault, MEMORY_VAULT_KIND } from './memoryVaultPresence'
import type { VaultOption } from '../status-bar/types'

const notesVault: VaultOption = { label: 'Notes', path: '/notes', kind: 'notes' }
const memoryVault: VaultOption = { label: 'Brain', path: '/brain', kind: MEMORY_VAULT_KIND }

describe('memoryVaultPresence', () => {
  it('finds the first memory vault by kind', () => {
    expect(findMemoryVault([notesVault, memoryVault])).toBe(memoryVault)
    expect(hasMemoryVault([notesVault, memoryVault])).toBe(true)
  })

  it('returns null when no memory vault exists', () => {
    expect(findMemoryVault([notesVault])).toBeNull()
    expect(hasMemoryVault([notesVault])).toBe(false)
    expect(findMemoryVault([])).toBeNull()
  })

  it('treats vaults without a kind as non-memory', () => {
    const legacy: VaultOption = { label: 'Legacy', path: '/legacy' }
    expect(findMemoryVault([legacy])).toBeNull()
  })
})
