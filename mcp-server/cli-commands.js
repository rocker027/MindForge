/**
 * tolaria-mem command implementations — the CLI entry point for the memory
 * vault (ADR-0140, ADR-0142 path ②/③ without a GUI).
 *
 * Every command reuses the same core as the MCP tools (memory.js) so CLI and
 * MCP behavior never drift. All dependencies are injectable for tests; the
 * thin cli.js wrapper runs with production defaults.
 */
import { execFile } from 'node:child_process'
import { readFile, opendir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { LOG_KINDS, MEMORY_VAULT_MISSING_ERROR, createMemoryService } from './memory.js'
import { configuredMemoryVaultEntry } from './vault-path.js'
import { scaffoldMemoryVault } from './cli-scaffold.js'

const execFileAsync = promisify(execFile)

const QMD_VERSION_TIMEOUT_MS = 10_000
const QMD_INSTALL_HINT = 'npm install -g @tobilu/qmd'
const SCAFFOLD_HINT = 'Run `tolaria-mem scaffold <path>` to create and register one.'

export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_USAGE = 2

export const USAGE = `Usage: tolaria-mem <command> [options]

Commands:
  status                                  Memory vault path, qmd availability, page counts
  scaffold <path>                         Create and register a memory vault from the template
  recall <query> [--limit N]              Recall memory pages (qmd first, keyword fallback)
  ingest <file|-> [--title T] [--source S]  Capture a file or stdin into raw/inbox/
  log <kind> <entry>                      Append to wiki/log.md (kind: ${LOG_KINDS.join(', ')})
  help                                    Show this message

Options:
  --json    Print a single machine-readable JSON object on stdout
`

class CliUsageError extends Error {}

export async function runCli(argv, deps = {}) {
  const stderr = deps.stderr ?? process.stderr
  const [command, ...args] = argv

  try {
    return await dispatchCommand(command, args, deps)
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr.write(`tolaria-mem: ${error.message}\n\n${USAGE}`)
      return EXIT_USAGE
    }
    stderr.write(`tolaria-mem: ${runErrorMessage(error)}\n`)
    return EXIT_ERROR
  }
}

async function dispatchCommand(command, args, deps) {
  const stdout = deps.stdout ?? process.stdout
  switch (command) {
    case 'status': return runStatus(args, deps, stdout)
    case 'scaffold': return runScaffold(args, deps, stdout)
    case 'recall': return runRecall(args, deps, stdout)
    case 'ingest': return runIngest(args, deps, stdout)
    case 'log': return runLog(args, deps, stdout)
    case 'help': case '--help': case '-h':
      stdout.write(USAGE)
      return EXIT_OK
    case undefined:
      throw new CliUsageError('Missing command')
    default:
      throw new CliUsageError(`Unknown command: ${command}`)
  }
}

function runErrorMessage(error) {
  const message = error?.message ?? String(error)
  return message === MEMORY_VAULT_MISSING_ERROR ? `${message}\n${SCAFFOLD_HINT}` : message
}

// --- status ---

async function runStatus(args, deps, stdout) {
  const { options } = parseCliArgs(args, { json: 'boolean' }, { maxPositionals: 0 })
  const entry = resolveMemoryVaultEntry(deps)
  const status = {
    memoryVault: entry ? await memoryVaultStatus(entry) : null,
    qmd: await detectQmd(deps.runQmdVersion ?? defaultRunQmdVersion),
  }

  stdout.write(options.json ? jsonLine(status) : renderStatusText(status))
  return EXIT_OK
}

function resolveMemoryVaultEntry(deps) {
  if (deps.resolveMemoryVaultEntry) return deps.resolveMemoryVaultEntry()
  return configuredMemoryVaultEntry(deps.configDir ? { configDir: deps.configDir } : {})
}

async function memoryVaultStatus(entry) {
  return {
    path: entry.path,
    label: entry.label ?? null,
    collection: qmdCollectionName(entry),
    exists: existsSync(entry.path),
    wikiPages: await countVaultFiles(path.join(entry.path, 'wiki'), '.md'),
    rawFiles: await countVaultFiles(path.join(entry.path, 'raw')),
  }
}

/** Collection naming convention shared with the app: tolaria-<alias|memory>. */
export function qmdCollectionName(entry) {
  const alias = typeof entry?.alias === 'string' ? entry.alias.trim() : ''
  return alias ? `tolaria-${alias}` : 'tolaria-memory'
}

async function detectQmd(runQmdVersion) {
  try {
    return { installed: true, version: parseQmdVersion(await runQmdVersion()) }
  } catch {
    // qmd is an optional external CLI (ADR-0141): absence is a supported state.
    return { installed: false, version: null }
  }
}

async function defaultRunQmdVersion() {
  const { stdout } = await execFileAsync('qmd', ['--version'], { timeout: QMD_VERSION_TIMEOUT_MS })
  return stdout
}

/** Mirrors the Rust adapter (qmd_cli.rs parse_version): `qmd 0.6.5 (1a2b3c)`. */
function parseQmdVersion(stdout) {
  const line = stdout.split('\n').map(text => text.trim()).find(Boolean) ?? ''
  const version = line === 'qmd' ? '' : line.startsWith('qmd ') ? line.slice(4).trim() : line
  return version || null
}

function renderStatusText(status) {
  const qmdLine = status.qmd.installed
    ? `qmd: installed${status.qmd.version ? ` (${status.qmd.version})` : ''}\n`
    : `qmd: not installed (${QMD_INSTALL_HINT})\n`
  if (!status.memoryVault) {
    return `Memory vault: not configured\n  ${SCAFFOLD_HINT}\n${qmdLine}`
  }

  const vault = status.memoryVault
  const missing = vault.exists ? '' : '  warning: directory does not exist\n'
  return `Memory vault: ${vault.path}\n${missing}` +
    `  qmd collection: ${vault.collection}\n` +
    `  wiki pages: ${vault.wikiPages}\n  raw files: ${vault.rawFiles}\n${qmdLine}`
}

/** Count non-hidden files under a directory tree; 0 when it does not exist. */
async function countVaultFiles(dir, extension = '') {
  let count = 0
  let entries
  try {
    entries = await opendir(dir)
  } catch {
    return 0
  }
  for await (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      count += await countVaultFiles(path.join(dir, entry.name), extension)
    } else if (entry.name.endsWith(extension)) {
      count += 1
    }
  }
  return count
}

// --- scaffold ---

function runScaffold(args, deps, stdout) {
  const { positionals, options } = parseCliArgs(args, { json: 'boolean' }, { maxPositionals: 1 })
  const target = requirePositional(positionals[0], 'scaffold requires a target path')

  const scaffold = deps.scaffold ?? scaffoldMemoryVault
  const report = scaffold(target, scaffoldOptions(deps))

  stdout.write(options.json ? jsonLine(report) : renderScaffoldText(report))
  return EXIT_OK
}

function scaffoldOptions(deps) {
  const options = {}
  if (deps.configDir) options.configDir = deps.configDir
  if (deps.templateDir) options.templateDir = deps.templateDir
  if (deps.runGit) options.runGit = deps.runGit
  if (deps.now) options.now = deps.now
  return options
}

function renderScaffoldText(report) {
  return `Memory vault ready at ${report.path}\n` +
    `  files created: ${report.createdFiles.length}, skipped existing: ${report.skippedFiles.length}\n` +
    `  git: ${report.gitInitialized ? 'initialized' : 'already a repository'}\n` +
    `  vaults.json: ${report.registered ? 'registered' : 'already registered'}\n`
}

// --- recall ---

async function runRecall(args, deps, stdout) {
  const { positionals, options } = parseCliArgs(
    args,
    { json: 'boolean', limit: 'value' },
    { maxPositionals: 1 },
  )
  const query = requirePositional(positionals[0], 'recall requires a query')

  const recall = await memoryService(deps).recall({ query, limit: parseLimitOption(options.limit) })

  stdout.write(options.json ? jsonLine(recall) : renderRecallText(recall))
  return EXIT_OK
}

function parseLimitOption(raw) {
  if (raw === undefined) return undefined
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CliUsageError('--limit must be a positive integer')
  }
  return limit
}

function renderRecallText(recall) {
  if (recall.results.length === 0) return `No matches (engine: ${recall.engine}).\n`
  const lines = recall.results.map((hit, index) => renderRecallHit(hit, index))
  return `${recall.results.length} result(s) via ${recall.engine}:\n${lines.join('')}`
}

function renderRecallHit(hit, index) {
  const score = typeof hit.score === 'number' ? ` (score ${hit.score.toFixed(2)})` : ''
  const snippet = hit.snippet ? `\n   ${hit.snippet.replace(/\s+/g, ' ').trim()}` : ''
  return `${index + 1}. ${hit.path}${score}${snippet}\n`
}

// --- ingest ---

async function runIngest(args, deps, stdout) {
  const { positionals, options } = parseCliArgs(
    args,
    { json: 'boolean', title: 'value', source: 'value' },
    { maxPositionals: 1 },
  )
  const file = requirePositional(positionals[0], 'ingest requires a file path or - for stdin')
  const { content, title } = await ingestInput(file, options, deps)

  const result = await memoryService(deps).ingest({ content, title, source: options.source })

  stdout.write(options.json ? jsonLine(result) : renderIngestText(result))
  return EXIT_OK
}

async function ingestInput(file, options, deps) {
  if (file === '-') {
    if (!options.title) throw new CliUsageError('ingest from stdin requires --title')
    const readStdin = deps.readStdin ?? defaultReadStdin
    return { content: await readStdin(), title: options.title }
  }

  const title = options.title ?? path.basename(file).replace(/\.[^.]+$/, '')
  if (!title) throw new CliUsageError('Could not derive a title from the file name; pass --title')
  return { content: await readIngestFile(file), title }
}

async function readIngestFile(file) {
  try {
    return await readFile(file, 'utf-8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`File not found: ${file}`)
    throw error
  }
}

async function defaultReadStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

function renderIngestText(result) {
  return `Captured into ${result.path}\nLogged: ${result.logEntry}\n`
}

// --- log ---

async function runLog(args, deps, stdout) {
  const { positionals, options } = parseCliArgs(args, { json: 'boolean' }, {})
  const kind = requirePositional(positionals[0], `log requires a kind (${LOG_KINDS.join(', ')})`)
  if (!LOG_KINDS.includes(kind)) {
    throw new CliUsageError(`Unknown log kind "${kind}"; expected one of: ${LOG_KINDS.join(', ')}`)
  }
  const entry = requirePositional(positionals.slice(1).join(' '), 'log requires an entry text')

  const result = await memoryService(deps).log({ kind, entry })

  stdout.write(options.json ? jsonLine(result) : `Appended to ${result.logPath}: ${result.logEntry}\n`)
  return EXIT_OK
}

// --- shared helpers ---

function memoryService(deps) {
  if (deps.memoryService) return deps.memoryService
  return createMemoryService({
    resolveMemoryVaultPath: () => resolveMemoryVaultEntry(deps)?.path ?? null,
    ...(deps.runQmdQuery ? { runQmdQuery: deps.runQmdQuery } : {}),
  })
}

/**
 * Minimal long-option parser: `--flag` booleans and `--option value` pairs.
 * Anything not starting with `--` is a positional (including `-` for stdin).
 */
function parseCliArgs(args, flagSpec, { maxPositionals = Infinity } = {}) {
  const positionals = []
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    index += collectOption(options, flagSpec, args, index)
  }
  if (positionals.length > maxPositionals) {
    throw new CliUsageError(`Unexpected argument: ${positionals[maxPositionals]}`)
  }
  return { positionals, options }
}

/** Record one --option; returns how many extra argv slots were consumed. */
function collectOption(options, flagSpec, args, index) {
  const name = args[index].slice(2)
  const kind = flagSpec[name]
  if (!kind) throw new CliUsageError(`Unknown option: ${args[index]}`)
  if (kind === 'boolean') {
    options[name] = true
    return 0
  }
  if (index + 1 >= args.length) throw new CliUsageError(`Option ${args[index]} requires a value`)
  options[name] = args[index + 1]
  return 1
}

function requirePositional(value, message) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) throw new CliUsageError(message)
  return trimmed
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`
}
