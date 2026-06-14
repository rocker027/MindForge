import { describe, it, expect } from 'vitest'
import { memoryHitToEntry } from './openMemoryHit'
import type { MemoryHit } from '../../hooks/useMemorySearch'

const hit: MemoryHit = {
  path: 'wiki/typescript.md',
  title: 'TypeScript notes',
  score: 0.91,
  snippet: 'Strict mode keeps the codebase honest.',
}

describe('memoryHitToEntry', () => {
  it('joins the relative hit path onto the memory vault root', () => {
    const entry = memoryHitToEntry(hit, '/Users/me/MemoryVault')
    expect(entry.path).toBe('/Users/me/MemoryVault/wiki/typescript.md')
  })

  it('derives the filename from the last path segment', () => {
    expect(memoryHitToEntry(hit, '/memory').filename).toBe('typescript.md')
  })

  it('carries the hit title and snippet onto the entry', () => {
    const entry = memoryHitToEntry(hit, '/memory')
    expect(entry.title).toBe('TypeScript notes')
    expect(entry.snippet).toBe('Strict mode keeps the codebase honest.')
  })

  it('falls back to the filename when the title is blank', () => {
    const entry = memoryHitToEntry({ ...hit, title: '   ' }, '/memory')
    expect(entry.title).toBe('typescript.md')
  })

  it('normalizes a trailing slash on the vault path', () => {
    expect(memoryHitToEntry(hit, '/memory/').path).toBe('/memory/wiki/typescript.md')
  })
})
