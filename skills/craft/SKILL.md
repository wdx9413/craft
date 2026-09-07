---
name: craft
description: Discover user-managed capabilities, continue durable work, preserve evidence, run verified workflows, or coordinate a dependency-aware Agent plan with Craft.
---

# Craft

Craft stores its own state under `~/.craft_data`. Use Craft at meaningful boundaries; do not checkpoint every conversational sentence.

## Operating rules

- For a known task, call `craft_task_open` with `task_id`. Otherwise use `craft_task_list` or create a task with a concise title and goal.
- Search capabilities with `craft_capability_search`. Read only the selected candidate with `craft_capability_get`; never load the whole catalog into context.
- Call `craft_task_checkpoint` after material progress or before handoff. Separate completed work, pending work, decisions, and artifact references. Do not label an unobserved claim verified.
- Record explicit corrections with `craft_feedback_record` at the narrowest correct scope.
- Register outputs with `craft_artifact_register` and decision-relevant claims with `craft_evidence_record`. Use `confirmed`, `bounded`, `unverified`, or `rejected` accurately.
- Save reusable processes with `craft_workflow_save`. Replace task-specific values with inputs.
- Call `craft_workflow_plan` before execution. Only pass side-effect approvals already granted by the user or host. Deterministic results take precedence over model self-reporting. Use `craft_workflow_trial_run` when the run should become evaluation or reusable experience; it captures the Trial, Trace, receipt Artifact, Evidence, and Outcome together. Use `craft_workflow_run` for an ordinary execution that does not need that lifecycle.
- Use a Trial when an execution will inform comparison, qualification, or reusable experience; do not create one for every trivial read. Bind the exact subject and Harness Configuration versions, append decision-relevant Trace events, and record one Outcome with real evidence and cost.
- Treat `search` and `development` cases as design inputs. Promote a Workflow to `verified` only with the matching passed `held_out` Evaluation Run. Never relabel development evidence as held-out evidence.
- Before comparing versions, aggregate each Evaluation Run and use `craft_evaluation_compare`; do not compare reports informally. The gate requires the same Evaluation Suite exact version, split, Subject type, and Case multiset. Treat higher quality/score as favorable and lower cost/duration as favorable, inspect failure-type shifts, and do not describe raw deltas as statistically significant.
- Use versioned Graders for program, model, human, and operational judgments. Record each Grade against the exact Trial and Grader version. When a Signoff Policy applies, evaluate it from explicit Grade IDs and promote with the resulting passed Signoff; never present one provenance type as another.
- Roll back only to a version Craft already recorded as `verified`; preserve the reason instead of overwriting history.
- For multi-Agent work, create a DAG whose nodes have roles, objectives, dependencies, profile candidates, and side-effect classes. Dispatch only host capacity you can actually execute. Submit the observed verdict with real provenance.
- Add a Source only when the user selected that directory. Removing a Source deletes only its Craft index, never source files.
- Never store credentials, cookies, sensitive raw payloads, or unnecessary business text. Store references and concise derived state.

Read [tool contract](references/tool-contract.md) when constructing a call, [Workflow runtime](references/workflow-runtime.md) for deterministic execution and promotion, and [multi-Agent runtime](references/multi-agent-runtime.md) for routing.
