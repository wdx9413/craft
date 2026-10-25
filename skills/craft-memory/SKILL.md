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
4. Capture only stable, useful, non-sensitive facts; never turn the transcript into Memory. A Host model may extract a durable fact from the current task without a `记住` request and call `craft_memory_capture_observed_fact` with the exact current `session_id`, canonical `project_scope_id`, short fact, and stable topic. Craft places it in session scope first; governed policy commits conflict-free bounded Evidence automatically. Do not invent session IDs, capture routine task text, or write directly to project/global scope. `craft_memory_capture_user_statement` remains the path for a user-authored statement that should be captured as such. The same fact seen in two independent sessions in one project is promoted to project scope; the same fact active in three projects is promoted to global scope. For a changed fact on the same topic, governed policy may supersede the older entry once repeated observations and all supporting Evidence meet the configured threshold; the replacement and prior entry remain linked in Ledger history. Conflicts without sufficient independent Evidence, or when policy is not governed, stay pending. Session memory is deleted when that session is archived.
5. Run proposal-only `craft_memory_maintenance_run` with the canonical scope after a bounded batch. Inspect versioned expiry/duplicate actions; apply corrections through the existing reviewed Ledger transition path. Resolve conflicts, expiry, and revocation before reuse.

Before an important plan, tool choice, or write decision, call `craft_decision_context_gate_open`. A recall that happens after the decision does not count as prevention; the gate records the exact Context Receipt used at the decision point.

Never store credentials, raw sensitive content, full chat logs, or a model's unsupported conclusion. Test Memory with scoped positive, cross-project, expired, revoked, and conflicting fixtures; then compare the same coding Cases with and without a fixed context receipt. Only outcome improvement under the same Host/model/budget is evidence that recall helps.

To move a personal scoped ledger to another machine, use `craft_knowledge_memory_bundle` as `export` → `verify` → `import_plan` → explicitly approved `import_apply`. Do not copy `craft.db` or its WAL files: the receiving runtime recreates its own content references and preserves local conflicts for review.

All persistent Craft data is stored beneath `~/.craft_data/`. Session memory is stored at `~/.craft_data/sessions/<host>--<sha256(session_id)>/memory/memory.md` and is physically removed when the Host archives the session. The storage key binds both Host and session ID; raw IDs are not path segments. Global memory is projected to `~/.craft_data/memory/memory.md`; project memory is projected to `~/.craft_data/projects/<readable-project-name>--<sha256(canonical-project-root)>/memory/memory.md`. Knowledge and Experience remain in their own capability directories under the same data root. For an explicit correction or forget request, list the scoped ledger and call `craft_memory_ledger_transition` with the exact `memory_id`, `expected_version`, status and reason. Revoke preserves audit history; expiry and session archive remove recall eligibility, while revoked project/global entries remain in the audit history. A stale write fails and must be reread before retry.

For a historical question use `history_view: true`, or `as_of` for business validity and `known_at` for system knowledge time. These results are diagnostic (`execution_context: false`); resolve current context again before an action. Current scope, audience, tenant, source access and sensitivity restrictions still apply to old versions, exact reads, lists and maintenance. Historical access never restores a revoked permission.

For vector/hybrid retrieval, call `craft_retrieval_adapter_evaluate` with a labelled `dataset` containing scoped documents and query/expected-id cases. Runtime execution and bound results determine eligibility; caller-reported metrics alone cannot enable it. Inspect the returned actual strategy, fallback reason and cost availability. Helpful feedback needs program/confirmed Evidence bound to the Context Receipt to affect relevance ties; it never promotes or restores Memory.

For the DSH native bundle, call `craft_memory_tools` to discover the actual MCP schemas and this Skill, then `craft_memory_call` with the chosen tool and JSON arguments. Standard MCP Hosts expose those same tools directly.

When inspecting history, a changed answer, provenance, or a requested restoration, use `craft_memory_asset_inspect` with the exact scope and `action: history/read/diff/explain`. History records distinguish state versions from content revisions. Compare before restoring; `craft_memory_asset_restore` requires the historical `version`, current `expected_version`, stable `request_id`, and `reason`. Restoration creates a new governed candidate and preserves current access restrictions; it never silently reactivates historical content.

If capture returns `confirm_topic_or_explicit_replacement`, inspect the suggested exact Memory refs and confirm the shared subject or an explicitly authorized replacement before review/commit. Hints are not permission to supersede an entry. Use `craft_memory_governance(action: topics|tasks|confirm)` to inspect suggestions/tasks or bind an unchanged entry to user Evidence.
