import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryIntegrationGuide } from './MemoryIntegrationGuide'
import type { VaultOption } from '../status-bar/types'

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

function renderGuide(vault: VaultOption = memoryVault()) {
  return render(<MemoryIntegrationGuide locale="en" vault={vault} />)
}

describe('MemoryIntegrationGuide', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('shows the qmd registration command built from the vault path and collection alias', () => {
    renderGuide(memoryVault({ alias: 'brain' }))

    const qmdBlock = screen.getByTestId('memory-integration-qmd')
    expect(qmdBlock).toHaveTextContent(
      "qmd collection add /home/user/MemoryVault --name tolaria-brain && qmd collection update-cmd tolaria-brain 'git pull --rebase'",
    )
  })

  it('falls back to the tolaria-memory collection when the vault has no alias', () => {
    renderGuide(memoryVault({ alias: undefined }))

    expect(screen.getByTestId('memory-integration-qmd')).toHaveTextContent(
      'qmd collection add /home/user/MemoryVault --name tolaria-memory',
    )
  })

  it('lists every external tool with a localized note', () => {
    renderGuide()

    for (const id of ['claude_code', 'codex', 'cursor', 'opencode', 'antigravity']) {
      expect(screen.getByTestId(`memory-integration-tool-${id}`)).toBeInTheDocument()
    }
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('Cursor')).toBeInTheDocument()
    expect(screen.getByText('Antigravity')).toBeInTheDocument()
    expect(screen.getByTestId('memory-integration-tool-antigravity')).toHaveTextContent(
      'AGENTS.md filesystem path',
    )
  })

  it('shows the copyable AGENTS.md filesystem path', () => {
    renderGuide()

    expect(screen.getByTestId('memory-integration-schema')).toHaveTextContent(
      '/home/user/MemoryVault/AGENTS.md',
    )
  })

  it('normalizes a trailing slash in the vault path for the schema path', () => {
    renderGuide(memoryVault({ path: '/home/user/MemoryVault/' }))

    expect(screen.getByTestId('memory-integration-schema')).toHaveTextContent(
      '/home/user/MemoryVault/AGENTS.md',
    )
  })

  it('copies the qmd command and emits safe analytics with the target only', async () => {
    renderGuide()

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-integration-qmd-copy'))
    })

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "qmd collection add /home/user/MemoryVault --name tolaria-memory && qmd collection update-cmd tolaria-memory 'git pull --rebase'",
    )
    expect(trackEventMock).toHaveBeenCalledWith('memory_integration_command_copied', {
      target: 'qmd',
    })
  })

  it('copies the schema path and emits a schema analytics event', async () => {
    renderGuide()

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-integration-schema-copy'))
    })

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/home/user/MemoryVault/AGENTS.md')
    expect(trackEventMock).toHaveBeenCalledWith('memory_integration_command_copied', {
      target: 'schema',
    })
  })

  it('renders localized section headings', () => {
    renderGuide()

    expect(screen.getByText('Connect AI tools')).toBeInTheDocument()
    expect(screen.getByText('Register with qmd')).toBeInTheDocument()
    expect(screen.getByText('Filesystem schema')).toBeInTheDocument()
  })
})
