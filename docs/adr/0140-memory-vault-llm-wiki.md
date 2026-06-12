---
type: ADR
id: "0140"
title: "Memory vault with LLM wiki structure"
status: active
date: 2026-06-12
---

## Context

Tolaria already gives AI tools structured access to notes: markdown with frontmatter and dynamic wikilink relationships (ADR-0010), git-backed sync, mounted workspaces with a unified graph (ADR-0114), a vault-neutral MCP server (ADR-0011, ADR-0119), and CLI agent runtimes (ADR-0028). What is missing is durable cross-tool memory: a place where Claude Code, Codex, Cursor, Antigravity, OpenCode, and Tolaria's own embedded agents accumulate and recall shared knowledge across sessions and devices.

Karpathy's LLM wiki pattern solves this with three layers: immutable raw source material, an LLM-maintained wiki of distilled knowledge pages, and a schema document that tells any agent how to ingest, query, and maintain the wiki. Such a store needs `raw/` and `wiki/` subdirectories. Subfolder scanning (ADR-0033) already indexes nested markdown, but the flat-structure convention for notes vaults (ADR-0006) keeps user notes at the root with type derived from frontmatter, so a protocol-mandated directory layout should be a distinct workspace kind rather than an exception inside a notes vault.

## Decision

**Tolaria supports a memory vault: a standalone git repository following the Karpathy LLM-wiki three-layer layout (`raw/` immutable sources, `wiki/` LLM-maintained pages, `AGENTS.md` schema), mounted as a mounted workspace per ADR-0114 and tagged in `vaults.json` with a new `kind` field (`"notes"` default, `"memory"`).**

Layout, scaffolded by Tolaria:

```
memory-vault/
├── raw/            # layer 1: immutable source material (agents read, never edit)
│   ├── inbox/      # new material awaiting ingest
│   └── assets/     # attachments
├── wiki/           # layer 2: LLM-generated and maintained knowledge pages
│   ├── index.md    # table of contents (one summary line per page) — first query entry point
│   ├── log.md      # append-only activity log
│   ├── overview.md # global summary page
│   └── <topic>.md  # entity/concept pages: frontmatter + [[wikilinks]] + raw/ citations
├── AGENTS.md       # layer 3: schema — ingest/query/lint protocol every tool reads
└── CLAUDE.md       # @AGENTS.md compatibility shim
```

Relation to existing decisions:

- ADR-0006 (flat vault structure) stays active for `kind: "notes"` vaults. A memory vault is a distinct workspace kind whose `raw/` and `wiki/` subdirectories are part of its protocol, so the flat convention does not apply to it; the scanner needs no changes because subfolder scanning (ADR-0033) already indexes nested pages.
- Wiki pages are ordinary markdown with frontmatter and `[[wikilinks]]`, so dynamic relationship detection (ADR-0010), search, quick-open, and cross-workspace alias links (ADR-0114) work unchanged. System properties keep the underscore convention (ADR-0008), and `type:` remains the canonical type field (ADR-0025).
- `kind` is optional in `vaults.json`; a missing value means `"notes"`, so existing vault lists load unchanged.

## Options considered

- **Option A** (chosen): standalone git repo mounted as a `kind: "memory"` workspace — memory is shareable with any tool or device independently of any notes vault, git history doubles as memory provenance, and the mounted-workspace graph is reused as-is. Downside: one more repo for users to manage; `kind` introduces a workspace-type concept.
- **Option B**: memory as a subdirectory inside an existing notes vault — no new repo to set up. Downside: breaks the flat structure rule inside a notes vault, entangles memory history with note history, and sharing memory with a tool means exposing the whole vault.
- **Option C**: app-managed memory database (SQLite or similar) — fast structured queries. Downside: violates filesystem-as-source-of-truth (ADR-0002), unreadable by external AI tools, and requires a bespoke sync protocol instead of git.

## Consequences

- Any AI tool that can read files can use the memory vault: the schema travels with the repo in `AGENTS.md`, which MCP clients already receive per ADR-0119.
- `vaults.json` entries gain an optional `kind` field; loaders must treat a missing `kind` as `"notes"` for backward compatibility.
- Memory pages join the unified graph: search, quick-open, and wikilink navigation operate across notes and memory workspaces (ADR-0114 behavior).
- Any future tooling that assumes the notes-vault flat convention (ADR-0006) must branch on `kind` so memory vaults are never "repaired" into a flat layout.
- LLM-written content is constrained by the schema: wiki claims must cite `raw/` sources and `log.md` is append-only, which keeps concurrent multi-tool writes mergeable and makes hallucinations auditable and revertible via git history.
- Retrieval beyond `index.md` navigation and access paths for external tools are defined separately (ADR-0141, ADR-0142).
- Re-evaluation trigger: if additional workspace kinds are needed (e.g., templates), or if the two-directory protocol proves too rigid for user memory workflows.
