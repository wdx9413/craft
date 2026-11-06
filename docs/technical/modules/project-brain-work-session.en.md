# Project Brain and Work Session (v0.12.10; v0.12.9 baseline)

> The core objects were introduced in v0.12.9. v0.12.10 adds CLI run, Internal Host binding, and Registry/A2A/long-task integration; see the [v0.12.10 runtime vertical slice](v01210-product-runtime.en.md).

v0.12.9 makes a project the user-facing continuity object. Project Brain projects goals, material references, decisions, tasks, outcomes, and candidate experience. Work Session pins the exact knowledge, capability, Workflow, model, Host, and acceptance context for one task.

The projection is digest/reference-only: raw prompts and business bodies are not copied into the control plane. A Session is prepared before a Host starts, bound to one exact Work Launch, and revalidated before continuation. Drift fails closed into `needs_replan`.

The same `craft_project_brain_*` and `craft_work_session_*` operations are available to GUI, CLI, plugins, Experts, and MCP adapters.
