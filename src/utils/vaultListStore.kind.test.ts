import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadVaultList, saveVaultList } from './vaultListStore'
import type { VaultOption } from '../components/status-bar/types'

const mockInvokeFn = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvokeFn(...args),
}))
vi.mock('../mock-tauri', () => ({
  isTauri: () => false,
  mockInvoke: (...args: unknown[]) => mockInvokeFn(...args),
}))

function savedListArg(): { vaults: Array<Record<string, unknown>> } {
  const call = mockInvokeFn.mock.calls.find((entry) => entry[0] === 'save_vault_list')
  if (!call) throw new Error('save_vault_list was not invoked')
  return (call[1] as { list: { vaults: Array<Record<string, unknown>> } }).list
}

describe('vaultListStore kind plumbing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('defaults legacy entries without kind to "notes" when loading', async () => {
    mockInvokeFn.mockImplementation((command: string) => {
      if (command === 'load_vault_list') {
        return Promise.resolve({
          vaults: [
            { label: 'Legacy', path: '/legacy', mounted: true },
            { label: 'Brain', path: '/brain', mounted: true, kind: 'memory' },
          ],
          active_vault: '/legacy',
          hidden_defaults: [],
        })
      }
      return Promise.resolve(true)
    })

    const { vaults } = await loadVaultList()

    expect(vaults.find((vault) => vault.path === '/legacy')?.kind).toBe('notes')
    expect(vaults.find((vault) => vault.path === '/brain')?.kind).toBe('memory')
  })

  it('persists the kind field, defaulting missing values to "notes"', async () => {
    mockInvokeFn.mockResolvedValue(undefined)

    const vaults: VaultOption[] = [
      { label: 'Notes', path: '/notes', mounted: true },
      { label: 'Brain', path: '/brain', mounted: true, kind: 'memory' },
    ]

    await saveVaultList(vaults, '/notes')

    const persisted = savedListArg().vaults
    expect(persisted[0]).toMatchObject({ path: '/notes', kind: 'notes' })
    expect(persisted[1]).toMatchObject({ path: '/brain', kind: 'memory' })
  })
})
