---
name: craft-memory
description: Use Craft's standalone scoped-memory component to resolve relevant memories or propose evidence-linked memory changes without running the full work loop.
---

# Craft Memory

Use Memory as a scoped, revisable context ledger — not a transcript archive. Resolve only the smallest task-relevant set and respect project, workspace, task, sensitivity, expiry, provenance, and revocation boundaries.

Default loop for a coding task:

1. In Codex, first check whether the trusted `craft-memory` Hook already supplied a Context Receipt. If it did, reuse that bounded Context; otherwise call `craft_component_readiness_get` with `component: "memory"`.
   If a configured component is not callable in this conversation, call `craft_component_diagnose`; an enabled marketplace entry alone does not prove the current Host attached its MCP process.
2. If the current task has no explicit scope, skip resolution rather than searching a global store.
3. Use `craft_context_resolution_resolve` only for the current project/task scope and retain its receipt with the outcome.
4. When the user explicitly asks to remember a stable, useful, non-sensitive fact, prefer the single governed call `craft_memory_capture_user_statement` with `explicit_consent: true`. In Codex, `记住：…` or `/remember: …` is the only Hook-captured syntax; other phrasing still requires this explicit MCP call. It creates bounded user-statement Evidence and may `auto_accept` only when no same-topic conflict exists. Otherwise resolve the conflict, then review and materialize the candidate.
5. Run proposal-only `craft_memory_maintenance_run` after a bounded batch, not after every message. Resolve conflicts, expiry, and revocation before reuse.

Before an important plan, tool choice, or write decision, call `craft_decision_context_gate_open`. A recall that happens after the decision does not count as prevention; the gate records the exact Context Receipt used at the decision point.

Never store credentials, raw sensitive content, full chat logs, or a model's unsupported conclusion. Test Memory with scoped positive, cross-project, expired, revoked, and conflicting fixtures; then compare the same coding Cases with and without a fixed context receipt. Only outcome improvement under the same Host/model/budget is evidence that recall helps.

To move a personal scoped ledger to another machine, use `craft_knowledge_memory_bundle` as `export` → `verify` → `import_plan` → explicitly approved `import_apply`. Do not copy `craft.db` or its WAL files: the receiving runtime recreates its own content references and preserves local conflicts for review.
