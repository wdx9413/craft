---
name: craft
description: Use Craft for substantial work that benefits from durable goals, bounded context, evidence, verification, or a reusable workflow.
---

# Craft

Use this Skill only for substantial work. For a brief answer, simple rewrite, or one-step read, answer directly.

1. Call `craft_default_route` with the user's goal. Let Craft select a verified Workflow or create a safe Host-mediated route.
2. Read only the specific Capability candidates returned by Craft. Do not load an entire Skill or MCP catalog into context.
3. Before a material handoff, call `craft_task_checkpoint` with observed progress, decisions, references, and uncertainties. Do not mark a model claim as verified.
4. Record acceptance-relevant facts as Artifact or Evidence. Treat external writes, credentials, and expanded permissions as approval-gated.
5. To continue known work, use `craft_default_route_resume`; if the identity is only described in natural language, use `craft_default_route_find` and do not guess between matches.

Craft preserves task continuity and governance. The host still controls tool execution and user approval.
