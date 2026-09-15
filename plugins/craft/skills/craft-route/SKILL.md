---
name: craft-route
description: "Route substantial work through Craft's smallest safe MCP surface; load a verified capability only when the route selects it."
---

# Craft Route

Use this lightweight entry point before choosing detailed Craft or third-party tools. It is a routing contract, not a replacement for the Craft service.

The primary `craft` plugin is the complete Craft runtime: Knowledge, Memory,
Capability discovery, Skill Quality, and Workflow Evolution are all available
through its compact syscall surface. They are addressed on demand with
`craft_describe` followed by a syscall verb and `(resource, operation)`; do not
ask the user to install a sibling component merely to use one of those built-in
capabilities. The sibling plugins are optional standalone projections for a
Host that wants only one bounded domain surface.

For a fresh Craft data store, call `craft_knowledge_bootstrap_install` once
before the first governed knowledge or memory operation. It only registers the
bundled Evidence Wiki and Serena descriptors; it must not be treated as
permission to read external project files or automatically persist the chat.

## Decide first

- For a short answer, simple rewrite, or one-step read with no durable value, answer directly and do not call Craft.
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
