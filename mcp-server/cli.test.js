import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, qmdCollectionName, runCli } from './cli-commands.js'
import { expandTilde } from './cli-scaffold.js'
import { createMemoryService } from './memory.js'

const execFileAsync = promisify(execFile)
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const FIXED_NOW = () => new Date(2026, 5, 12)
const EXPECTED_TEMPLATE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.gitignore',
  'wiki/index.md',
  'wiki/log.md',
  'wiki/overview.md',
  'raw/inbox/.gitkeep',
  'raw/assets/.gitkeep',
]

let tmpDir
let configDir
let memoryVault

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tolaria-mem-cli-'))
  configDir = path.join(tmpDir, 'config')
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

describe('cli usage handling', () => {
  it('exits 2 with usage when no command is given', async () => {
    const result = await runCapture([])

    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.stderr, /Missing command/)
    assert.match(result.stderr, /Usage: tolaria-mem/)
  })

  it('exits 2 on unknown commands and unknown options', async () => {
    assert.equal((await runCapture(['bogus'])).code, EXIT_USAGE)
    assert.equal((await runCapture(['recall', 'query', '--bogus'])).code, EXIT_USAGE)
  })

  it('prints usage on help with exit 0', async () => {
    const result = await runCapture(['help'])

    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /Usage: tolaria-mem/)
  })

  it('cli.js wrapper exits 2 with usage on missing command', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, ['cli.js'], { cwd: MODULE_DIR }),
      (error) => {
        assert.equal(error.code, EXIT_USAGE)
        assert.match(error.stderr, /Usage: tolaria-mem/)
        return true
      },
    )
  })
})

describe('tolaria-mem scaffold', () => {
  it('creates the template structure, replaces {{DATE}}, inits git, and registers', async () => {
    const target = path.join(tmpDir, 'memory-vault')
    const git = fakeGitRunner()

    const result = await runCapture(['scaffold', target, '--json'], scaffoldDeps(git))
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, EXIT_OK)
    assert.deepEqual(report.createdFiles, EXPECTED_TEMPLATE_FILES)
    assert.deepEqual(report.skippedFiles, [])
    assert.equal(report.gitInitialized, true)
    assert.equal(report.registered, true)
    for (const file of EXPECTED_TEMPLATE_FILES) {
      assert.ok(existsSync(path.join(target, file)), `${file} should exist`)
    }
    const log = await readFile(path.join(target, 'wiki', 'log.md'), 'utf-8')
    assert.match(log, /## \[2026-06-12\] init \| Memory vault scaffolded/)
    assert.ok(!log.includes('{{DATE}}'))
    assert.deepEqual(
      git.calls.map(call => call.args[0] === '-c' ? 'commit' : call.args[0]),
      ['init', 'config', 'config', 'config', 'config', 'add', 'commit'],
    )
  })

  it('writes vaults.json byte-identical to the Rust serde format', async () => {
    const target = path.join(tmpDir, 'memory-vault')

    const result = await runCapture(['scaffold', target, '--json'], scaffoldDeps(fakeGitRunner()))
    const report = JSON.parse(result.stdout)

    const expected = JSON.stringify({
      vaults: [{
        label: 'memory-vault',
        path: report.path,
        alias: null,
        shortLabel: null,
        color: null,
        icon: null,
        mounted: true,
        kind: 'memory',
      }],
      active_vault: null,
      default_workspace_path: null,
      hidden_defaults: [],
    }, null, 2)
    assert.equal(await readFile(vaultsJsonFile(), 'utf-8'), expected)
  })

  it('is idempotent: preserves edits, skips git, and never duplicates the entry', async () => {
    const target = path.join(tmpDir, 'memory-vault')
    const indexPath = path.join(target, 'wiki', 'index.md')
    await runCapture(['scaffold', target], scaffoldDeps(fakeGitRunner()))
    await writeFile(indexPath, 'user edited', 'utf-8')

    const result = await runCapture(['scaffold', target, '--json'], scaffoldDeps(fakeGitRunner()))
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, EXIT_OK)
    assert.deepEqual(report.createdFiles, [])
    assert.equal(report.skippedFiles.length, EXPECTED_TEMPLATE_FILES.length)
    assert.equal(report.gitInitialized, false)
    assert.equal(report.registered, false)
    assert.equal(await readFile(indexPath, 'utf-8'), 'user edited')
    assert.equal(JSON.parse(await readFile(vaultsJsonFile(), 'utf-8')).vaults.length, 1)
  })

  it('appends to an existing vaults.json, normalizing legacy entries', async () => {
    await writeVaultsJson({
      vaults: [{ label: 'Notes', path: '/tmp/notes' }],
      active_vault: '/tmp/notes',
    })
    const target = path.join(tmpDir, 'memory-vault')

    await runCapture(['scaffold', target], scaffoldDeps(fakeGitRunner()))

    const list = JSON.parse(await readFile(vaultsJsonFile(), 'utf-8'))
    assert.equal(list.vaults.length, 2)
    assert.deepEqual(list.vaults[0], {
      label: 'Notes',
      path: '/tmp/notes',
      alias: null,
      shortLabel: null,
      color: null,
      icon: null,
      mounted: null,
      kind: 'notes',
    })
    assert.equal(list.vaults[1].kind, 'memory')
    assert.equal(list.active_vault, '/tmp/notes')
  })

  it('requires a target path', async () => {
    assert.equal((await runCapture(['scaffold'])).code, EXIT_USAGE)
  })
})

describe('tolaria-mem status', () => {
  it('reports vault path, collection, counts, and qmd version as JSON', async () => {
    await seedFile(path.join(memoryVault, 'raw', 'inbox', 'talk.txt'), 'raw source')
    await seedFile(path.join(memoryVault, 'raw', 'inbox', '.gitkeep'), '')
    await writeVaultsJson({ vaults: [{ label: 'Memory', path: memoryVault, kind: 'memory' }] })

    const result = await runCapture(['status', '--json'], {
      configDir,
      runQmdVersion: async () => 'qmd 0.6.5 (1a2b3c)\n',
    })

    assert.equal(result.code, EXIT_OK)
    assert.deepEqual(JSON.parse(result.stdout), {
      memoryVault: {
        path: memoryVault,
        label: 'Memory',
        collection: 'tolaria-memory',
        exists: true,
        wikiPages: 2,
        rawFiles: 1,
      },
      qmd: { installed: true, version: '0.6.5 (1a2b3c)' },
    })
  })

  it('derives the qmd collection name from the vault alias', async () => {
    assert.equal(qmdCollectionName({ alias: 'research' }), 'tolaria-research')
    assert.equal(qmdCollectionName({ alias: null }), 'tolaria-memory')
    assert.equal(qmdCollectionName(null), 'tolaria-memory')
  })

  it('guides toward scaffold when no memory vault is configured', async () => {
    const result = await runCapture(['status'], {
      configDir,
      runQmdVersion: async () => { throw new Error('qmd: command not found') },
    })

    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /Memory vault: not configured/)
    assert.match(result.stdout, /tolaria-mem scaffold/)
    assert.match(result.stdout, /qmd: not installed/)
  })
})

describe('tolaria-mem recall', () => {
  it('emits a single JSON object with the keyword fallback when qmd is missing', async () => {
    const result = await runCapture(['recall', 'reranking', '--json'], serviceDeps())
    const recall = JSON.parse(result.stdout)

    assert.equal(result.code, EXIT_OK)
    assert.equal(recall.engine, 'keyword')
    assert.equal(recall.memoryVaultPath, memoryVault)
    assert.deepEqual(recall.results.map(hit => hit.path), ['wiki/vector-search.md'])
  })

  it('prints qmd hits with scores in human output', async () => {
    const result = await runCapture(['recall', 'reranking', '--limit', '5'], serviceDeps({
      runQmdQuery: async () => JSON.stringify([
        { file: 'wiki/vector-search.md', snippet: 'reranking notes', score: 0.91 },
      ]),
    }))

    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /1 result\(s\) via qmd/)
    assert.match(result.stdout, /wiki\/vector-search\.md \(score 0\.91\)/)
  })

  it('rejects invalid limits and missing queries as usage errors', async () => {
    assert.equal((await runCapture(['recall', 'q', '--limit', 'abc'])).code, EXIT_USAGE)
    assert.equal((await runCapture(['recall', 'q', '--limit', '0'])).code, EXIT_USAGE)
    assert.equal((await runCapture(['recall'])).code, EXIT_USAGE)
  })

  it('exits 1 with a scaffold hint when no memory vault is configured', async () => {
    const result = await runCapture(['recall', 'anything'], {
      configDir,
      runQmdQuery: async () => { throw new Error('qmd: command not found') },
    })

    assert.equal(result.code, EXIT_ERROR)
    assert.match(result.stderr, /No memory vault is configured/)
    assert.match(result.stderr, /tolaria-mem scaffold/)
  })
})

describe('tolaria-mem ingest', () => {
  it('captures a file into raw/inbox with a title derived from the file name', async () => {
    const source = path.join(tmpDir, 'talk-notes.md')
    await writeFile(source, 'Learned a thing about reranking.\n', 'utf-8')

    const result = await runCapture(
      ['ingest', source, '--source', 'https://example.com/talk', '--json'],
      serviceDeps(),
    )
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, EXIT_OK)
    assert.equal(report.path, 'raw/inbox/talk-notes.md')
    assert.equal(report.logEntry, '## [2026-06-12] capture | talk-notes')
    assert.equal(
      await readFile(path.join(memoryVault, report.path), 'utf-8'),
      '---\ntitle: "talk-notes"\nsource: "https://example.com/talk"\ncaptured: 2026-06-12\n---\n\nLearned a thing about reranking.\n',
    )
  })

  it('captures stdin when the file argument is -', async () => {
    const result = await runCapture(['ingest', '-', '--title', 'Stdin Capture', '--json'], {
      ...serviceDeps(),
      readStdin: async () => 'Body from stdin.',
    })
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, EXIT_OK)
    assert.equal(report.path, 'raw/inbox/stdin-capture.md')
    assert.match(await readFile(path.join(memoryVault, report.path), 'utf-8'), /Body from stdin\./)
  })

  it('requires --title for stdin and a file argument', async () => {
    assert.equal((await runCapture(['ingest', '-'], serviceDeps())).code, EXIT_USAGE)
    assert.equal((await runCapture(['ingest'], serviceDeps())).code, EXIT_USAGE)
  })

  it('exits 1 with a clear message for missing files', async () => {
    const result = await runCapture(['ingest', path.join(tmpDir, 'nope.md')], serviceDeps())

    assert.equal(result.code, EXIT_ERROR)
    assert.match(result.stderr, /File not found/)
  })
})

describe('tolaria-mem log', () => {
  it('appends a formatted entry, joining multi-word arguments', async () => {
    const result = await runCapture(['log', 'lint', 'Checked', 'the', 'wiki'], serviceDeps())

    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /Appended to wiki\/log\.md/)
    assert.equal(
      await readFile(path.join(memoryVault, 'wiki', 'log.md'), 'utf-8'),
      '## [2026-06-12] lint | Checked the wiki\n',
    )
  })

  it('rejects unknown kinds and missing entries as usage errors', async () => {
    assert.equal((await runCapture(['log', 'destroy', 'entry'])).code, EXIT_USAGE)
    assert.equal((await runCapture(['log', 'lint'])).code, EXIT_USAGE)
    assert.equal((await runCapture(['log'])).code, EXIT_USAGE)
  })
})

describe('expandTilde', () => {
  it('expands the home prefix and leaves other paths untouched', () => {
    assert.equal(expandTilde('~'), os.homedir())
    assert.equal(expandTilde('~/memory'), path.join(os.homedir(), 'memory'))
    assert.equal(expandTilde('/absolute/memory'), '/absolute/memory')
    assert.equal(expandTilde('relative/memory'), 'relative/memory')
  })
})

// --- helpers ---

async function runCapture(argv, deps = {}) {
  const stdout = captureStream()
  const stderr = captureStream()
  const code = await runCli(argv, { stdout, stderr, ...deps })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

function captureStream() {
  const chunks = []
  return {
    write: (chunk) => {
      chunks.push(chunk)
      return true
    },
    get text() {
      return chunks.join('')
    },
  }
}

function serviceDeps(overrides = {}) {
  return {
    memoryService: createMemoryService({
      resolveMemoryVaultPath: () => memoryVault,
      runQmdQuery: async () => {
        throw new Error('qmd: command not found')
      },
      now: FIXED_NOW,
      ...overrides,
    }),
  }
}

function scaffoldDeps(git) {
  return { configDir, now: FIXED_NOW, runGit: git.runGit }
}

/** Records git invocations; `init` creates .git so idempotency checks work. */
function fakeGitRunner() {
  const calls = []
  return {
    calls,
    runGit: (args, cwd) => {
      calls.push({ args, cwd })
      if (args[0] === 'init') mkdirSync(path.join(cwd, '.git'), { recursive: true })
      if (args[0] === 'config' && args.length === 2) throw new Error(`${args[1]} is unset`)
      return ''
    },
  }
}

function vaultsJsonFile() {
  return path.join(configDir, 'com.tolaria.app', 'vaults.json')
}

async function writeVaultsJson(list) {
  const appDir = path.join(configDir, 'com.tolaria.app')
  await mkdir(appDir, { recursive: true })
  await writeFile(path.join(appDir, 'vaults.json'), JSON.stringify(list), 'utf-8')
}

async function seedFile(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf-8')
}
