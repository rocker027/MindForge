import { describe, it, expect } from 'vitest'
import { resolveMemorySearchTarget } from './memorySearchAvailability'
import type { VaultOption } from '../status-bar/types'

const notesVault: VaultOption = { label: 'Notes', path: '/notes', kind: 'notes' }
const memoryVault: VaultOption = { label: 'Memory', path: '/memory', alias: 'brain', kind: 'memory', mounted: true }

describe('resolveMemorySearchTarget', () => {
  it('returns null when qmd is not installed', () => {
    expect(resolveMemorySearchTarget([memoryVault], false)).toBeNull()
  })

  it('returns null when no memory vault is configured', () => {
    expect(resolveMemorySearchTarget([notesVault], true)).toBeNull()
  })

  it('returns null when the memory vault is unmounted', () => {
    const unmounted: VaultOption = { ...memoryVault, mounted: false }
    expect(resolveMemorySearchTarget([notesVault, unmounted], true)).toBeNull()
  })

  it('resolves the vault path and aliased collection when qmd and a memory vault are present', () => {
    expect(resolveMemorySearchTarget([notesVault, memoryVault], true)).toEqual({
      vaultPath: '/memory',
      collection: 'tolaria-brain',
    })
  })

  it('falls back to the default collection when the memory vault has no alias', () => {
    const noAlias: VaultOption = { label: 'Memory', path: '/memory', kind: 'memory', mounted: true }
    expect(resolveMemorySearchTarget([noAlias], true)).toEqual({
      vaultPath: '/memory',
      collection: 'tolaria-memory',
    })
  })
})
