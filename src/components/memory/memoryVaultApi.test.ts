import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readMemoryLintReport } from './memoryVaultApi'

const { isTauriMock, mockInvokeMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => false),
  mockInvokeMock: vi.fn(),
}))

vi.mock('../../mock-tauri', () => ({
  isTauri: isTauriMock,
  mockInvoke: mockInvokeMock,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

describe('readMemoryLintReport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isTauriMock.mockReturnValue(false)
  })

  it('reads wiki/lint-report.md scoped to the vault root', async () => {
    mockInvokeMock.mockResolvedValue('# Lint report\n\nNo issues found.')

    const report = await readMemoryLintReport('/home/user/MemoryVault')

    expect(report).toBe('# Lint report\n\nNo issues found.')
    expect(mockInvokeMock).toHaveBeenCalledWith('get_note_content', {
      path: '/home/user/MemoryVault/wiki/lint-report.md',
      vaultPath: '/home/user/MemoryVault',
    })
  })

  it('strips a trailing slash from the vault path when building the report path', async () => {
    mockInvokeMock.mockResolvedValue('# Lint report')

    await readMemoryLintReport('/home/user/MemoryVault/')

    expect(mockInvokeMock).toHaveBeenCalledWith('get_note_content', {
      path: '/home/user/MemoryVault/wiki/lint-report.md',
      vaultPath: '/home/user/MemoryVault/',
    })
  })

  it('returns null when the report file is empty (no report generated yet)', async () => {
    mockInvokeMock.mockResolvedValue('   \n  ')

    expect(await readMemoryLintReport('/home/user/MemoryVault')).toBeNull()
  })

  it('returns null when the report read throws (file missing)', async () => {
    mockInvokeMock.mockRejectedValue(new Error('not found'))

    expect(await readMemoryLintReport('/home/user/MemoryVault')).toBeNull()
  })
})
