# Tool contract

All public tools use a `craft_` prefix. IDs returned by Craft are opaque and must be reused unchanged.

- Sources: `craft_source_add/list/update/remove/scan`
- Capabilities: `craft_capability_search/get`
- Tasks: `craft_task_open/list/checkpoint`, `craft_feedback_record`
- Evidence: `craft_artifact_register/get/list`, `craft_evidence_record/get/list`
- Workflows: `craft_workflow_save/get/search/plan/run/run_get`
- Evaluation definitions: `craft_eval_suite_save/get/list`
- Agent routing: `craft_agent_profile_save/get/list`, `craft_orchestration_plan_create/get/list`, `craft_orchestration_dispatch/submit`

Optional arguments can be omitted. Do not pass secrets in metadata. Treat an MCP result with `isError: true` as a rejected operation, even though the JSON-RPC request itself succeeded.
