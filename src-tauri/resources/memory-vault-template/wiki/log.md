---
type: Wiki
---

# Log

Append-only activity log. Each entry is `## [YYYY-MM-DD] verb | Title` where
the verb is one of `ingest`, `query`, `lint`, or `capture` (the single `init`
entry below is written once at scaffold time). Add new entries at the end;
never rewrite or delete earlier ones.

## [{{DATE}}] init | Memory vault scaffolded

Scaffolded by Tolaria from the memory-vault template. See `AGENTS.md` for the
schema all tools must follow.
