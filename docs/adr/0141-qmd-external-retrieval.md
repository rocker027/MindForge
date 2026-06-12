---
type: ADR
id: "0141"
title: "qmd as an optional external retrieval CLI"
status: active
date: 2026-06-12
supersedes: "0009"
---

## Context

ADR-0009 removed QMD semantic indexing entirely and kept only keyword search. Its pain points were operational, not retrieval-quality problems: a bundled Go binary in `tools/qmd/` that required Apple code-signing and notarization, auto-install logic with fresh-install failure modes, indexing latency on vault open with status-bar progress tracking, and ongoing maintenance of the bundled tooling.

The memory vault (ADR-0140) changes the retrieval requirements. The LLM-wiki protocol works via `wiki/index.md` navigation at small scale, but recall quality degrades as the wiki grows beyond what an agent can navigate by table of contents. qmd (github.com/tobi/qmd, npm `@tobilu/qmd`) now provides BM25 + vector + LLM-rerank hybrid retrieval as a self-contained CLI with an MCP server mode; it manages named collections and stores its index in its own cache under `~/.cache/qmd/`. Tolaria also already has a proven model for external CLI dependencies: CLI agents (ADR-0028, ADR-0093) are user-installed binaries that Tolaria detects and adapts to — never bundles.

## Decision

**Tolaria reintroduces qmd strictly as an optional, user-installed external CLI (`npm install -g @tobilu/qmd`), detected at runtime like a CLI agent. Keyword search (ADR-0009) remains the built-in baseline and the fallback; qmd, when present, adds semantic/hybrid retrieval. Tolaria never bundles, signs, installs, or updates qmd, and the index lives in qmd's own `~/.cache/qmd/` — never inside a vault or the app bundle.**

How the new model avoids each ADR-0009 pain point:

| ADR-0009 pain point | New model |
|---|---|
| Bundled Go binary in `tools/qmd/` | Not bundled — the user installs qmd globally; Tolaria only probes for it on `PATH` |
| Apple code-signing / notarization | Nothing ships inside the app bundle, so there is nothing to sign or notarize |
| Auto-install logic and fresh-install failures | No managed install — absence is a fully supported state; the UI shows an install hint, never an error |
| Indexing on vault open + status-bar progress | Indexing runs in qmd's own process, triggered in the background after sync events; vault open never waits on it |
| Index state managed by the app | The index is qmd's own SQLite cache in `~/.cache/qmd/` — disposable, outside the vault, outside the app |

When qmd is absent, every retrieval surface degrades gracefully to the existing keyword search path (`search_vault`), which is unchanged.

## Options considered

- **Option A** (chosen): optional external CLI with runtime detection and graceful fallback — semantic retrieval without any of ADR-0009's bundling costs, using the same trust model as Claude Code/Codex CLIs. Downside: users must install qmd themselves, so retrieval capability differs between machines.
- **Option B**: keep keyword-only search — zero dependencies, status quo. Downside: memory recall degrades once the wiki outgrows `index.md` navigation scale.
- **Option C**: re-bundle qmd in the app — uniform out-of-the-box experience. Downside: reinstates every ADR-0009 pain point (signing, auto-install, startup indexing, bundle maintenance).
- **Option D**: Rust-native embedding library — no external binary. Downside: large model files, cold-start cost, and app-owned index maintenance — rejected in ADR-0009 for the same reasons.

## Consequences

- ADR-0009's decision ("keyword-only, no semantic indexing") is superseded, but its keyword search implementation survives unchanged as the default and the fallback path.
- A qmd adapter, modeled on the CLI-agent adapters of ADR-0093, owns detection, version checks, collection registration, and JSON query-output parsing.
- Mounting a memory vault registers a qmd collection with `update-cmd 'git pull --rebase'`, so the index follows the git remote without app-side bookkeeping.
- qmd's first embed downloads models (~2GB); the UI must disclose this before triggering it, and documentation should point CJK-heavy vaults at a multilingual embedding model (e.g., `QMD_EMBED_MODEL`).
- No release-pipeline changes on any platform: nothing new to sign, notarize, or bundle.
- Re-evaluation trigger: if qmd's CLI/JSON contract proves unstable across versions, or if MCP-based retrieval (ADR-0142, path ②) makes direct CLI integration redundant.
