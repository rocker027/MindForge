import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MEMORY_VAULT_MISSING_ERROR, createMemoryService } from './memory.js'
import { configuredMemoryVaultPath, resolveInsideVault } from './vault-path.js'

let tmpDir
let memoryVault

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tolaria-mcp-memory-'))
  memoryVault = path.join(tmpDir, 'Memory Vault')

  await seedFile(
    path.join(memoryVault, 'wiki', 'vector-search.md'),
    '---\ntype: Wiki\n---\n\n# Vector Search\n\nHybrid retrieval tradeoffs and reranking notes.\n',
  )
  await seedFile(
    path.join(memoryVault, 'wiki', 'index.md'),
    '# Index\n\n- [[vector-search]] — hybrid retrieval tradeoffs.\n',
  )
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('memory recall', () => {
  it('falls back to keyword search scoped to the memory vault when qmd is missing', async () => {
    const service = makeService()

    const recall = await service.recall({ query: 'reranking' })

    assert.equal(recall.engine, 'keyword')
    assert.equal(recall.memoryVaultPath, memoryVault)
    assert.deepEqual(recall.results.map(result => result.path), ['wiki/vector-search.md'])
  })

  it('falls back to keyword search when qmd output is malformed or empty', async () => {
    for (const stdout of ['not json', '{"unexpected": true}', '[]']) {
      const service = makeService({ runQmdQuery: async () => stdout })
      const recall = await service.recall({ query: 'reranking' })
      assert.equal(recall.engine, 'keyword')
    }
  })

  it('returns qmd results, dropping entries that resolve outside the vault', async () => {
    const service = makeService({
      runQmdQuery: async () => JSON.stringify([
        { file: 'wiki/vector-search.md', snippet: 'reranking notes', score: 0.91 },
        { file: '/etc/passwd', snippet: 'outside absolute' },
        { file: '../../outside.md', snippet: 'outside traversal' },
      ]),
    })

    const recall = await service.recall({ query: 'reranking' })

    assert.equal(recall.engine, 'qmd')
    assert.deepEqual(recall.results, [{
      path: 'wiki/vector-search.md',
      title: 'vector-search',
      snippet: 'reranking notes',
      score: 0.91,
    }])
  })

  it('forwards the recall limit to the qmd query runner', async () => {
    const seenLimits = []
    const service = makeService({
      runQmdQuery: async (query, limit) => {
        seenLimits.push(limit)
        return JSON.stringify([{ file: 'wiki/vector-search.md', score: 0.9 }])
      },
    })

    await service.recall({ query: 'retrieval', limit: 3 })
    await service.recall({ query: 'retrieval' })

    assert.deepEqual(seenLimits, [3, 10])
  })

  it('strips qmd:// collection URIs so real qmd hits resolve inside the vault', async () => {
    const service = makeService({
      runQmdQuery: async () => JSON.stringify([
        { file: 'qmd://memory/wiki/vector-search.md', snippet: 'reranking notes', score: 0.91 },
        { file: 'qmd://notes/not-in-this-vault.md', snippet: 'other collection' },
      ]),
    })

    const recall = await service.recall({ query: 'reranking' })

    assert.equal(recall.engine, 'qmd')
    assert.deepEqual(recall.results, [{
      path: 'wiki/vector-search.md',
      title: 'vector-search',
      snippet: 'reranking notes',
      score: 0.91,
    }])
  })

  it('accepts the qmd object output shape and applies the limit', async () => {
    const service = makeService({
      runQmdQuery: async () => JSON.stringify({
        results: [
          { file: 'wiki/vector-search.md', score: 0.9 },
          { file: 'wiki/index.md', score: 0.5 },
        ],
      }),
    })

    const recall = await service.recall({ query: 'retrieval', limit: 1 })

    assert.equal(recall.engine, 'qmd')
    assert.deepEqual(recall.results.map(result => result.path), ['wiki/vector-search.md'])
  })

  it('rejects when no memory vault is configured', async () => {
    const service = makeService({ resolveMemoryVaultPath: () => null })

    await assert.rejects(() => service.recall({ query: 'anything' }), {
      message: MEMORY_VAULT_MISSING_ERROR,
    })
  })

  it('rejects when the memory vault directory does not exist', async () => {
    const missing = path.join(tmpDir, 'missing-vault')
    const service = makeService({ resolveMemoryVaultPath: () => missing })

    await assert.rejects(() => service.recall({ query: 'anything' }), /does not exist/)
  })
})

describe('memory ingest', () => {
  it('writes a frontmatter capture into raw/inbox and appends a log entry', async () => {
    const service = makeService()

    const result = await service.ingest({
      content: 'Learned a thing about reranking.',
      title: 'Conference Notes',
      source: 'https://example.com/talk',
    })

    assert.equal(result.path, 'raw/inbox/conference-notes.md')
    assert.equal(result.logEntry, '## [2026-06-12] capture | Conference Notes')
    assert.equal(
      await readFile(path.join(memoryVault, result.path), 'utf-8'),
      '---\ntitle: "Conference Notes"\nsource: "https://example.com/talk"\ncaptured: 2026-06-12\n---\n\nLearned a thing about reranking.\n',
    )
    assert.equal(
      await readFile(path.join(memoryVault, 'wiki', 'log.md'), 'utf-8'),
      '## [2026-06-12] capture | Conference Notes\n',
    )
  })

  it('omits the source line when no source is given', async () => {
    const service = makeService()

    const result = await service.ingest({ content: 'Body.', title: 'No Source' })

    assert.equal(
      await readFile(path.join(memoryVault, result.path), 'utf-8'),
      '---\ntitle: "No Source"\ncaptured: 2026-06-12\n---\n\nBody.\n',
    )
  })

  it('slugifies traversal attempts into safe inbox file names', async () => {
    const service = makeService()

    const result = await service.ingest({ content: 'Body.', title: '../../../etc/passwd' })

    assert.equal(result.path, 'raw/inbox/etc-passwd.md')
  })

  it('keeps unicode titles readable in slugs', async () => {
    const service = makeService()

    const result = await service.ingest({ content: 'Body.', title: '向量檢索心得' })

    assert.equal(result.path, 'raw/inbox/向量檢索心得.md')
  })

  it('suffixes duplicate slugs instead of overwriting', async () => {
    const service = makeService()

    const first = await service.ingest({ content: 'First body.', title: 'Conference Notes' })
    const second = await service.ingest({ content: 'Second body.', title: 'Conference Notes' })

    assert.equal(first.path, 'raw/inbox/conference-notes.md')
    assert.equal(second.path, 'raw/inbox/conference-notes-2.md')
    assert.match(await readFile(path.join(memoryVault, first.path), 'utf-8'), /First body\./)
    assert.match(await readFile(path.join(memoryVault, second.path), 'utf-8'), /Second body\./)
  })

  it('rejects captures without content or title', async () => {
    const service = makeService()

    await assert.rejects(() => service.ingest({ title: 'Only Title' }), /content is required/)
    await assert.rejects(() => service.ingest({ content: 'Only content.' }), /title is required/)
  })
})

describe('memory log', () => {
  it('appends formatted entries to wiki/log.md', async () => {
    const service = makeService()

    const result = await service.log({ entry: 'Health-checked the wiki', kind: 'lint' })

    assert.equal(result.logPath, 'wiki/log.md')
    assert.equal(result.absolutePath, path.join(memoryVault, 'wiki', 'log.md'))
    assert.equal(result.logEntry, '## [2026-06-12] lint | Health-checked the wiki')
    assert.equal(
      await readFile(result.absolutePath, 'utf-8'),
      '## [2026-06-12] lint | Health-checked the wiki\n',
    )
  })

  it('accumulates entries append-only in call order', async () => {
    const service = makeService()

    await service.log({ entry: 'First pass', kind: 'ingest' })
    await service.log({ entry: 'Second pass', kind: 'query' })

    assert.equal(
      await readFile(path.join(memoryVault, 'wiki', 'log.md'), 'utf-8'),
      '## [2026-06-12] ingest | First pass\n## [2026-06-12] query | Second pass\n',
    )
  })

  it('starts on a fresh line when the log lacks a trailing newline', async () => {
    await seedFile(path.join(memoryVault, 'wiki', 'log.md'), '# Log')
    const service = makeService()

    await service.log({ entry: 'After manual edit', kind: 'capture' })

    assert.equal(
      await readFile(path.join(memoryVault, 'wiki', 'log.md'), 'utf-8'),
      '# Log\n## [2026-06-12] capture | After manual edit\n',
    )
  })

  it('rejects unknown kinds and empty entries', async () => {
    const service = makeService()

    await assert.rejects(
      () => service.log({ entry: 'Valid entry', kind: 'destroy' }),
      /kind must be one of: ingest, query, lint, capture/,
    )
    await assert.rejects(() => service.log({ kind: 'ingest' }), /entry is required/)
  })
})

describe('configuredMemoryVaultPath', () => {
  it('returns the mounted vault with kind memory', async () => {
    const configDir = await writeVaultsJson({
      vaults: [
        { path: '/tmp/regular-vault', kind: 'notes' },
        { path: memoryVault, kind: 'memory' },
      ],
    })

    assert.equal(configuredMemoryVaultPath({ configDir }), memoryVault)
  })

  it('ignores unmounted memory vaults', async () => {
    const configDir = await writeVaultsJson({
      vaults: [{ path: memoryVault, kind: 'memory', mounted: false }],
    })

    assert.equal(configuredMemoryVaultPath({ configDir }), null)
  })

  it('returns null when vaults.json is absent', async () => {
    assert.equal(configuredMemoryVaultPath({ configDir: path.join(tmpDir, 'no-config') }), null)
  })
})

describe('resolveInsideVault', () => {
  it('resolves relative paths inside the vault', () => {
    assert.equal(
      resolveInsideVault(memoryVault, 'raw/inbox/note.md'),
      path.join(memoryVault, 'raw', 'inbox', 'note.md'),
    )
  })

  it('rejects traversal, vault-root, and outside absolute targets', () => {
    const rejected = ['../escape.md', '', path.join(os.tmpdir(), 'outside.md')]
    for (const target of rejected) {
      assert.throws(
        () => resolveInsideVault(memoryVault, target),
        /Path must stay inside the vault/,
      )
    }
  })
})

function makeService(overrides = {}) {
  return createMemoryService({
    resolveMemoryVaultPath: () => memoryVault,
    runQmdQuery: async () => {
      throw new Error('qmd: command not found')
    },
    now: () => new Date(2026, 5, 12),
    ...overrides,
  })
}

async function seedFile(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf-8')
}

async function writeVaultsJson(list) {
  const configDir = path.join(tmpDir, 'config')
  const appDir = path.join(configDir, 'com.tolaria.app')
  await mkdir(appDir, { recursive: true })
  await writeFile(path.join(appDir, 'vaults.json'), JSON.stringify(list), 'utf-8')
  return configDir
}
