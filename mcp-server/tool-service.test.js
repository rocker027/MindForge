import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from './memory.js'
import { createMcpToolService } from './tool-service.js'

let tmpDir
let firstVault
let secondVault
let memoryVault

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tolaria-mcp-service-'))
  firstVault = path.join(tmpDir, 'First Vault')
  secondVault = path.join(tmpDir, 'Second Vault')
  memoryVault = path.join(tmpDir, 'Memory Vault')
  await mkdir(memoryVault, { recursive: true })

  await seedVault(firstVault, {
    'note/shared.md': noteFixture('Shared Note', 'Shared content from the first vault.'),
    'note/alpha.md': noteFixture('Alpha Project', 'Project planning in the first vault.'),
  })
  await seedVault(secondVault, {
    'AGENTS.md': '# Second Vault Rules\n',
    'note/shared.md': noteFixture('Shared Note', 'Shared content from the second vault.'),
    'note/beta.md': noteFixture('Beta Project', 'Project planning in the second vault.'),
  })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('createMcpToolService', () => {
  it('requires vaultPath when reading an ambiguous note path', async () => {
    const service = makeService()

    await assert.rejects(
      () => service.readNote({ path: 'note/shared.md' }),
      /Note path is ambiguous across active vaults/,
    )

    const note = await service.readNote({
      path: 'note/shared.md',
      vaultPath: secondVault,
    })

    assert.equal(note.vaultPath, secondVault)
    assert.equal(note.vaultLabel, 'Second Vault')
    assert.match(note.content, /second vault/)
  })

  it('creates notes with fallback markdown and emits refresh and tab actions', async () => {
    const emittedActions = []
    const service = makeService({ emittedActions })
    const absolutePath = path.join(secondVault, 'note/created.md')

    const note = await service.createNote({
      path: absolutePath,
      title: 'Created From MCP',
      type: 'Project',
    })

    assert.equal(note.path, 'note/created.md')
    assert.equal(note.vaultPath, secondVault)
    assert.equal(path.basename(note.absolutePath), 'created.md')
    assert.equal(
      await readFile(note.absolutePath, 'utf-8'),
      '---\ntype: "Project"\n---\n\n# Created From MCP\n',
    )
    assert.deepEqual(emittedActions, [
      { action: 'vault_changed', payload: { path: absolutePath } },
      { action: 'open_tab', payload: { path: absolutePath } },
    ])
  })

  it('searches active vaults with consistent vault metadata', async () => {
    const service = makeService()

    const results = await service.searchNotes({ query: 'Project', limit: 2 })

    assert.equal(results.length, 2)
    assert.deepEqual(
      results.map(({ path: notePath, vaultPath, vaultLabel }) => ({
        notePath,
        vaultPath,
        vaultLabel,
      })),
      [
        { notePath: 'note/alpha.md', vaultPath: firstVault, vaultLabel: 'First Vault' },
        { notePath: 'note/beta.md', vaultPath: secondVault, vaultLabel: 'Second Vault' },
      ],
    )
  })

  it('lists active vaults with agent-instruction metadata', async () => {
    const service = makeService()

    assert.deepEqual(await service.listVaults(), {
      vaults: [
        {
          path: firstVault,
          label: 'First Vault',
          agentInstructionsPath: null,
          hasAgentInstructions: false,
        },
        {
          path: secondVault,
          label: 'Second Vault',
          agentInstructionsPath: path.join(secondVault, 'AGENTS.md'),
          hasAgentInstructions: true,
        },
      ],
    })
  })

  it('emits transport-neutral UI intents for note opening and filters', () => {
    const emittedActions = []
    const service = makeService({ emittedActions })

    service.openNoteAsTab({ path: 'note/beta.md', vaultPath: secondVault })
    service.openNoteInEditor({ path: 'note/beta.md', vaultPath: secondVault })
    service.highlightEditor({ element: 'editor', path: 'note/beta.md' })
    service.setFilter({ type: 'Project' })
    service.refreshVault({ path: 'note/beta.md', vaultPath: secondVault })

    assert.deepEqual(emittedActions, [
      { action: 'vault_changed', payload: { path: path.join(secondVault, 'note/beta.md') } },
      { action: 'open_tab', payload: { path: path.join(secondVault, 'note/beta.md') } },
      { action: 'vault_changed', payload: { path: path.join(secondVault, 'note/beta.md') } },
      { action: 'open_note', payload: { path: path.join(secondVault, 'note/beta.md') } },
      { action: 'highlight', payload: { element: 'editor', path: 'note/beta.md' } },
      { action: 'set_filter', payload: { filterType: 'Project' } },
      { action: 'vault_changed', payload: { path: path.join(secondVault, 'note/beta.md') } },
    ])
  })

  it('routes memory writes through the memory service and emits vault refreshes', async () => {
    const emittedActions = []
    const service = makeService({ emittedActions })

    const ingest = await service.memoryIngest({ content: 'Captured fact.', title: 'Memory Note' })
    const logged = await service.memoryLog({ entry: 'Reviewed wiki', kind: 'lint' })
    const recall = await service.memoryRecall({ query: 'Captured fact' })

    assert.equal(ingest.path, 'raw/inbox/memory-note.md')
    assert.equal(recall.engine, 'keyword')
    assert.deepEqual(recall.results.map(result => result.path), ['raw/inbox/memory-note.md'])
    assert.deepEqual(emittedActions, [
      { action: 'vault_changed', payload: { path: ingest.absolutePath } },
      { action: 'vault_changed', payload: { path: logged.absolutePath } },
    ])
  })

  it('adds the memory protocol to vault context only when a memory vault is mounted', async () => {
    const service = makeService()

    const ctx = await service.vaultContext({ vaultPath: firstVault })

    assert.equal(ctx.memoryProtocol.memoryVaultPath, memoryVault)
    assert.equal(ctx.memoryProtocol.schemaPath, path.join(memoryVault, 'AGENTS.md'))
    assert.match(ctx.memoryProtocol.summary, /memory_recall/)
    assert.match(ctx.memoryProtocol.summary, /memory_ingest/)
    assert.match(ctx.memoryProtocol.summary, /memory_log/)
  })

  it('keeps vault context working when the memory service is broken', async () => {
    const service = makeService({
      memoryService: {
        memoryVaultPath: () => {
          throw new Error('broken vaults.json')
        },
      },
    })

    const ctx = await service.vaultContext({ vaultPath: firstVault })

    assert.equal('memoryProtocol' in ctx, false)
  })
})

function makeService({ emittedActions = [], memoryService } = {}) {
  return createMcpToolService({
    resolveVaultPaths: () => [firstVault, secondVault],
    emitUiAction: (action, payload) => {
      emittedActions.push({ action, payload })
    },
    memoryService: memoryService ?? createMemoryService({
      resolveMemoryVaultPath: () => memoryVault,
      runQmdQuery: async () => {
        throw new Error('qmd: command not found')
      },
    }),
  })
}

async function seedVault(vaultPath, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(vaultPath, relativePath)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, content, 'utf-8')
  }
}

function noteFixture(title, body) {
  return `---\ntitle: ${JSON.stringify(title)}\ntype: Note\n---\n\n# ${title}\n\n${body}\n`
}
