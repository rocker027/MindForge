import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useMemorySearch, type MemoryHit } from './useMemorySearch'

vi.mock('../mock-tauri', () => ({
  mockInvoke: vi.fn(),
  isTauri: () => false,
}))

import { mockInvoke } from '../mock-tauri'
const mockInvokeFn = vi.mocked(mockInvoke)

const HIT: MemoryHit = { path: 'wiki/a.md', title: 'A', score: 0.9, snippet: 'snippet' }

function mockHits(hits: MemoryHit[], available = true) {
  mockInvokeFn.mockResolvedValue({ available, hits })
}

/** Flush the debounce timer plus the async query resolution deterministically. */
async function settleSearch() {
  await act(async () => { await vi.runAllTimersAsync() })
}

describe('useMemorySearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays idle and never calls qmd when disabled', async () => {
    mockHits([HIT])
    renderHook(() => useMemorySearch({ collection: 'c', query: 'hello', enabled: false }))
    await settleSearch()
    expect(mockInvokeFn).not.toHaveBeenCalled()
  })

  it('stays idle for a blank query', async () => {
    mockHits([HIT])
    const { result } = renderHook(() => useMemorySearch({ collection: 'c', query: '   ', enabled: true }))
    await settleSearch()
    expect(mockInvokeFn).not.toHaveBeenCalled()
    expect(result.current.hits).toEqual([])
  })

  it('debounces then queries the collection and exposes hits', async () => {
    mockHits([HIT])
    const { result } = renderHook(() => useMemorySearch({ collection: 'tolaria-mem', query: 'react', enabled: true }))

    expect(mockInvokeFn).not.toHaveBeenCalled()
    await settleSearch()

    expect(mockInvokeFn).toHaveBeenCalledWith('qmd_memory_query', { query: 'react', collection: 'tolaria-mem', limit: 20 })
    expect(result.current.hits).toEqual([HIT])
    expect(result.current.unavailable).toBe(false)
  })

  it('reports unavailable and no hits when qmd is absent', async () => {
    mockHits([], false)
    const { result } = renderHook(() => useMemorySearch({ collection: 'c', query: 'react', enabled: true }))
    await settleSearch()

    expect(result.current.unavailable).toBe(true)
    expect(result.current.hits).toEqual([])
  })

  it('fires onResults with the hit count once results land', async () => {
    mockHits([HIT, { ...HIT, path: 'wiki/b.md' }])
    const onResults = vi.fn()
    renderHook(() => useMemorySearch({ collection: 'c', query: 'react', enabled: true, onResults }))
    await settleSearch()

    expect(onResults).toHaveBeenCalledWith(2)
  })

  it('collapses rapid query changes into a single trailing request', async () => {
    mockHits([HIT])
    const { rerender } = renderHook(
      ({ query }) => useMemorySearch({ collection: 'c', query, enabled: true }),
      { initialProps: { query: 'a' } },
    )
    rerender({ query: 'ab' })
    rerender({ query: 'abc' })
    await settleSearch()

    expect(mockInvokeFn).toHaveBeenCalledTimes(1)
    expect(mockInvokeFn).toHaveBeenCalledWith('qmd_memory_query', { query: 'abc', collection: 'c', limit: 20 })
  })

  it('returns empty hits when the query is cleared after a search', async () => {
    mockHits([HIT])
    const { result, rerender } = renderHook(
      ({ query }) => useMemorySearch({ collection: 'c', query, enabled: true }),
      { initialProps: { query: 'react' } },
    )
    await settleSearch()
    expect(result.current.hits).toEqual([HIT])

    rerender({ query: '' })
    expect(result.current.hits).toEqual([])
    expect(result.current.unavailable).toBe(false)
  })
})
