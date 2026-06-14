import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MEMORY_INDEX_REFRESH_DEBOUNCE_MS,
  createMemoryIndexScheduler,
  ensureMemoryIndex,
  getMemoryCollectionAlias,
  isMountedMemoryVault,
  refreshMountedMemoryIndexes,
  scheduleMemoryIndexRefresh,
} from './memoryIndex'

const mockInvokeFn = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvokeFn(...args),
}))
vi.mock('../mock-tauri', () => ({
  isTauri: () => false,
  mockInvoke: (...args: unknown[]) => mockInvokeFn(...args),
}))

function indexReport(available: boolean) {
  return { available, collectionCreated: false, indexed: available }
}

function vaultList(vaults: Array<Record<string, unknown>>) {
  return { vaults, active_vault: null, hidden_defaults: [] }
}

function qmdUpdateCalls() {
  return mockInvokeFn.mock.calls.filter((call: unknown[]) => call[0] === 'qmd_update_index')
}

describe('getMemoryCollectionAlias', () => {
  it('prefixes the vault alias with tolaria-', () => {
    expect(getMemoryCollectionAlias({ alias: 'work' })).toBe('tolaria-work')
  })

  it('falls back to tolaria-memory when alias is missing or blank', () => {
    expect(getMemoryCollectionAlias({})).toBe('tolaria-memory')
    expect(getMemoryCollectionAlias({ alias: null })).toBe('tolaria-memory')
    expect(getMemoryCollectionAlias({ alias: '   ' })).toBe('tolaria-memory')
  })
})

describe('isMountedMemoryVault', () => {
  it('accepts mounted memory vaults, including legacy entries without mounted flag', () => {
    expect(isMountedMemoryVault({ kind: 'memory', mounted: true })).toBe(true)
    expect(isMountedMemoryVault({ kind: 'memory' })).toBe(true)
  })

  it('rejects notes vaults and unmounted memory vaults', () => {
    expect(isMountedMemoryVault({ kind: 'notes', mounted: true })).toBe(false)
    expect(isMountedMemoryVault({ kind: 'memory', mounted: false })).toBe(false)
    expect(isMountedMemoryVault({})).toBe(false)
  })
})

describe('ensureMemoryIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('invokes qmd_update_index with the vault path and collection', async () => {
    mockInvokeFn.mockResolvedValue(indexReport(true))

    const report = await ensureMemoryIndex('/tmp/memory-vault', 'tolaria-memory')

    expect(mockInvokeFn).toHaveBeenCalledWith('qmd_update_index', {
      vaultPath: '/tmp/memory-vault',
      collection: 'tolaria-memory',
    })
    expect(report).toEqual(indexReport(true))
  })

  it('stays silent when qmd is not installed (available: false)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockInvokeFn.mockResolvedValue(indexReport(false))

    const report = await ensureMemoryIndex('/tmp/memory-vault', 'tolaria-memory')

    expect(report).toEqual(indexReport(false))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('swallows invoke failures with a warning instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockInvokeFn.mockRejectedValue(new Error('boom'))

    const report = await ensureMemoryIndex('/tmp/memory-vault', 'tolaria-memory')

    expect(report).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('refreshMountedMemoryIndexes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refreshes only mounted memory vaults using the collection alias convention', async () => {
    mockInvokeFn.mockImplementation((cmd: string) => {
      if (cmd === 'load_vault_list') {
        return Promise.resolve(vaultList([
          { path: '/vaults/notes', kind: 'notes', mounted: true },
          { path: '/vaults/memory', kind: 'memory', mounted: true, alias: 'brain' },
          { path: '/vaults/old-memory', kind: 'memory', mounted: false },
        ]))
      }
      return Promise.resolve(indexReport(true))
    })

    await refreshMountedMemoryIndexes()

    expect(qmdUpdateCalls()).toEqual([
      ['qmd_update_index', { vaultPath: '/vaults/memory', collection: 'tolaria-brain' }],
    ])
  })

  it('does nothing when no memory vault is configured', async () => {
    mockInvokeFn.mockResolvedValue(vaultList([
      { path: '/vaults/notes', kind: 'notes', mounted: true },
    ]))

    await refreshMountedMemoryIndexes()

    expect(qmdUpdateCalls()).toHaveLength(0)
  })

  it('swallows vault list load failures with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockInvokeFn.mockRejectedValue(new Error('no config'))

    await expect(refreshMountedMemoryIndexes()).resolves.toBeUndefined()

    expect(qmdUpdateCalls()).toHaveLength(0)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('createMemoryIndexScheduler', () => {
  interface FakeTimer {
    id: number
    callback: () => void
    delayMs: number
  }

  function fakeTimers() {
    const pending: FakeTimer[] = []
    let nextId = 1
    return {
      pending,
      setTimer: (callback: () => void, delayMs: number) => {
        const id = nextId++
        pending.push({ id, callback, delayMs })
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: (id: ReturnType<typeof setTimeout>) => {
        const index = pending.findIndex((timer) => timer.id === (id as unknown as number))
        if (index !== -1) pending.splice(index, 1)
      },
      fire: () => {
        const due = pending.splice(0, pending.length)
        for (const timer of due) timer.callback()
      },
    }
  }

  it('collapses repeated schedule calls into a single trailing refresh', () => {
    const timers = fakeTimers()
    const refresh = vi.fn().mockResolvedValue(undefined)
    const scheduler = createMemoryIndexScheduler({
      refresh,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()

    expect(timers.pending).toHaveLength(1)
    expect(timers.pending[0].delayMs).toBe(MEMORY_INDEX_REFRESH_DEBOUNCE_MS)

    timers.fire()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('schedules again after a refresh has fired', () => {
    const timers = fakeTimers()
    const refresh = vi.fn().mockResolvedValue(undefined)
    const scheduler = createMemoryIndexScheduler({
      refresh,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    scheduler.schedule()
    timers.fire()
    scheduler.schedule()
    timers.fire()

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('cancel drops the pending refresh', () => {
    const timers = fakeTimers()
    const refresh = vi.fn().mockResolvedValue(undefined)
    const scheduler = createMemoryIndexScheduler({
      refresh,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    scheduler.schedule()
    scheduler.cancel()
    timers.fire()

    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('scheduleMemoryIndexRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces module-level triggers and refreshes mounted memory vaults', async () => {
    mockInvokeFn.mockImplementation((cmd: string) => {
      if (cmd === 'load_vault_list') {
        return Promise.resolve(vaultList([
          { path: '/vaults/memory', kind: 'memory', mounted: true },
        ]))
      }
      return Promise.resolve(indexReport(true))
    })

    scheduleMemoryIndexRefresh()
    scheduleMemoryIndexRefresh()
    await vi.advanceTimersByTimeAsync(MEMORY_INDEX_REFRESH_DEBOUNCE_MS)

    expect(qmdUpdateCalls()).toEqual([
      ['qmd_update_index', { vaultPath: '/vaults/memory', collection: 'tolaria-memory' }],
    ])
  })
})
