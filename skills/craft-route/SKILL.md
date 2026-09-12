---
name: craft-route
description: "Route substantial work through Craft's smallest safe MCP surface; load a verified capability only when the route selects it."
---

# Craft Route

Use this lightweight entry point before choosing detailed Craft or third-party tools. It is a routing contract, not a replacement for the Craft service.

## Decide first

- For a short answer, simple rewrite, or one-step read with no durable value, answer directly and do not call Craft.
- When a missing decision materially changes the deliverable, external effect, or acceptance rule, use the `craft-clarify` contract first. Ask only decision-changing questions.
- For a known durable task, call `craft_default_route_resume`. If only a natural-language continuation is available, call `craft_default_route_find`; never select an ambiguous task.
- For other substantial work, call `craft_default_route` once. Follow only the returned next safe action.

## Route, then narrow

1. Read only the Capability or Workflow references selected by the route. Do not inspect an entire Skill, MCP, or expert catalog.
2. Use the Core MCP for routing, bounded context, task continuity, evidence, and profile-bound tickets. A ticket is not permission to widen scope.
3. Record observed material progress with `craft_task_checkpoint`; register acceptance-relevant artifacts or evidence when the route requires it.
4. Use the Full MCP only for a user-approved administrative action such as registering, approving, or changing an external capability source. It is an explicit upgrade, not a fallback for ordinary work.

Craft decides the governed route and records receipts. The Host still decides whether a tool actually starts, and the user/Host approval path still governs every external effect.
