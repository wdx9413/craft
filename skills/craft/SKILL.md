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

Only call `craft_source_add` for a directory the user has selected. Multiple sources are supported. Craft resolves a source symlink or Windows junction and stores both the requested path and real path. Nested linked directories are followed with cycle detection. Scanning is read-only; Craft writes its index and operational data to `~/.craft_data`, never into the scanned project.

Do not store secrets, credentials, cookies, sensitive raw payloads, or unnecessary business content in summaries or feedback. Prefer artifact references and concise derived state.

For tool fields and source labels, read [tool contract](references/tool-contract.md) only when constructing or debugging a Craft call.
