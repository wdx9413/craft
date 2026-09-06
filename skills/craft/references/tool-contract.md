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
- `craft_workflow_save`: save a versioned workflow with name, goal, structured steps, inputs, and success criteria.
- `craft_workflow_search`: find the latest non-deprecated workflow versions.
- `craft_workflow_get`: load the latest or a specified workflow version.

Craft labels records as `agent_reported`, `user_explicit`, or another caller-provided source. These labels describe provenance, not independent verification.
