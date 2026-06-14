/**
 * Bundle the mcp-server Node.js files into self-contained CJS bundles
 * that can be shipped as Tauri resources inside the .app bundle.
 *
 * Output: src-tauri/resources/mcp-server/{index.js,ws-bridge.js,cli.js}
 * plus memory-vault-template/ so the bundled tolaria-mem CLI can scaffold
 * memory vaults without a dev checkout (ADR-0140).
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { cpSync, mkdirSync, writeFileSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'mcp-server')
const OUT = join(ROOT, 'src-tauri', 'resources', 'mcp-server')
const TEMPLATE = join(ROOT, 'src-tauri', 'resources', 'memory-vault-template')

mkdirSync(OUT, { recursive: true })

// Tell Node.js that this directory contains CJS bundles, even if the
// root package.json declares "type": "module".
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ type: 'commonjs' }))

// The CLI resolves its scaffold template relative to import.meta.url, which
// the cjs output format does not provide — substitute a __filename-based URL.
const IMPORT_META_URL_SHIM = 'const __tolariaImportMetaUrl = ' +
  "require('node:url').pathToFileURL(__filename).href;"

const shared = {
  platform: 'node',
  bundle: true,
  format: 'cjs',
  target: 'node18',
  // Mark optional native bindings as external — ws works fine without them
  external: ['bufferutil', 'utf-8-validate'],
  define: { 'import.meta.url': '__tolariaImportMetaUrl' },
  banner: { js: IMPORT_META_URL_SHIM },
  logLevel: 'warning',
}

for (const entry of ['index.js', 'ws-bridge.js', 'cli.js']) {
  await build({
    ...shared,
    entryPoints: [join(SRC, entry)],
    outfile: join(OUT, entry),
  })
}

// Ship the memory vault template next to cli.js (see resolveTemplateDir).
cpSync(TEMPLATE, join(OUT, 'memory-vault-template'), { recursive: true })

console.log('mcp-server bundled → src-tauri/resources/mcp-server/')
