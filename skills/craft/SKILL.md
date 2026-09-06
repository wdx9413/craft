---
name: craft
description: Continue saved work, search a user-configured capability library, record explicit corrections, or turn completed work into reusable workflow candidates with Craft. Use for long or recurring tasks where task continuity or method reuse is useful.
---

# Craft

Craft stores local task state and reusable work assets under `~/.craft_data`. Use its MCP tools at meaningful task boundaries; ordinary work can continue if Craft is unavailable.

## Use Craft

- For an existing Craft task ID, call `craft_task_open` and verify saved assumptions against the current files or external state before continuing. If the user does not know the ID, use `craft_task_list` to offer a small recent set.
- For a new long or recurring task, call `craft_task_open` with a concise title and goal. Keep the returned task ID.
- When a reusable method would help, search saved workflows with `craft_workflow_search` and load the selected version with `craft_workflow_get`. Search the capability library with `craft_capability_search` when the task needs an additional Skill; it refreshes sources older than five minutes by default, then matches in code against the local index. Call `craft_capability_get` only for the chosen item.
- Save a `craft_task_checkpoint` after material progress, before a likely handoff, or when the user asks to preserve state. Record what is complete, pending, decided, and where artifacts live. Do not claim unobserved work as verified.
- Call `craft_feedback_record` for an explicit correction or a clearly stated future preference. Choose the narrowest accurate scope. Do not infer a global preference from one edit.
- After a meaningful successful run, `craft_workflow_save` may store a structured candidate. Keep task-specific values as inputs and cite the source task. A candidate is not automatically tested or reusable.
- Before executing a saved workflow, call `craft_workflow_plan`, expose material commands and writes when approval is required, and only call `craft_workflow_run` with `allow_execution=true` within the user's authorized scope.
- Treat coverage gates, assertions, command exit codes, and runtime receipts as the source of pass/fail truth. Never replace a deterministic result with model judgment.
- When a run returns `needs_repair`, use its failed-step evidence to make a scoped repair, then call `craft_workflow_run` again with the same `run_id`. Stop on `passed`, `failed`, or `no_progress`; do not bypass attempt limits or weaken gates without explicit user direction.
- For workflows containing `agent`, `judge`, or `human` nodes, use `craft_workflow_start`. Perform an `awaiting_agent` request with the current host's tools, evaluate an `awaiting_model_judge` request against its rubric, or ask for the explicit decision required by `awaiting_human`; then submit structured output with `craft_workflow_submit`. Preserve the returned evidence and provenance. Use `on_result` transitions for repair loops and never pretend an agent-reported result was program-verified.
- Deterministic nodes are protected by an execution lease. If a host disappears after starting a command, call `craft_workflow_execution_reclaim`; an expired execution becomes `result_unknown`, not failed. Use `craft_workflow_execution_reconcile` only with observed evidence. Retrying a side-effecting step requires explicit `approved_retry=true`. Pass the stable `CRAFT_IDEMPOTENCY_KEY` through to downstream systems when they support idempotency.
- Prefer declarative `invariants` for required outcomes and keep implementation freedom in `agent` nodes. Respect each node's side-effect class. `allow_execution=true` grants only local writes; use `approved_side_effects` only for classes the user has actually authorized. Never infer permission for external writes or destructive work.
- On failure, inspect trusted points with `craft_workflow_checkpoint_list`. Use `craft_workflow_restore` to branch from a verified checkpoint when recovery is safer than continuing contaminated context. A checkpoint marks a trusted boundary, not proof that every earlier model statement is true.
- When comparing a capability, Skill, Workflow, tool, MCP, plugin, Agent, model, system, or combination, reuse an existing Case Suite or save one with `craft_eval_suite_save`. Start one Eval Run per subject, submit each observed result with its real provenance, and use `craft_eval_compare` only for runs against the same suite version. Do not invent scores for blocked or unexecuted cases.
- For multi-Agent work, select or save versioned Agent Profiles, then create a dependency-aware orchestration plan. Dispatch only the capacity the current host can execute, invoke the requested native subagent/model without silently substituting another profile, and submit the real result and provenance. Heartbeat long-running leases before expiry. Reclaim expired work after a host interruption; an expiry retries the same route, while a submitted failure may intentionally advance to the next profile. Use pause, resume, cancel, or explicit node retry instead of editing stored state; do not bypass the plan's side-effect ceiling or host approvals.
- Use `craft_host_adapter_probe` to distinguish a declared integration from an executable currently available on the machine. A missing host executable does not make its saved Agent Profiles invalid; it means another host must execute those leases.
- Use `craft_usage_mode_list/get` when a client needs to decide whether Craft is acting as a standalone Agent foundation, a supervisor over other runtimes, or a capability provider. Respect each mode's reported maturity; do not claim the planned desktop or interactive standalone loop exists.
- Register meaningful outputs with `craft_artifact_register` and claims that justify decisions with `craft_evidence_record`. Connect tasks, executions, evaluations, artifacts, and evidence using `craft_lineage_link`; use bounded `craft_lineage_trace` queries instead of copying an entire history into model context. Store references and digests, not secrets or large payloads.
- For long or expensive work, create a host-neutral budget and atomically call `craft_budget_reserve` before dispatch. Settle measured usage with `craft_budget_reservation_settle`, release cancelled work, and reclaim expired reservations after host failure. Use `craft_budget_check` only as a preview; it does not reserve capacity. Honor hard stops. Provider-specific token and price conversion belongs in the host adapter.
- Before risky upgrades or recovery work, create `craft_store_backup`. Use `craft_store_doctor` to inspect SQLite, foreign keys, Workflow execution links, and search-index drift. `craft_store_restore` is destructive and requires explicit confirmation; retain its returned recovery-backup path.

Only call `craft_source_add` for a directory the user has selected. Multiple sources are supported. Craft resolves a source symlink or Windows junction and stores both the requested path and real path. Nested linked directories are followed with cycle detection. Scanning is read-only; Craft writes its index and operational data to `~/.craft_data`, never into the scanned project.

Do not store secrets, credentials, cookies, sensitive raw payloads, or unnecessary business content in summaries or feedback. Prefer artifact references and concise derived state.

For tool fields and source labels, read [tool contract](references/tool-contract.md) only when constructing or debugging a Craft call.
For executable workflow fields, deterministic coverage semantics, and repair-loop states, read [workflow runtime](references/workflow-runtime.md).
For reusable Case Suites, result provenance, aggregate metrics, and comparison rules, read [evaluation runtime](references/evaluation-runtime.md).
For Agent Profiles, dependency plans, concurrent leases, and model fallback, read [multi-Agent runtime](references/multi-agent-runtime.md).
