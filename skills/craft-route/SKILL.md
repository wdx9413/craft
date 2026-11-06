---
name: craft-route
description: "Route substantial work through Craft's smallest safe MCP surface; load a verified capability only when the route selects it."
---

# Craft Route

Use this lightweight entry point before choosing detailed Craft or third-party tools. It is a routing contract, not a replacement for the Craft service.

The Craft Runtime is MCP-first: `craft-mcp --product full` exposes the complete
runtime, while `context`, `knowledge`, `memory`, `capability`, `quality`, and
`experience` are formal bounded MCP products. The primary `craft` plugin merely
packages the full MCP product with this Skill for Codex. Context (Knowledge +
Memory), Capability discovery, Quality, and bounded Experience/Workflow Evolution are all available
through the compact syscall surface. They are addressed on demand with
`craft_describe` followed by a syscall verb and `(resource, operation)`; do not
ask the user to install a sibling component merely to use one of those built-in
capabilities. The recommended sibling plugins are `craft-context`,
`craft-capability`, and `craft-quality`; they are optional standalone
projections for a Host that wants only one bounded outcome. Knowledge and
Memory remain first-class narrow products; `craft-skill-quality` remains a
compatibility name. Experience records sanitized observations and may propose
bounded Workflow drafts; it never makes a draft routeable by itself.

For a fresh Craft data store, call `craft_knowledge_bootstrap_install` once
before the first governed knowledge or memory operation. It only registers the
bundled Evidence Wiki and Serena descriptors; it must not be treated as
permission to read external project files or automatically persist the chat.

## Decide each turn, then route only when needed

- A short answer, simple rewrite, or one-step read may remain direct. Do not manufacture a task, context lookup, capability search, or memory merely because Craft is installed.
- When the turn may benefit from project knowledge, a Skill/MCP/Workflow choice, durable continuity, or a candidate memory, submit the smallest content-free Turn Proposal and follow the scoped Turn Receipt. The Receipt is advisory: it never starts a Host or grants a wider effect.
- A Host that has no native turn hook submits Proposals manually or through its own Adapter. The generic Skill + MCP scaffold does not install a lifecycle hook; at task start perform the selected bounded read, and at task end perform only the selected governed write/observation. Never claim Craft installed a hook or started a second Codex/Claude CLI process.
- Candidate memory is not durable memory. It must be explicitly accepted through the Memory Ledger with its original source, scope, sensitivity, and evidence.
- When a missing decision materially changes the deliverable, external effect, or acceptance rule, state a short working contract and ask at most three decision-changing questions. Do not require another Skill to do this.
- For a known durable task, call `craft_default_route_resume`. If only a natural-language continuation is available, call `craft_default_route_find`; never select an ambiguous task.
- For other substantial work, call `craft_default_route` once. Follow only the returned next safe action.
- Before starting a governed task, compile the natural-language goal with `craft_intent_compile`; if it returns clarification questions, resolve those before execution. Compile the corresponding `craft_acceptance_compile` contract before claiming completion. This applies to every domain, not only software coverage tasks.

## Route, then narrow

1. Read only the Capability or Workflow references selected by the route. Do not inspect an entire Skill, MCP, or expert catalog.
2. Use the default Craft MCP for routing, bounded context, task continuity, evidence, profile-bound tickets, and any selected built-in Knowledge, Memory, Capability, Quality, or Workflow Evolution operation. First call `craft_describe` for an unfamiliar resource so its exact contract, effect, and approval rule are known. A ticket is not permission to widen scope.
3. Record observed material progress with `craft_task_checkpoint`; register acceptance-relevant artifacts or evidence when the route requires it.
4. Use the Full MCP only for a user-approved administrative action such as registering, approving, or changing an external capability source. It is an explicit upgrade, not a fallback for ordinary work.

Craft decides the governed route, compiles the shared Task/Acceptance Contract, and records receipts. The Host still decides whether a tool actually starts, and the user/Host approval path still governs every external effect.
