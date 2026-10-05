---
name: craft-codebase
description: Automatically prepare a repository index and inspect Craft Codebase when a task needs checkpoint-pinned symbol lookup, static callers, or candidate change impact in a repository.
---

# Craft Codebase

At the start of a repository task, call `craft_codebase_repository_ensure` with the Host's current directory as `project_root`. It discovers the Git root, automatically prepares a bounded basic index and returns `workspace_id`/`index_id`; no user activation step is needed. Re-run after changes. Use `index_depth: "semantic"` before callers/impact analysis. Existing explicit workspace tools below remain advanced controls.

If `craft-context` is present, follow its Skill and reuse its returned index instead of repeating recall/index preparation. Project opt-out is `.craft-codebase.json` with `{"enabled":false}`; `exclude_paths` contains relative path prefixes. Global opt-out is `CRAFT_CODEBASE_AUTO_INDEX=0`. Basic symbols are partial, and omitted files are reported.


Use this only for a repository-structure question: finding a symbol, its static callers, or a bounded candidate impact set. It is a read-only structural view, separate from Knowledge, Memory, and Experience.

1. Use the automatic repository entry above for ordinary coding tasks. For a deliberately restricted non-Git analysis or explicit snapshot, use `craft_codebase_workspace_open`, `craft_codebase_activate` and `craft_codebase_refresh` with the requested paths. Status reports working-tree drift.
2. Use `craft_codebase_symbol_find`, `craft_codebase_callers_find`, or `craft_codebase_impact_query` against the returned ready `index_id`. Treat every relation as static candidate evidence: unresolved imports, dynamic dispatch, generated code, and unsupported languages remain incomplete by design.
3. Use `craft_codebase_context_slice` only to hand off snapshot-pinned paths, spans, digests, and query receipts. Read source through the Host's normal repository tools only when the task needs the body.

Completion: cite the index id, checkpoint/digest, and query receipt with the answer. Rebuild after a changed checkpoint; do not describe a stale index as current.

Automatic indexing applies current Git ignore rules to tracked and untracked paths before reading content. New ignores affect future snapshots; they do not erase historical snapshots. Restoring a checkpoint requires a fresh ready index bound to the restored workspace revision; do not reuse an earlier stale index just because its checkpoint id matches.

Semantic TS/JS analysis uses the TypeScript compiler checker over the pinned checkpoint. Use `analyzer: "heuristic"` only for an explicit degraded comparison. For other languages, use `craft_codebase_analysis_import` with `craft-static-analysis-v1` facts from an AST/LSP/SCIP adapter. Each node names a checkpoint file digest and UTF-16 offsets; edges use node ids. Import validates snapshot membership, digests, spans and budgets. External facts are `adapter_reported/partial`, never runtime proof. Never read a current working file as if it were the pinned snapshot when status reports changed paths.

For Python, run the packaged `scripts/codebase/analyze-python.py` with `uv run` on a JSON object with an explicit `documents` array (`path`, `content`, `source_digest`). It pins Jedi, resolves local imports and calls without executing project code, and returns `craft-static-analysis-v1` for `craft_codebase_analysis_import`. Supply snapshot content, then verify the imported index with a known positive caller and a negative control. LSP adapters can supply explicit `calls`, `imports`, `references`, `implements`, and `type_definition` relations; DocumentSymbol alone proves no edges. Budget failures require a narrower workspace, not a complete-index claim.

For the DSH native bundle, call `craft_codebase_tools` to discover the actual MCP schemas and this Skill, then `craft_codebase_call` with the chosen tool and JSON arguments. Standard MCP Hosts expose those same tools directly.

When inspecting history, a changed answer, provenance, or a requested restoration, use `craft_codebase_asset_inspect` with the exact scope and `action: history/read/diff/explain`. History records distinguish state versions from content revisions. Compare before restoring; `craft_codebase_asset_restore` requires the historical `version`, current `expected_version`, stable `request_id`, and `reason`. Rebuild only the current workspace checkpoint through the original analyzer; never activate a historical index against changed code.
