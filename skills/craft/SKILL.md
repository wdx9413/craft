---
name: craft
description: "Default orchestrator for substantial user work: route goals to verified workflows or a safe host plan, continue durable tasks, preserve evidence, and improve only through gated evaluation."
---

# Craft

Craft stores its own state under `~/.craft_data`. Use Craft at meaningful boundaries; do not checkpoint every conversational sentence.

## Default routing

For substantial work—multi-step development, diagnosis, research, a recurring task, a request to select Skills, or any task whose result should be reusable—use Craft as the default orchestrator. Do this without asking the user to repeat an orchestration prompt:

1. Call `craft_default_route` with the user's goal. `title` is optional; Craft derives it from the goal when omitted.
2. If it returns `next_action.kind=execute_verified_workflow`, read only the selected capabilities as needed, then use `craft_default_route_execute`. It can run only the exact Workflow version Craft selected and only with Host-approved side effects.
3. If it returns `next_action.kind=complete_stage`, carry out that one Host-mediated stage. Register real artifacts/evidence where available, then call `craft_default_route_update`. The final `review` update records the observed Outcome and surfaces evidence-backed experience candidates.
4. When continuing a known task, call `craft_default_route_resume` with its `task_id` and do only the returned next action. If the user says “continue” with identifying words but the task is not known, call `craft_default_route_find` first; it resumes a unique active match and returns `ambiguous` rather than guessing. Ask only when it is ambiguous or not found.
5. After two or more passed, evidence-backed routes share the same strategy, the Host may distill project-neutral executable steps and call `craft_route_workflow_proposal_create`. It creates only a `draft` Workflow with evidence references. Never copy raw business text, credentials, or unverified commands into the proposal; use the normal held-out Evaluation/Signoff Gate before promotion.

Skip default routing for a short self-contained answer, a simple rewrite, or a one-step read that has no durable value. Craft never treats an unverified Skill, a model assertion, or an unapproved command as an executable Workflow.

## Operating rules

- `craft_default_route` owns normal Task creation and route selection. Use `craft_task_open` only for a direct Task lookup or when a caller deliberately manages a Task outside the default route.
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
- For multi-Agent work, create a DAG whose nodes have roles, objectives, dependencies, profile candidates, and side-effect classes. Use `craft_orchestration_trial_start` instead of an ordinary Plan when the execution will feed evaluation or reusable experience; it pins every Agent Profile version and captures the lifecycle automatically. Dispatch only host capacity you can actually execute. Submit each observed verdict with its real provenance, costs, and relevant Artifact/Evidence IDs.
- Add a Source only when the user selected that directory. Removing a Source deletes only its Craft index, never source files.
- Never store credentials, cookies, sensitive raw payloads, or unnecessary business text. Store references and concise derived state.

Read [tool contract](references/tool-contract.md) when constructing a call, [Workflow runtime](references/workflow-runtime.md) for deterministic execution and promotion, and [multi-Agent runtime](references/multi-agent-runtime.md) for routing.
