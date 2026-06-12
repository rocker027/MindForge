/**
 * Memory vault operations — cross-tool LLM wiki memory (ADR-0140, ADR-0142).
 *
 * memory_recall prefers qmd hybrid retrieval (ADR-0141) and degrades to the
 * built-in keyword search when qmd is missing or fails. memory_ingest captures
 * new material into raw/inbox/, and memory_log appends to the append-only
 * wiki/log.md activity log. Every write path is validated against the memory
 * vault boundary so tools can never escape it.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { configuredMemoryVaultPath, resolveInsideVault } from './vault-path.js'
import { createNote, searchNotes } from './vault.js'

const execFileAsync = promisify(execFile)

const DEFAULT_RECALL_LIMIT = 10
const MAX_SLUG_LENGTH = 80
const MAX_SLUG_ATTEMPTS = 50
const QMD_QUERY_TIMEOUT_MS = 30_000
const QMD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const INBOX_DIR = 'raw/inbox'
const LOG_PATH = 'wiki/log.md'

/** Allowed wiki/log.md activity verbs, mirroring the memory vault AGENTS.md schema. */
export const LOG_KINDS = Object.freeze(['ingest', 'query', 'lint', 'capture'])

export const MEMORY_VAULT_MISSING_ERROR =
  'No memory vault is configured. Mount a vault with kind "memory" in Tolaria before using memory tools.'

export function createMemoryService({
  resolveMemoryVaultPath = () => configuredMemoryVaultPath(),
  runQmdQuery = defaultRunQmdQuery,
  now = () => new Date(),
} = {}) {
  function memoryVaultPath() {
    const vaultPath = resolveMemoryVaultPath()
    return typeof vaultPath === 'string' && vaultPath.trim() ? vaultPath.trim() : null
  }

  function requireMemoryVaultPath() {
    const vaultPath = memoryVaultPath()
    if (!vaultPath) throw new Error(MEMORY_VAULT_MISSING_ERROR)
    if (!existsSync(vaultPath)) {
      throw new Error(`Memory vault directory does not exist: ${vaultPath}`)
    }
    return vaultPath
  }

  async function recall(args = {}) {
    const query = requireString(args.query, 'query')
    const limit = normalizeLimit(args.limit)
    const vaultPath = requireMemoryVaultPath()

    const qmdResults = await tryQmdRecall(runQmdQuery, vaultPath, query, limit)
    if (qmdResults?.length) {
      return { memoryVaultPath: vaultPath, engine: 'qmd', results: qmdResults }
    }

    const results = await searchNotes(vaultPath, query, limit)
    return { memoryVaultPath: vaultPath, engine: 'keyword', results }
  }

  async function ingest(args = {}) {
    const content = requireString(args.content, 'content')
    const title = singleLine(requireString(args.title, 'title'))
    const source = optionalSingleLine(args.source)
    const vaultPath = requireMemoryVaultPath()
    const capturedDate = formatDate(now())

    const markdown = buildCaptureMarkdown({ title, source, capturedDate, content })
    const note = await createInboxNote(vaultPath, slugify(title), markdown)
    const logEntry = await appendLogEntry(vaultPath, formatLogEntry(capturedDate, 'capture', title))
    return { ...note, memoryVaultPath: vaultPath, logEntry }
  }

  async function log(args = {}) {
    const entry = singleLine(requireString(args.entry, 'entry'))
    const kind = requireLogKind(args.kind)
    const vaultPath = requireMemoryVaultPath()

    const logEntry = await appendLogEntry(vaultPath, formatLogEntry(formatDate(now()), kind, entry))
    return {
      memoryVaultPath: vaultPath,
      logPath: LOG_PATH,
      absolutePath: path.join(vaultPath, LOG_PATH),
      logEntry,
    }
  }

  return { memoryVaultPath, recall, ingest, log }
}

// --- qmd retrieval ---

async function defaultRunQmdQuery(query, limit) {
  // Mirrors the Rust adapter (qmd_cli.rs query_collection): --json plus -n limit.
  const { stdout } = await execFileAsync('qmd', ['query', query, '--json', '-n', String(limit)], {
    timeout: QMD_QUERY_TIMEOUT_MS,
    maxBuffer: QMD_MAX_OUTPUT_BYTES,
  })
  return stdout
}

async function tryQmdRecall(runQmdQuery, vaultPath, query, limit) {
  try {
    const entries = parseQmdResults(await runQmdQuery(query, limit))
    const normalized = await normalizeQmdEntries(entries, vaultPath)
    return normalized.slice(0, limit)
  } catch {
    // qmd is an optional external CLI (ADR-0141): a missing binary, query
    // failure, or malformed output all degrade to keyword search.
    return null
  }
}

function parseQmdResults(stdout) {
  const parsed = JSON.parse(stdout)
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed?.results)) return parsed.results
  throw new Error('Unrecognized qmd JSON output shape')
}

async function normalizeQmdEntries(entries, vaultPath) {
  const vaultRoot = await realpath(vaultPath)
  const results = []
  for (const entry of entries) {
    const normalized = await normalizeQmdEntry(entry, vaultRoot)
    if (normalized) results.push(normalized)
  }
  return results
}

async function normalizeQmdEntry(entry, vaultRoot) {
  const file = firstString(entry, ['file', 'path', 'filepath', 'filename'])
  if (!file) return null

  const relativePath = await vaultRelativePath(vaultRoot, stripQmdCollectionUri(file))
  if (!relativePath) return null

  return {
    path: relativePath,
    title: firstString(entry, ['title']) ?? path.basename(relativePath, '.md'),
    snippet: firstString(entry, ['snippet', 'text', 'chunk', 'content']) ?? '',
    score: typeof entry?.score === 'number' ? entry.score : null,
  }
}

/**
 * qmd reports hits as `qmd://<collection>/<path>` virtual URIs (ADR-0141);
 * strip the scheme and collection segment — mirroring the Rust adapter's
 * `collection_relative_path` — so hits resolve against the vault root.
 */
function stripQmdCollectionUri(file) {
  if (!file.startsWith('qmd://')) return file
  const rest = file.slice('qmd://'.length)
  const separatorIndex = rest.indexOf('/')
  return separatorIndex === -1 ? rest : rest.slice(separatorIndex + 1)
}

/** Map a qmd result file onto the memory vault; null when it lives outside. */
async function vaultRelativePath(vaultRoot, file) {
  let resolved
  try {
    resolved = await realpath(path.resolve(vaultRoot, file))
  } catch {
    return null
  }

  const relativePath = path.relative(vaultRoot, resolved)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null
  return relativePath
}

// --- ingest helpers ---

function buildCaptureMarkdown({ title, source, capturedDate, content }) {
  const sourceLine = source ? `source: ${yamlScalar(source)}\n` : ''
  const body = content.endsWith('\n') ? content : `${content}\n`
  return `---\ntitle: ${yamlScalar(title)}\n${sourceLine}captured: ${capturedDate}\n---\n\n${body}`
}

async function createInboxNote(vaultPath, slug, markdown) {
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const fileName = attempt === 1 ? `${slug}.md` : `${slug}-${attempt}.md`
    const notePath = `${INBOX_DIR}/${fileName}`
    resolveInsideVault(vaultPath, notePath)
    try {
      return await createNote(vaultPath, notePath, markdown)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error(`Could not find a free inbox file name for slug: ${slug}`)
}

/**
 * Build a filesystem-safe slug from a capture title. Unicode letters and
 * numbers are kept (CJK titles stay readable); everything else becomes a
 * dash, so path separators and traversal sequences can never survive.
 */
function slugify(title) {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  return slug || 'capture'
}

// --- log helpers ---

function formatLogEntry(date, kind, text) {
  return `## [${date}] ${kind} | ${text}`
}

async function appendLogEntry(vaultPath, entryLine) {
  const logPath = await writableLogPath(vaultPath)
  const separator = await logSeparator(logPath)
  await appendFile(logPath, `${separator}${entryLine}\n`, 'utf-8')
  return entryLine
}

/** Resolve wiki/log.md, rejecting symlinked escapes from the vault root. */
async function writableLogPath(vaultPath) {
  const vaultRoot = await realpath(vaultPath)
  const logPath = resolveInsideVault(vaultRoot, LOG_PATH)
  await mkdir(path.dirname(logPath), { recursive: true })
  resolveInsideVault(vaultRoot, await realpath(path.dirname(logPath)))
  if (existsSync(logPath)) {
    resolveInsideVault(vaultRoot, await realpath(logPath))
  }
  return logPath
}

/** Keep append-only entries on their own line even after manual edits. */
async function logSeparator(logPath) {
  try {
    const existing = await readFile(logPath, 'utf-8')
    return existing && !existing.endsWith('\n') ? '\n' : ''
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

// --- shared validation ---

function requireString(value, name) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) throw new Error(`${name} is required`)
  return trimmed
}

function requireLogKind(kind) {
  const normalized = typeof kind === 'string' ? kind.trim().toLowerCase() : ''
  if (!LOG_KINDS.includes(normalized)) {
    throw new Error(`kind must be one of: ${LOG_KINDS.join(', ')}`)
  }
  return normalized
}

function optionalSingleLine(value) {
  return typeof value === 'string' && value.trim() ? singleLine(value) : null
}

function singleLine(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeLimit(limit) {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_RECALL_LIMIT
}

function firstString(entry, keys) {
  for (const key of keys) {
    const value = entry?.[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function formatDate(date) {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function yamlScalar(value) {
  return JSON.stringify(value)
}
