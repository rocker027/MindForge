import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryLint } from './MemoryLint'
import type { VaultOption } from '../status-bar/types'
import type { streamAiAgent } from '../../utils/streamAiAgent'
import type { readMemoryLintReport } from './memoryVaultApi'

const { trackEventMock } = vi.hoisted(() => ({
  trackEventMock: vi.fn(),
}))

vi.mock('../../lib/telemetry', () => ({
  trackEvent: trackEventMock,
}))

const SAMPLE_REPORT = [
  '# Lint report',
  '',
  '## Orphan pages',
  '',
  '- [[stray-note]] is not reachable from wiki/index.md.',
  '',
  '## Broken links',
  '',
  '- [[missing-target]] referenced by [[acme-corp]] has no page.',
].join('\n')

function memoryVault(overrides: Partial<VaultOption> = {}): VaultOption {
  return {
    label: 'Brain',
    path: '/home/user/MemoryVault',
    kind: 'memory',
    mounted: true,
    ...overrides,
  }
}

/** Build a streamAiAgent double that resolves immediately by default. */
function fakeStream(): typeof streamAiAgent {
  return vi.fn(async () => {}) as unknown as typeof streamAiAgent
}

function renderLint(options: {
  read?: ReturnType<typeof vi.fn>
  report?: string | null
  stream?: typeof streamAiAgent
} = {}) {
  const read =
    options.read ?? vi.fn().mockResolvedValue(options.report ?? null)
  const stream = options.stream ?? fakeStream()
  render(
    <MemoryLint
      locale="en"
      vault={memoryVault()}
      readLintReport={read as unknown as typeof readMemoryLintReport}
      streamAgent={stream}
    />,
  )
  return { read, stream }
}

describe('MemoryLint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the no-report state when no lint report exists yet', async () => {
    renderLint({ report: null })

    expect(await screen.findByTestId('memory-lint-empty')).toBeInTheDocument()
    expect(screen.getByTestId('memory-lint-no-report')).toBeInTheDocument()
    expect(screen.queryByTestId('memory-lint-report')).not.toBeInTheDocument()
  })

  it('reads the report for the memory vault path on mount', async () => {
    const { read } = renderLint()

    await waitFor(() => expect(read).toHaveBeenCalledWith('/home/user/MemoryVault'))
  })

  it('renders an existing report as markdown on mount', async () => {
    renderLint({ report: SAMPLE_REPORT })

    const reportBlock = await screen.findByTestId('memory-lint-report')
    expect(reportBlock).toBeInTheDocument()
    expect(reportBlock.querySelector('h1')).toHaveTextContent('Lint report')
    expect(reportBlock.querySelector('h2')).toHaveTextContent('Orphan pages')
    expect(reportBlock).toHaveTextContent('is not reachable from wiki/index.md.')
  })

  it('runs lint via the streaming agent with the vault path and emits analytics', async () => {
    const stream = fakeStream()
    renderLint({ stream })

    await screen.findByTestId('memory-lint-empty')

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-lint-run'))
    })

    expect(stream).toHaveBeenCalledTimes(1)
    const request = (stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(request.vaultPath).toBe('/home/user/MemoryVault')
    expect(request.agent).toBe('claude_code')
    expect(request.permissionMode).toBe('power_user')
    expect(request.message).toContain('## Lint workflow')
    expect(request.message).toContain('wiki/lint-report.md')

    expect(trackEventMock).toHaveBeenCalledWith('memory_lint_started', {})
  })

  it('renders the freshly generated report after a successful lint run', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(SAMPLE_REPORT)
    renderLint({ read })

    await screen.findByTestId('memory-lint-empty')

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-lint-run'))
    })

    expect(await screen.findByTestId('memory-lint-done')).toBeInTheDocument()
    const reportBlock = await screen.findByTestId('memory-lint-report')
    expect(reportBlock).toHaveTextContent('Broken links')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('falls back to the no-report state when the run produces no report', async () => {
    const read = vi.fn().mockResolvedValue(null)
    renderLint({ read })

    await screen.findByTestId('memory-lint-empty')

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-lint-run'))
    })

    expect(await screen.findByTestId('memory-lint-no-report')).toBeInTheDocument()
    expect(screen.queryByTestId('memory-lint-done')).not.toBeInTheDocument()
  })

  it('surfaces a lint failure reported by the agent stream', async () => {
    const failingStream = vi.fn(async ({ callbacks }: { callbacks: { onError: (m: string) => void } }) => {
      callbacks.onError('agent crashed')
    }) as unknown as typeof streamAiAgent
    renderLint({ stream: failingStream })

    await screen.findByTestId('memory-lint-empty')

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-lint-run'))
    })

    const banner = await screen.findByTestId('memory-lint-error')
    expect(banner).toHaveTextContent('agent crashed')
  })
})
