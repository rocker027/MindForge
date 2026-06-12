---
type: ADR
id: "0142"
title: "Cross-tool memory access protocol"
status: active
date: 2026-06-12
---

## Context

The memory vault (ADR-0140) is only useful if every AI tool the user works with — Claude Code, Codex, Cursor, Antigravity, OpenCode, and Tolaria's own embedded agents — can recall and extend it. These tools have very different capabilities: some support MCP, some can run CLIs, and some can only read and write files. Binding memory access to any single integration would exclude tools and contradict the zero-lock-in principle behind filesystem-as-source-of-truth (ADR-0002). The protocol also needs a sync story so memory stays consistent across devices without introducing a bespoke service.

## Decision

**Memory access is layered into three independent paths, with direct filesystem access as the zero-dependency floor that every other path must stay consistent with. Git remotes are the only sync mechanism.**

1. **Path ① — filesystem direct access (baseline, zero dependencies).** Any tool that can read files follows the `AGENTS.md` schema inside the repo: start at `wiki/index.md`, follow `[[wikilinks]]` to topic pages, append activity to `log.md`, and drop new material into `raw/inbox/`. This is Karpathy's original design; it requires nothing but file access and defines the contract for all other paths.
2. **Path ② — qmd retrieval (optional, for scale).** Tools that can run a CLI or attach an MCP server use `qmd query` / `qmd mcp` against the registered memory collection (ADR-0141) for hybrid semantic recall once the wiki outgrows `index.md` navigation.
3. **Path ③ — Tolaria MCP `memory_*` tools (structured operations).** The MCP server (ADR-0011) gains `memory_recall` (qmd-backed, falling back to keyword search), `memory_ingest` (write into `raw/inbox/` plus a `log.md` entry), and `memory_log` (append-only log writes). These ride the existing explicit, vault-neutral durable MCP registration (ADR-0074, ADR-0119, ADR-0120): clients the user has already connected — Claude Code, Cursor, Gemini CLI, OpenCode — pick up the new tools without re-registering, and existing path-containment validation continues to apply.

Synchronization is plain git: the memory vault syncs through its remote using Tolaria's existing auto-sync and conflict-resolution flows. No memory-specific sync service or wire protocol exists.

## Options considered

- **Option A** (chosen): layered three-path protocol with a filesystem floor — every tool gets some access level, and the schema lives in the repo so the protocol travels with the data. Downside: three surfaces must stay behaviorally consistent (log format, citation rules).
- **Option B**: MCP-only access — one controlled surface with centralized validation. Downside: excludes tools without MCP support and all usage while Tolaria is not running, defeating the portable-repo premise.
- **Option C**: dedicated memory sync service/API — could add auth, locking, and conflict-free merging. Downside: a second source of truth and an always-on dependency, violating ADR-0002; git already provides sync, history, and conflict handling.

## Consequences

- The in-repo `AGENTS.md` schema is the single normative document; Tolaria's MCP tools and UI must follow it rather than define competing conventions. MCP clients already receive per-vault `AGENTS.md` guidance (ADR-0119).
- Tools degrade gracefully: no qmd → paths ①/③ with keyword fallback; no MCP → paths ①/②; file access only (e.g., Antigravity) → path ① still works fully.
- `memory_ingest` and `memory_log` must enforce append-only log semantics and vault path containment at the MCP boundary, mirroring existing tool-service validation.
- Concurrent writes from multiple tools converge through git: append-only `log.md` and citation-required wiki edits keep merges tractable, with the existing conflict-resolution UI as the backstop.
- Agent instructions surfaced to embedded CLI agents should summarize the memory protocol so internal and external tools follow the same contract.
- Re-evaluation trigger: if multi-tool concurrent writes produce conflicts that git merging cannot absorb, a coordination layer (e.g., MCP-mediated writes only) must be reconsidered.
