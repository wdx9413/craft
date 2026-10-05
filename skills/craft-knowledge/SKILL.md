---
name: craft-knowledge
description: Use Craft's standalone knowledge component to search, read, draft, review, distill, or retract evidence-backed knowledge without running the full work loop.
---

# Craft Knowledge

When `craft-context` is available, use its task-start Skill and reuse its scoped receipt; do not repeat the same component recall. Keep this Skill for standalone access and knowledge operations.


Use this component when the task only needs governed knowledge. It is not a chat-history dump and does not grant tool or file-write authority.

Default loop for a coding task:

1. The portable baseline is an explicit Skill + MCP call on any supported host. If an enabled trusted Hook already supplied an applicable current Context Receipt, reuse it; otherwise call `craft_component_readiness_get` with `component: "knowledge"` only when availability is unknown.
   A loaded Skill or enabled marketplace entry does not prove the current Host attached its MCP process. If the component is unavailable, say so once rather than claiming an empty knowledge store. If it is callable but behaves unlike this guidance, call `craft_component_diagnose` and compare visible tool names before assuming the data is empty.
   Readiness is only an availability preflight: it does not retrieve Knowledge, resolve Context, or count as using this component. When the task requires Knowledge, continue with the actual search or bounded resolution call.
2. If no scoped source exists, call `craft_knowledge_bootstrap_install` or explicitly register/sync one project source.
3. Resolve `project_root` with `craft_scope_identity_resolve_project`. Pass its canonical `scope_kind` and `scope_id` to `craft_knowledge_search` before asking for known conventions. Search defaults to reviewed entries; `include_candidates: true` is diagnostic only. Missing scope returns `scope_unavailable`, not a global search.
4. Resolve only a bounded current-scope context with `craft_context_resolution_resolve`; record its receipt id with the task result.
5. To retain a supported fact/rule/decision, record supporting Evidence with `craft_evidence_record`, then create a candidate with `craft_knowledge_claim_save`. First call `craft_knowledge_semantic_review_packet`; the current Host must inspect that exact Claim, fragment and rubric, then call `craft_knowledge_host_review` with its `packet_digest`, current Host turn key and exact `source_digest`. A supported low-risk current Claim is automatically promoted without a second API key. For unattended review, use `craft_knowledge_semantic_provider_review` with endpoint/model/credential environment-variable name, or bind independent observations through `craft_knowledge_support_record`. Do not turn notes, search snippets, model guesses, or repeated copies of one statement into reviewed Knowledge.
6. `craft_knowledge_promotion_policy_get` shows the local automatic threshold. An operator may explicitly adjust it with `craft_knowledge_promotion_policy_save`; this is an exception/configuration path, not a mandatory human review queue, and it never syncs to another machine.

For a controlled personal-machine migration, use `craft_knowledge_memory_bundle` in order:
`export` → `verify` → `import_plan` → explicit `import_apply` with `approved: true`.
It moves scoped governed records and Markdown bodies, never a SQLite database, credentials, raw chats, or an overwrite of local conflicting data.

Evaluate this component separately from model quality: use a fixed query set containing relevant, stale, conflicting, and cross-project controls; measure evidence coverage, wrong-scope leakage, freshness/conflict handling, recall quality, latency, and cost. A successful search or Fixture does not prove that Codex improves until the same coding Cases are compared with and without the bounded receipt.

For source ingestion, call `craft_knowledge_source_ingest` and follow `next_cursor` until `has_more: false`. A stale cursor requires restarting against the current source. Unchanged documents retain review; changed/deleted documents invalidate their own claims. Review new candidates against their current document digest. Ingestion is bounded to 10,000 files, 2 MB per document and 20 MB per source; narrow the registered source if rejected. Paragraph-aware fragments preserve source offsets.

Mixed Context resolution ranks authorized Knowledge, Memory and Experience together before allocating the final budget. Use required Memory ids only when they are mandatory, and inspect omitted counts. To diagnose an installed-but-stale runtime, compare the fingerprint from `initialize`, `tools/list` and readiness; `entrypoint_digest` describes the process entry file, while `schema_digest` describes the actual exposed tool schemas. Neither proves a real Host task ran.

Both a claim's policy and its Source's current audience/tenant apply to recall. Candidate limits are applied after scope and access filtering; a candidate-budget error requires a narrower request and must not be reported as an empty knowledge base. Exact-content aggregation can remove repeated bodies while retaining bounded provenance references and an explicit omitted-reference count.

For the DSH native bundle, call `craft_knowledge_tools` to discover the actual MCP schemas and this Skill, then `craft_knowledge_call` with the chosen tool and JSON arguments. Standard MCP Hosts expose those same tools directly.

When inspecting history, a changed answer, provenance, or a requested restoration, use `craft_knowledge_asset_inspect` with the exact scope and `action: history/read/diff/explain`. History records distinguish state versions from content revisions. Compare before restoring; `craft_knowledge_asset_restore` requires the historical `version`, current `expected_version`, stable `request_id`, and `reason`. Restoration creates a new governed candidate and preserves current access restrictions; it never silently reactivates historical content.
