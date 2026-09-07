# Tool contract

All public tools use a `craft_` prefix. IDs returned by Craft are opaque and must be reused unchanged.

- Sources: `craft_source_add/list/update/remove/scan`
- Capabilities: `craft_capability_search/get`
- Tasks: `craft_task_open/list/checkpoint`, `craft_feedback_record`
- Evidence: `craft_artifact_register/get/list`, `craft_evidence_record/get/list`
- Workflows: `craft_workflow_save/get/search/plan/run/trial_run/run_get/transition/rollback`
- Harness configurations: `craft_harness_configuration_save/get/list`
- Experience: `craft_trial_start/get/list`, `craft_trial_trace_append`, `craft_outcome_record`
- Evaluations: `craft_eval_suite_save/get/list`, `craft_evaluation_run_record/get/list`
- Agent routing: `craft_agent_profile_save/get/list`, `craft_orchestration_plan_create/get/list`, `craft_orchestration_dispatch/submit`

Optional arguments can be omitted. Do not pass secrets in metadata. Treat an MCP result with `isError: true` as a rejected operation, even though the JSON-RPC request itself succeeded.

Trial, Outcome, and Evaluation Run records are immutable. A Trace is append-only. Evaluation Case `split` is one of `search`, `development`, or `held_out`; only a passed held-out run for the exact candidate Workflow version can authorize `verified`.

`craft_workflow_trial_run` requires an existing Task. It pins the planned Workflow version, executes it, and automatically creates the Trial lifecycle records. A failed deterministic step is a normal failed run; a runtime crash is captured as a sanitized failed Outcome without storing the raw exception message.
