---
name: craft-memory
description: Use Craft's standalone scoped-memory component to resolve relevant memories or propose evidence-linked memory changes without running the full work loop.
---

# Craft Memory

When `craft-context` is available, use its task-start Skill and reuse its scoped receipt; do not repeat the same component recall. Keep this Skill for standalone access and memory operations.


Use Memory as a scoped, revisable context ledger — not a transcript archive. Resolve only the smallest task-relevant set and respect project, workspace, task, sensitivity, expiry, provenance, and revocation boundaries.

Default loop for a coding task:

1. The portable baseline is an explicit Skill + MCP call on any supported host. If an enabled trusted Hook already supplied an applicable current Context Receipt, reuse it; otherwise call `craft_component_readiness_get` with `component: "memory"` only when availability is unknown.
   A loaded Skill or enabled marketplace entry does not prove the current Host attached its MCP process. If the component is not callable in this conversation, state `unavailable` once; call `craft_component_diagnose` only when the MCP is callable but its surface looks stale or incomplete.
   Readiness is only an availability preflight: it does not read Memory, resolve Context, or count as using this component. When the task requires Memory, continue with the actual bounded resolution or governed write call.
2. Resolve the repository with `craft_scope_identity_resolve_project` using `project_root`, then pass the returned canonical scope as `scope_kind` and `scope_id`. If neither a project root nor an explicit scope is available, skip resolution.
3. Use `craft_context_resolution_resolve` only for the current task/project scope; pass `user_scope_id` only when that user scope is explicitly intended. Working Notes are TTL-bound and excluded unless `include_working_notes: true` is explicitly required.
4. When the user explicitly asks to remember a stable, useful, non-sensitive fact, prefer the single governed call `craft_memory_capture_user_statement` with `explicit_consent: true`. In Codex, `记住：…` or `/remember: …` is the only Hook-captured syntax; other phrasing still requires this explicit MCP call. It creates bounded user-statement Evidence and may `auto_accept` only when no same-topic conflict exists. Otherwise resolve the conflict, then review and materialize the candidate.
5. Run proposal-only `craft_memory_maintenance_run` with the canonical scope after a bounded batch. Inspect versioned expiry/duplicate actions; apply corrections through the existing reviewed Ledger transition path. Resolve conflicts, expiry, and revocation before reuse.

Before an important plan, tool choice, or write decision, call `craft_decision_context_gate_open`. A recall that happens after the decision does not count as prevention; the gate records the exact Context Receipt used at the decision point.

Never store credentials, raw sensitive content, full chat logs, or a model's unsupported conclusion. Test Memory with scoped positive, cross-project, expired, revoked, and conflicting fixtures; then compare the same coding Cases with and without a fixed context receipt. Only outcome improvement under the same Host/model/budget is evidence that recall helps.

To move a personal scoped ledger to another machine, use `craft_knowledge_memory_bundle` as `export` → `verify` → `import_plan` → explicitly approved `import_apply`. Do not copy `craft.db` or its WAL files: the receiving runtime recreates its own content references and preserves local conflicts for review.

For an explicit correction or forget request, list the scoped ledger and call `craft_memory_ledger_transition` with the exact `memory_id`, `expected_version`, status and reason. Revoke preserves audit history; it is not physical deletion. A stale write fails and must be reread before retry.

For a historical question use `history_view: true`, or `as_of` for business validity and `known_at` for system knowledge time. These results are diagnostic (`execution_context: false`); resolve current context again before an action. Current scope, audience, tenant, source access and sensitivity restrictions still apply to old versions, exact reads, lists and maintenance. Historical access never restores a revoked permission.

For vector/hybrid retrieval, call `craft_retrieval_adapter_evaluate` with a labelled `dataset` containing scoped documents and query/expected-id cases. Runtime execution and bound results determine eligibility; caller-reported metrics alone cannot enable it. Inspect the returned actual strategy, fallback reason and cost availability. Helpful feedback needs program/confirmed Evidence bound to the Context Receipt to affect relevance ties; it never promotes or restores Memory.

For the DSH native bundle, call `craft_memory_tools` to discover the actual MCP schemas and this Skill, then `craft_memory_call` with the chosen tool and JSON arguments. Standard MCP Hosts expose those same tools directly.

When inspecting history, a changed answer, provenance, or a requested restoration, use `craft_memory_asset_inspect` with the exact scope and `action: history/read/diff/explain`. History records distinguish state versions from content revisions. Compare before restoring; `craft_memory_asset_restore` requires the historical `version`, current `expected_version`, stable `request_id`, and `reason`. Restoration creates a new governed candidate and preserves current access restrictions; it never silently reactivates historical content.
