# Tool contract

All public tools use a `craft_` prefix. IDs returned by Craft are opaque and must be reused unchanged.

- Sources: `craft_source_add/list/update/remove/scan`
- Capabilities: `craft_capability_search/get`
- Tasks: `craft_task_open/list/checkpoint`, `craft_feedback_record`
- Evidence: `craft_artifact_register/get/list`, `craft_evidence_record/get/list`
- Workflows: `craft_workflow_save/get/search/plan/run/trial_run/run_get/transition/rollback`
- Harness configurations: `craft_harness_configuration_save/get/list`
- Experience: `craft_trial_start/get/list`, `craft_trial_trace_append`, `craft_outcome_record`
- Evaluations: `craft_eval_suite_save/get/list`, `craft_evaluation_run_record/get/list/aggregate`, `craft_evaluation_compare`, `craft_evaluation_comparison_get/list`
- Grading: `craft_grader_save/get/list`, `craft_grade_record/get/list`
- Signoff: `craft_signoff_policy_save/get/list`, `craft_signoff_evaluate/get/list`
- Agent routing: `craft_agent_profile_save/get/list`, `craft_orchestration_plan_create/get/list`, `craft_orchestration_trial_start/finalize`, `craft_orchestration_dispatch/submit`

Optional arguments can be omitted. Do not pass secrets in metadata. Treat an MCP result with `isError: true` as a rejected operation, even though the JSON-RPC request itself succeeded.

Trial, Outcome, and Evaluation Run records are immutable. A Trace is append-only. Evaluation Case `split` is one of `search`, `development`, or `held_out`; only a passed held-out run for the exact candidate Workflow version can authorize `verified`.

An Outcome may store a concise `failure_type`; failed records without one aggregate as `unspecified`. `craft_evaluation_run_aggregate` computes pass rate, verdict counts, numeric score summaries, numeric cost summaries, and failure counts from immutable Outcomes. `craft_evaluation_compare` persists an immutable comparison only when both runs use the same Suite ID and version, split, Subject type, and exact Case multiset. A delta is descriptive evidence, not a confidence interval or statistical-significance claim.

`craft_workflow_trial_run` requires an existing Task. It pins the planned Workflow version, executes it, and automatically creates the Trial lifecycle records. A failed deterministic step is a normal failed run; a runtime crash is captured as a sanitized failed Outcome without storing the raw exception message.

A Grade is immutable and binds one Trial to one exact Grader version. A Signoff evaluates only the explicitly supplied Grade IDs, so the decision is reproducible. Policy requirements apply to every Trial in the Evaluation Run; a required provenance type cannot be substituted by another type.

An advisory Signoff may pass under a Policy that does not require held-out data or passed Outcomes, but it cannot promote a Workflow. Workflow verification always additionally requires the underlying Evaluation Run to be held-out and passed.

`craft_orchestration_trial_start` creates a Plan and a Trial together. Plan creation resolves every route to an exact Agent Profile version; dispatch returns that pinned version. For trial-backed Plans, dispatch and submission append Trace events. Each submission may carry non-negative numeric costs plus existing Artifact/Evidence IDs. A terminal Plan automatically produces an orchestration receipt, Evidence, and one Outcome. If a host interruption leaves a terminal Plan without its Outcome, `craft_orchestration_trial_finalize` safely reconciles it and is idempotent after success. An ordinary `craft_orchestration_plan_create` remains available for coordination that should not enter evaluation history.
