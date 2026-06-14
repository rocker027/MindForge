import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoSync } from './useAutoSync'
import { scheduleMemoryIndexRefresh } from '../lib/memoryIndex'
import type { GitPullResult, GitRemoteStatus } from '../types'

const mockInvokeFn = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvokeFn(...args),
}))

vi.mock('../mock-tauri', () => ({
  isTauri: () => false,
  mockInvoke: (...args: unknown[]) => mockInvokeFn(...args),
}))

vi.mock('../lib/memoryIndex', () => ({
  scheduleMemoryIndexRefresh: vi.fn(),
}))

const REMOTE_STATUS: GitRemoteStatus = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  hasRemote: true,
}

function pullResult(status: GitPullResult['status'], files: string[] = []): GitPullResult {
  return {
    status,
    message: status,
    updatedFiles: status === 'updated' ? files : [],
    conflictFiles: status === 'conflict' ? files : [],
  }
}

function mockSyncCommands(pull: GitPullResult) {
  mockInvokeFn.mockImplementation((command: string) => {
    if (command === 'get_last_commit_info') return Promise.resolve(null)
    if (command === 'get_conflict_files') return Promise.resolve([])
    if (command === 'git_remote_status') return Promise.resolve(REMOTE_STATUS)
    if (command === 'git_push') return Promise.resolve({ status: 'ok', message: 'Pushed' })
    return Promise.resolve(pull)
  })
}

function renderSync() {
  return renderHook(() =>
    useAutoSync({
      vaultPath: '/Users/luca/Laputa',
      intervalMinutes: 5,
      onVaultUpdated: vi.fn(),
      onConflict: vi.fn(),
      onToast: vi.fn(),
    }),
  )
}

describe('useAutoSync memory index refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('schedules a memory index refresh after a successful pull', async () => {
    mockSyncCommands(pullResult('updated', ['wiki/rust.md']))

    renderSync()

    await waitFor(() => {
      expect(scheduleMemoryIndexRefresh).toHaveBeenCalled()
    })
  })

  it('schedules a refresh even when the pull is already up to date', async () => {
    mockSyncCommands(pullResult('up_to_date'))

    renderSync()

    await waitFor(() => {
      expect(scheduleMemoryIndexRefresh).toHaveBeenCalled()
    })
  })

  it('does not schedule a refresh when the pull hits a conflict', async () => {
    mockSyncCommands(pullResult('conflict', ['wiki/rust.md']))

    const hook = renderSync()

    await waitFor(() => {
      expect(hook.result.current.syncStatus).toBe('conflict')
    })
    expect(scheduleMemoryIndexRefresh).not.toHaveBeenCalled()
  })

  it('does not schedule a refresh when the pull fails', async () => {
    mockSyncCommands(pullResult('error'))

    const hook = renderSync()

    await waitFor(() => {
      expect(hook.result.current.syncStatus).toBe('error')
    })
    expect(scheduleMemoryIndexRefresh).not.toHaveBeenCalled()
  })

  it('schedules a refresh after a successful pull-and-push recovery', async () => {
    mockSyncCommands(pullResult('up_to_date'))
    const hook = renderSync()
    await waitFor(() => {
      expect(hook.result.current.syncStatus).toBe('idle')
    })
    vi.mocked(scheduleMemoryIndexRefresh).mockClear()

    mockSyncCommands(pullResult('updated', ['wiki/rust.md']))
    await act(async () => {
      await hook.result.current.pullAndPush()
    })

    expect(scheduleMemoryIndexRefresh).toHaveBeenCalled()
  })
})
