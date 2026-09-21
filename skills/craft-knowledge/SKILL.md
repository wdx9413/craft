---
name: craft-knowledge
description: Use Craft's standalone knowledge component to search, read, draft, review, distill, or retract evidence-backed knowledge without running the full work loop.
---

# Craft Knowledge

Use this component when the task only needs governed knowledge. It is not a chat-history dump and does not grant tool or file-write authority.

Default loop for a coding task:

1. In Codex or Claude Code, first check whether the trusted `craft-knowledge` Hook already supplied a Context Receipt. If it did, reuse that bounded Context; otherwise call `craft_component_readiness_get` with `component: "knowledge"`.
   A loaded Skill or enabled marketplace entry does not prove the current Host attached its MCP process. If the component is unavailable, say so once rather than claiming an empty knowledge store. If it is callable but behaves unlike this guidance, call `craft_component_diagnose` and compare visible tool names before assuming the data is empty.
   Readiness is only an availability preflight: it does not retrieve Knowledge, resolve Context, or count as using this component. When the task requires Knowledge, continue with the actual search or bounded resolution call.
2. If no scoped source exists, call `craft_knowledge_bootstrap_install` or explicitly register/sync one project source.
3. Call `craft_knowledge_search` before asking the user to repeat known project conventions.
4. Resolve only a bounded current-scope context with `craft_context_resolution_resolve`; record its receipt id with the task result.
5. To retain a supported fact/rule/decision, create a candidate Claim with `craft_evidence_record`. First call `craft_knowledge_semantic_review_packet`; Codex/Claude must inspect that exact Claim, fragment and rubric, then call `craft_knowledge_host_review` with its `packet_digest`, current Host turn key and exact `source_digest`. A supported low-risk current Claim is automatically promoted without a second API key. For unattended review, use `craft_knowledge_semantic_provider_review` with endpoint/model/credential environment-variable name, or bind independent observations through `craft_knowledge_support_record`. Do not turn notes, search snippets, model guesses, or repeated copies of one statement into reviewed Knowledge.
6. `craft_knowledge_promotion_policy_get` shows the local automatic threshold. An operator may explicitly adjust it with `craft_knowledge_promotion_policy_save`; this is an exception/configuration path, not a mandatory human review queue, and it never syncs to another machine.

For a controlled personal-machine migration, use `craft_knowledge_memory_bundle` in order:
`export` → `verify` → `import_plan` → explicit `import_apply` with `approved: true`.
It moves scoped governed records and Markdown bodies, never a SQLite database, credentials, raw chats, or an overwrite of local conflicting data.

Evaluate this component separately from model quality: use a fixed query set containing relevant, stale, conflicting, and cross-project controls; measure evidence coverage, wrong-scope leakage, freshness/conflict handling, recall quality, latency, and cost. A successful search or Fixture does not prove that Codex improves until the same coding Cases are compared with and without the bounded receipt.
