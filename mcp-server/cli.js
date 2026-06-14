#!/usr/bin/env node
/**
 * tolaria-mem — command-line entry point for the Tolaria memory vault
 * (ADR-0140, ADR-0142). Thin argv wrapper around cli-commands.js, which
 * shares its core with the MCP memory tools (memory.js).
 *
 * Exit codes: 0 success, 1 execution error, 2 usage error.
 */
import { runCli } from './cli-commands.js'

runCli(process.argv.slice(2)).then(exitCode => {
  process.exitCode = exitCode
})
