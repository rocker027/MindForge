import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryVaultSetup } from './MemoryVaultSetup'
import type { MemoryVaultScaffoldReport, QmdStatusReport } from './memoryVaultApi'
import type { VaultOption } from '../status-bar/types'

const { trackEventMock } = vi.hoisted(() => ({
  trackEventMock: vi.fn(),
}))

vi.mock('../../lib/telemetry', () => ({
  trackEvent: trackEventMock,
}))

function scaffoldReport(overrides: Partial<MemoryVaultScaffoldReport> = {}): MemoryVaultScaffoldReport {
  return {
    path: '/home/user/MemoryVault',
    createdFiles: ['AGENTS.md', 'wiki/index.md', 'wiki/log.md'],
    skippedFiles: [],
    gitInitialized: true,
    registered: true,
    ...overrides,
  }
}

function qmdInstalled(version: string | null = '1.4.0'): QmdStatusReport {
  return { installed: true, version }
}

function qmdMissing(): QmdStatusReport {
  return { installed: false, version: null }
}

interface RenderOptions {
  vaults?: VaultOption[]
  scaffold?: ReturnType<typeof vi.fn>
  qmdStatus?: ReturnType<typeof vi.fn>
  ensureIndex?: ReturnType<typeof vi.fn>
  onVaultCreated?: ReturnType<typeof vi.fn>
}

async function renderSetup(options: RenderOptions = {}) {
  const scaffold = options.scaffold ?? vi.fn().mockResolvedValue(scaffoldReport())
  const qmdStatus = options.qmdStatus ?? vi.fn().mockResolvedValue(qmdMissing())
  const ensureIndex = options.ensureIndex ?? vi.fn().mockResolvedValue(null)
  const onVaultCreated = options.onVaultCreated ?? vi.fn()

  // Wrap in act so the async getQmdStatus effect settles before assertions.
  await act(async () => {
    render(
      <MemoryVaultSetup
        locale="en"
        vaults={options.vaults ?? []}
        onVaultCreated={onVaultCreated}
        scaffoldMemoryVault={scaffold}
        getQmdStatus={qmdStatus}
        ensureIndex={ensureIndex}
      />,
    )
  })

  return { scaffold, qmdStatus, ensureIndex, onVaultCreated }
}

async function submitCreate() {
  await waitFor(() => expect(screen.getByTestId('memory-vault-create-form')).toBeInTheDocument())
  await act(async () => {
    fireEvent.click(screen.getByTestId('memory-vault-create-button'))
  })
}

describe('MemoryVaultSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('scaffolds a memory vault and shows the created/skipped summary', async () => {
    const { scaffold, onVaultCreated } = await renderSetup()

    await submitCreate()

    await waitFor(() => expect(screen.getByTestId('memory-vault-scaffold-summary')).toBeInTheDocument())
    expect(scaffold).toHaveBeenCalledWith('~/MemoryVault')
    expect(screen.getByText('Created 3 file(s).')).toBeInTheDocument()
    expect(onVaultCreated).toHaveBeenCalledOnce()
    expect(trackEventMock).toHaveBeenCalledWith('memory_vault_created', {
      git_initialized: 1,
      registered: 1,
    })
  })

  it('reports skipped files when re-running scaffold idempotently', async () => {
    const scaffold = vi.fn().mockResolvedValue(
      scaffoldReport({ createdFiles: [], skippedFiles: ['AGENTS.md', 'wiki/index.md'], gitInitialized: false }),
    )
    await renderSetup({ scaffold })

    await submitCreate()

    await waitFor(() => expect(screen.getByTestId('memory-vault-skipped-files')).toBeInTheDocument())
    expect(screen.getByText('Kept 2 existing file(s) untouched.')).toBeInTheDocument()
    expect(screen.getByText('Used the existing git repository.')).toBeInTheDocument()
  })

  it('shows an error and emits failure analytics when scaffold rejects', async () => {
    const scaffold = vi.fn().mockRejectedValue(new Error('permission denied'))
    await renderSetup({ scaffold })

    await submitCreate()

    await waitFor(() => expect(screen.getByTestId('memory-vault-error')).toBeInTheDocument())
    expect(screen.getByTestId('memory-vault-error')).toHaveTextContent('permission denied')
    expect(trackEventMock).toHaveBeenCalledWith('memory_vault_scaffold_failed', {
      error_kind: 'scaffold_error',
    })
  })

  it('triggers background indexing only when qmd is installed', async () => {
    const ensureIndex = vi.fn().mockResolvedValue(null)
    await renderSetup({ qmdStatus: vi.fn().mockResolvedValue(qmdInstalled()), ensureIndex })

    await submitCreate()

    await waitFor(() => expect(screen.getByTestId('memory-vault-indexing-notice')).toBeInTheDocument())
    expect(ensureIndex).toHaveBeenCalledWith('/home/user/MemoryVault', 'tolaria-memory')
  })

  it('does not index when qmd is missing and shows install guidance', async () => {
    const ensureIndex = vi.fn()
    await renderSetup({ qmdStatus: vi.fn().mockResolvedValue(qmdMissing()), ensureIndex })

    await waitFor(() => expect(screen.getByTestId('memory-vault-qmd-missing')).toBeInTheDocument())
    expect(screen.getByText('npm install -g @tobilu/qmd')).toBeInTheDocument()

    await submitCreate()

    await waitFor(() => expect(screen.getByTestId('memory-vault-scaffold-summary')).toBeInTheDocument())
    expect(ensureIndex).not.toHaveBeenCalled()
    expect(screen.queryByTestId('memory-vault-indexing-notice')).not.toBeInTheDocument()
  })

  it('shows the existing-vault status instead of the create form', async () => {
    const memoryVault: VaultOption = {
      label: 'Brain',
      path: '/home/user/MemoryVault',
      kind: 'memory',
      mounted: true,
    }
    const scaffold = vi.fn()
    await renderSetup({ vaults: [memoryVault], scaffold, qmdStatus: vi.fn().mockResolvedValue(qmdInstalled('2.0.0')) })

    await waitFor(() => expect(screen.getByTestId('memory-vault-existing')).toBeInTheDocument())
    expect(screen.getByTestId('memory-vault-existing-path')).toHaveTextContent('/home/user/MemoryVault')
    expect(screen.getByTestId('memory-vault-qmd-ready')).toHaveTextContent('2.0.0')
    expect(screen.queryByTestId('memory-vault-create-form')).not.toBeInTheDocument()
    expect(scaffold).not.toHaveBeenCalled()
  })
})
