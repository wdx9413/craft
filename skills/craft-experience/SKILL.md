---
name: craft-experience
description: Craft Experience turns repeated verified outcomes into proposal-only procedures. A procedure is linear by default; use a Graph only when evidence proves control-flow complexity.
---

# Craft Experience

Treat source executions as evidence references, never as copied customer or business content. Experience is distinct from Knowledge and Memory, but an already routeable Procedure is a scoped Context contribution at the start of a turn. Observation, Pattern and Candidate are diagnostic records, not Context. Its output is a Procedure; Workflow, Graph and Prompt Procedure are three stored formats.

Default loop for repeated coding work:

1. At turn start, the trusted Hook resolves only routeable Experience Procedures for the current project scope. When Hook is unavailable, call `craft_context_resolution_resolve` with `members: ["experience"]`; it is safe for an empty ledger and must not scan other projects. Call `craft_component_readiness_get` with `component: "experience"` when diagnosing availability.
   A loaded Skill does not prove that MCP is mounted. If this component is missing in an otherwise enabled plugin, call `craft_component_diagnose` to distinguish an empty Experience ledger from an unattached or stale Host bundle.
   Readiness is only an availability preflight: it does not record an Observation, create a Workflow draft, or count as using Experience. Continue with the actual observation call after a real outcome.
2. After a real, independently observed outcome, record or reuse bounded Evidence and call `craft_experience_observe` with a stable scenario key such as `coding:test-failure-recovery`. A trusted Codex or Claude Code Hook can create this only after a local edit plus terminal verification; it stores digests and result classes, never command or output bodies. The observation must be sanitized and content-free.
3. Do not propose anything before at least two independent observations sharing a `ScenarioSignature`. Call `craft_experience_procedure_draft` with at most two design axes. Use its default linear `workflow`; request `graph` only when the evidence shows a branch, parallel join, approval, recovery, or compensation.
4. A Host or configured model may submit the bounded proposal. Then call `craft_procedure_create` to persist a Procedure Candidate. `workflow` and `graph` are authoritative JSON assets under `~/.craft_data/experience/procedures/workflows/` and `procedures/graphs/`; their Markdown files under `md/workflows/` and `md/graphs/` are review views. A short `prompt` Procedure remains Markdown-native under `md/prompts/`. Nothing is usable by default, and this is not the Capability registry.
5. Record `shadow → held_out → signoff → canary` via `craft_procedure_gate`. Only a routeable Procedure is injected into Context. `craft_procedure_export_skill` writes a disabled `SKILL.md` draft under `~/.craft_data/experience/skills/` and, for Workflow/Graph, a neighboring `PROCEDURE.json`; it never installs or enables either asset. If it conflicts with an activated Capability, present both provenance/version records; Policy decides any effectful activation.

For a coding evaluation suite, compare a minimal baseline with exactly one draft change under fixed repository Fixture, Host/model version, capability versions, budget, acceptance commands, and 3–5 paired Trials. Measure terminal test pass rate, first-pass rate, invalid retries, recovery, cost, latency, and regressions. A collected observation or drafted Workflow never proves self-improvement.
