import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryInbox } from './MemoryInbox'
import type { MemoryInboxSource } from './memoryVaultApi'
import type { VaultOption } from '../status-bar/types'
import type { streamAiAgent } from '../../utils/streamAiAgent'

const { trackEventMock } = vi.hoisted(() => ({
  trackEventMock: vi.fn(),
}))

vi.mock('../../lib/telemetry', () => ({
  trackEvent: trackEventMock,
}))

function memoryVault(overrides: Partial<VaultOption> = {}): VaultOption {
  return {
    label: 'Brain',
    path: '/home/user/MemoryVault',
    kind: 'memory',
    mounted: true,
    ...overrides,
  }
}

const INBOX_SOURCES: MemoryInboxSource[] = [
  { relativePath: 'raw/inbox/conference.md', name: 'conference.md' },
  { relativePath: 'raw/inbox/kickoff.md', name: 'kickoff.md' },
]

/** Build a streamAiAgent double that resolves immediately by default. */
function fakeStream(): typeof streamAiAgent {
  return vi.fn(async () => {}) as unknown as typeof streamAiAgent
}

function renderInbox(options: {
  sources?: MemoryInboxSource[]
  list?: ReturnType<typeof vi.fn>
  stream?: typeof streamAiAgent
} = {}) {
  const list =
    options.list ?? vi.fn().mockResolvedValue(options.sources ?? INBOX_SOURCES)
  const stream = options.stream ?? fakeStream()
  render(
    <MemoryInbox
      locale="en"
      vault={memoryVault()}
      listInboxSources={list as never}
      streamAgent={stream}
    />,
  )
  return { list, stream }
}

describe('MemoryInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists the pending raw/inbox sources returned by the vault rescan', async () => {
    renderInbox()

    expect(await screen.findByTestId('memory-inbox-list')).toBeInTheDocument()
    expect(screen.getByTestId('memory-inbox-item-conference.md')).toHaveTextContent('conference.md')
    expect(screen.getByTestId('memory-inbox-item-kickoff.md')).toHaveTextContent('kickoff.md')
    expect(screen.getByTestId('memory-inbox-list')).toHaveTextContent('2 source(s)')
  })

  it('passes the memory vault path to the listing call', async () => {
    const { list } = renderInbox()

    await waitFor(() => expect(list).toHaveBeenCalledWith('/home/user/MemoryVault'))
  })

  it('shows the empty state when the inbox has no sources', async () => {
    renderInbox({ sources: [] })

    expect(await screen.findByTestId('memory-inbox-empty')).toBeInTheDocument()
    expect(screen.getByTestId('memory-inbox-ingest')).toBeDisabled()
  })

  it('ingests via the streaming agent with the vault path and emits analytics', async () => {
    const stream = fakeStream()
    renderInbox({ stream })

    await screen.findByTestId('memory-inbox-list')

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-inbox-ingest'))
    })

    expect(stream).toHaveBeenCalledTimes(1)
    const request = (stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(request.vaultPath).toBe('/home/user/MemoryVault')
    expect(request.agent).toBe('claude_code')
    expect(request.permissionMode).toBe('power_user')
    expect(request.message).toContain('## Ingest workflow')
    expect(request.message).toContain('raw/inbox/')

    expect(trackEventMock).toHaveBeenCalledWith('memory_inbox_ingest_started', {
      source_count: 2,
    })
  })

  it('re-lists the inbox and shows a done banner after a successful ingest', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(INBOX_SOURCES)
      .mockResolvedValueOnce([])
    renderInbox({ list })

    await screen.findByTestId('memory-inbox-list')

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-inbox-ingest'))
    })

    expect(await screen.findByTestId('memory-inbox-done')).toBeInTheDocument()
    expect(await screen.findByTestId('memory-inbox-empty')).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('surfaces an ingest failure reported by the agent stream', async () => {
    const failingStream = vi.fn(async ({ callbacks }: { callbacks: { onError: (m: string) => void } }) => {
      callbacks.onError('agent crashed')
    }) as unknown as typeof streamAiAgent
    renderInbox({ stream: failingStream })

    await screen.findByTestId('memory-inbox-list')

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-inbox-ingest'))
    })

    const banner = await screen.findByTestId('memory-inbox-error')
    expect(banner).toHaveTextContent('agent crashed')
  })

  it('shows a load error when the inbox cannot be read', async () => {
    const list = vi.fn().mockRejectedValue(new Error('disk gone'))
    renderInbox({ list })

    const banner = await screen.findByTestId('memory-inbox-load-error')
    expect(banner).toHaveTextContent('disk gone')
  })
})
