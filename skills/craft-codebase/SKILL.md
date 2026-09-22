---
name: craft-codebase
description: Inspect an explicitly activated Craft Codebase index when a task needs checkpoint-pinned symbol lookup, static callers, or candidate change impact in a repository.
---

# Craft Codebase

Use this only for a repository-structure question: finding a symbol, its static callers, or a bounded candidate impact set. It is a read-only structural view, separate from Knowledge, Memory, and Experience.

1. Check `craft_codebase_status` for the declared `workspace_id`. If it is `disabled`, ask for or perform explicit `craft_codebase_activate`; if it is `index_required` or `rebuild_required`, create or select a Workspace checkpoint and call `craft_codebase_index_build` with that checkpoint.
2. Use `craft_codebase_symbol_find`, `craft_codebase_callers_find`, or `craft_codebase_impact_query` against the returned ready `index_id`. Treat every relation as static candidate evidence: unresolved imports, dynamic dispatch, generated code, and unsupported languages remain incomplete by design.
3. Use `craft_codebase_context_slice` only to hand off snapshot-pinned paths, spans, digests, and query receipts. Read source through the Host's normal repository tools only when the task needs the body.

Completion: cite the index id, checkpoint/digest, and query receipt with the answer. Rebuild after a changed checkpoint; do not describe a stale index as current.
