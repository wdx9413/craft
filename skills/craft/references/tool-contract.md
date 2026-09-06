# Craft tool contract

All public MCP tool names begin with `craft_`.

- `craft_info`: read the resolved data directory and counts.
- `craft_source_add`: register a user-selected directory; `scan` defaults to true.
- `craft_source_list`: show requested paths, resolved real paths, and refresh state.
- `craft_source_update`: enable, disable, or relabel one source.
- `craft_source_remove`: forget one source and its index without deleting source files.
- `craft_source_scan`: rescan one source by ID, or all sources when omitted.
- `craft_capability_search`: refresh sources older than `stale_after_seconds` when enabled, then retrieve at most 20 compact candidates; default 6.
- `craft_capability_get`: retrieve one indexed asset and its full body.
- `craft_task_open`: pass `task_id` to continue, or `title` and optional `goal/project_id` to create.
- `craft_task_list`: list recent tasks, optionally filtered by status or project.
- `craft_task_checkpoint`: save summary plus completed, pending, decisions, artifact references, and optional status.
- `craft_feedback_record`: use kind `correction`, `preference`, `fact`, `exception`, or `process`; use scope `task`, `project`, or `user`.
- `craft_workflow_save`: save a versioned workflow with name, goal, structured steps, declarative invariants, and permission policy.
- `craft_workflow_search`: find the latest non-deprecated workflow versions.
- `craft_workflow_get`: load the latest or a specified workflow version.
- `craft_workflow_plan`: resolve inputs and preview command, assertion, and coverage-gate steps without execution.
- `craft_workflow_run`: execute one explicitly authorized attempt and return `passed`, `needs_repair`, `failed`, or `no_progress` with deterministic evidence.
- `craft_workflow_run_get`: load a run plus all immutable attempt receipts.
- `craft_workflow_start`: start a mixed program/model/human workflow and advance until external work or approval is needed.
- `craft_workflow_continue`: resume a mixed workflow with explicit side-effect grants.
- `craft_workflow_submit`: submit the pending agent, judge, or human result and follow its transition.
- `craft_workflow_session_get`: read pending work and provenance-bearing event history.
- `craft_workflow_checkpoint_list`: list trusted program-verified and human-approved recovery points.
- `craft_workflow_restore`: branch a new session from a trusted checkpoint without rewriting the original history.

Craft labels records as `agent_reported`, `user_explicit`, or another caller-provided source. These labels describe provenance, not independent verification.
