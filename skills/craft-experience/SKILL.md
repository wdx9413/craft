---
name: craft-experience
description: Use Craft Experience to discover, edit and evaluate versioned scenario Graphs, or turn repeated verified outcomes into procedure candidates. Select named entries/exits and pinned child procedures for reusable work.
---

# Craft Experience

When `craft-context` is available, use its task-start Skill and reuse its scoped receipt; do not repeat the same component recall. Keep this Skill for standalone access and experience operations.


Treat source executions as evidence references, never as copied customer or business content. Experience is distinct from Knowledge and Memory, but an already routeable Procedure is a scoped Context contribution at the start of a turn. Observation, Pattern and Candidate are diagnostic records, not Context. Its governed output is a Procedure. Scenario assets are Experience Graphs; Workflow is their restricted flow form. The compatibility formats remain workflow, graph and prompt.

Choose the usage mode before writing to the Experience ledger:

- **Read-only guidance:** When the user asks how to handle a Code Review or a full requirement, inspect the scoped, routeable Procedures and explain the applicable Entry/Exit, version, prerequisites and evidence. If none applies, give ordinary advice or a Workflow design specification; do not invent Observations or persist a Candidate.
- **Explicit configuration:** Read [Runtime Graph](references/runtime-graph.md) to discover a scene, obtain a Runtime template, edit its draft and submit an exact digest as a scoped Candidate. `craft_procedure_configuration_save` remains the direct configuration path. No prior execution count is required for a user-authored configuration. It is not routeable until its actual gates pass.
- **Automatic recommendation or routing:** Only recommend a route when a routeable Procedure and the current task's scope, Entry/Exit, input references, effects and preconditions match. Use `craft_procedure_plan` to show the bounded plan and pinned child versions. The plan is read-only; execution still requires the Host Task/Policy and acceptance receipts. If these inputs are unavailable, return a recommendation with the missing conditions instead of choosing a route silently.

When a task needs a full development flow, Code Review only, multiple delivery boundaries, or subprocedure reuse, read [Procedure composition](references/composition.md). Select an Entry/Exit and call `craft_procedure_plan` after promotion; materialize only the selected route under the current Host Task/Policy.

For actual execution, interruption recovery, child-exit acceptance, or paired outcome evaluation, read [Procedure invocation](references/invocation.md). Bind to an existing Verified Work Loop and preserve the Host-attested evidence boundary.

When a user wants to describe or improve a repeated human workflow before executions exist, read [Workflow design](references/design.md). Produce a scoped specification and unresolved decisions; collect actual outcomes only after authorized execution.

Default loop for repeated coding work:

1. Resolve a known project root with `craft_scope_identity_resolve_project`. The portable baseline explicitly calls `craft_context_resolution_resolve` with canonical `scope_kind`, `scope_id` and `members: ["experience"]`; it is safe for an empty ledger and must not scan other projects. Call `craft_component_readiness_get` with `component: "experience"` when diagnosing availability.
   A loaded Skill does not prove that MCP is mounted. If this component is missing in an otherwise enabled plugin, call `craft_component_diagnose` to distinguish an empty Experience ledger from an unattached or stale Host bundle.
   Readiness is only an availability preflight: it does not record an Observation, create a Workflow draft, or count as using Experience. Continue with the actual observation call after a real outcome.
2. After a real, independently observed outcome, record or reuse bounded Evidence and call `craft_experience_observe` with a stable scenario key such as `coding:test-failure-recovery`. An optional trusted Hook may supply bounded host observations after a local edit plus terminal verification; this is not independent proof of acceptance. It stores digests and result classes, never command or output bodies. The observation must be sanitized and content-free. For explicit MCP or CI intake, attach `verification` with `contract_ref`, `workspace_revision`, `producer`, `started_at`, `completed_at`, `exit_code`, and `evidence_digest`. Craft rejects contradictory outcomes and records the receipt as host-attested; independent execution must be verified by the configured runner, never inferred from this submission.
3. Do not propose anything before at least two independent observations sharing a `ScenarioSignature`. Call `craft_experience_procedure_draft` with at most two design axes. Use its default linear `workflow`; request `graph` when evidence requires runtime conditional branches, loops or compensation beyond the bounded Route/Invocation contract. Independent read-only steps can use explicit Route parallel groups.
4. A Host or configured model may submit the bounded proposal. Then call `craft_procedure_create` with a meaningful lowercase English `procedure_id`, such as `product-development`, to persist a Procedure Candidate; reuse the ID for subsequent revisions. `workflow` and `graph` are authoritative JSON revisions under the selected data root’s `experience/graph/<graph-id>/versions/`; their Markdown files under `md/workflows/` and `md/graphs/` are review views. A short `prompt` Procedure remains Markdown-native under `md/prompts/`. Nothing is usable by default, and this is not the Capability registry.
5. Record `shadow → held_out → signoff → canary` via `craft_procedure_gate`. Only a routeable Procedure is injected into Context. `craft_procedure_export_skill` writes a disabled `SKILL.md` draft under `~/.craft_data/experience/skills/` and, for Workflow/Graph, a neighboring `PROCEDURE.json`; it never installs or enables either asset. If it conflicts with an activated Capability, present both provenance/version records; Policy decides any effectful activation.

For a coding evaluation suite, compare a minimal baseline with exactly one draft change under fixed repository Fixture, Host/model version, capability versions, budget, acceptance commands, and repeated paired Trials (3–5 is only a smoke sample). Measure terminal test pass rate, first-pass rate, invalid retries, recovery, cost, latency, and regressions. A collected observation or drafted Workflow never proves self-improvement.

For the DSH native bundle, call `craft_experience_tools` to discover the actual MCP schemas and this Skill, then `craft_experience_call` with the chosen tool and JSON arguments. Standard MCP Hosts expose those same tools directly.

When inspecting history, a changed answer, provenance, or a requested restoration, use `craft_experience_asset_inspect` with the exact scope and `action: history/read/diff/explain`. History records distinguish state versions from content revisions. Compare before restoring; `craft_experience_asset_restore` requires the historical `version`, current `expected_version`, stable `request_id`, and `reason`. Restoration creates a new governed candidate and preserves current access restrictions; it never silently reactivates historical content.

For scenario/subscenario configuration, evidenced Graph transitions, bounded rework, or version pinning, read [Runtime Graph](references/runtime-graph.md). Use user-authored configuration candidates directly when no execution history exists.

Configured Workflow/Graph definitions can use the same governed Skill export after becoming routeable. During rework, a material name may resolve to an earlier still-valid input; use the returned current bindings and fresh acceptance receipts instead of reusing an invalidated output with the same name.
