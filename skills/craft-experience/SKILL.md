---
name: craft-experience
description: Craft Experience component for creating bounded Workflow drafts from sanitized observations. Use complete Craft and Craft Quality to evaluate, sign off, canary, or route a draft.
---

# Craft Experience

Treat source executions as evidence references, never as copied customer or business content. Experience is a diagnostic learning layer; verified Workflow/Skill instructions are its separately governed executable derivative.

Default loop for repeated coding work:

1. Call `craft_component_readiness_get` with `component: "experience"`.
   If this component is missing in an otherwise enabled plugin, call `craft_component_diagnose` to distinguish an empty Experience ledger from an unattached or stale Host bundle.
   Readiness is only an availability preflight: it does not record an Observation, create a Workflow draft, or count as using Experience. Continue with the actual observation call after a real outcome.
2. After a real, independently observed outcome, record or reuse bounded Evidence and call `craft_workflow_evolution_observe` with a stable scenario key such as `coding:test-failure-recovery`. A trusted Codex Hook can create this only after a local edit plus terminal verification; it stores digests and result classes, never command or output bodies. The observation must be sanitized and content-free.
3. Do not propose anything before at least two independent observations of the same scenario. Call `craft_workflow_evolution_propose` with at most two design axes.
4. A Host or configured model may submit a draft with `craft_workflow_evolution_proposal_submit`; it is not usable by default.
5. Evaluate the draft in shadow and held-out Cases, then use Craft Quality/Signoff/Canary before it becomes routeable. Preserve rejected proposals with their regression evidence and retry condition.

For a coding evaluation suite, compare a minimal baseline with exactly one draft change under fixed repository Fixture, Host/model version, capability versions, budget, acceptance commands, and 3–5 paired Trials. Measure terminal test pass rate, first-pass rate, invalid retries, recovery, cost, latency, and regressions. A collected observation or drafted Workflow never proves self-improvement.
