# AGENTS.md — Memory Vault

This vault is a shared, cross-tool memory store: a plain-markdown git repository
that any AI tool (Claude Code, Codex, Cursor, Antigravity, OpenCode, ...) can
read and maintain. Follow this schema exactly so that independent tools,
ingesting in any order, converge on the same wiki state.

## Three-layer architecture

| Layer | Path | Ownership |
| --- | --- | --- |
| Raw sources | `raw/` | Immutable. Tools read but never edit content here. |
| Wiki | `wiki/` | Owned and maintained by LLM tools. |
| Schema | `AGENTS.md` (this file) | The protocol. Change only when the user asks. |

- `raw/inbox/` — new material dropped by the user or a tool, waiting to be ingested.
- `raw/assets/` — images and other binary attachments referenced by sources.
- After ingestion, a source moves from `raw/inbox/` to a dated file directly
  under `raw/` (for example `raw/2026-06-12-conference-notes.md`). That move is
  the only permitted mutation under `raw/`.

## Ingest workflow

Run when `raw/inbox/` contains unprocessed sources:

1. Read each new source in `raw/inbox/` fully.
2. Write a wiki summary page for the source (or extend an existing page) using
   the wiki page format below. Every claim cites its raw source.
3. Update `wiki/index.md`: add or adjust the one-line summary for every page
   you created or changed, in the right category section.
4. Revise related entity and concept pages so cross-references stay accurate,
   adding `[[wikilinks]]` between pages that now relate.
5. Move the source file from `raw/inbox/` to its permanent dated home under
   `raw/`, then fix the `sources:` paths on pages that cite it.
6. Append an `ingest` entry to `wiki/log.md`.

Ingestion must be idempotent: writes are anchored to source citations, so
re-ingesting a source, or ingesting the same set of sources in a different
order, converges to the same wiki state instead of duplicating content.

## Query workflow

1. Always start from `wiki/index.md` — it is the table of contents with a
   one-line summary per page.
2. Follow `[[wikilinks]]` from the index to the relevant pages.
3. Cite back to the raw sources listed on each page when answering, so the
   user can verify every claim.
4. If the `qmd` CLI is installed, use hybrid retrieval to find candidate pages
   before reading them:

   ```bash
   qmd query "vector search tradeoffs" --json
   ```

5. If composing the answer required nontrivial synthesis across pages, save it
   as a new wiki page under the Syntheses category and append a `capture`
   entry to `wiki/log.md`.

## Lint workflow

Periodically health-check the wiki:

- Contradictions: pages making incompatible claims.
- Stale claims: statements superseded by newer raw sources.
- Orphan pages: wiki pages not reachable from `wiki/index.md`.
- Missing cross-references: related pages without `[[wikilinks]]` between them.
- Citation gaps: claims with no `raw/` source.

Write the findings to `wiki/lint-report.md` (overwrite the previous report) and
append a `lint` entry to `wiki/log.md`.

## Format conventions

### Wiki pages

```markdown
---
type: Wiki
sources:
  - raw/2026-06-01-kickoff-notes.md
  - raw/2026-06-12-conference-notes.md
related_to:
  - "[[vector-search]]"
---

# Acme Corp

B2B SaaS client (source: raw/2026-06-01-kickoff-notes.md). See [[vector-search]].
```

- `type: Wiki` on every wiki page.
- The first body line is the `# H1` page title. Do not add `title:` frontmatter.
- `sources:` lists every raw file the page draws from, as vault-relative paths.
- Relationship fields (`related_to`, `belongs_to`, ...) hold quoted
  `"[[wikilink]]"` list items so graph tools detect them.
- Inline claims cite their origin as `(source: raw/<file>.md)`.

### wiki/log.md

Append-only activity log. One entry per action:

```markdown
## [YYYY-MM-DD] ingest | Conference notes from PyCon
```

The verb is one of `ingest`, `query`, `lint`, or `capture`; the one `init`
entry written at scaffold time is the only exception. Never rewrite or delete
earlier entries — the log is grep-able history.

### wiki/index.md

One line per wiki page with a short summary, as `- [[page]] — summary.` items
grouped under the category sections Entities, Concepts, Sources, and
Syntheses. Keep it complete: a page missing from the index is an orphan.

## Safety rules

- Never edit, rename, or delete content under `raw/`; the inbox-to-permanent
  move during ingest is the only allowed change.
- Every claim in the wiki must be traceable to a raw source citation.
- Mark uncertain or inferred information explicitly, for example `(uncertain)`.
- Do not invent sources. Information without a raw source must be labeled as
  unsourced until a source lands in `raw/`.
