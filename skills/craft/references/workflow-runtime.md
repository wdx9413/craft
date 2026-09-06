# Workflow runtime

本文件说明 Craft 的工作流格式和执行语义。简单理解：宿主 Agent 决定“怎么做”，Craft 负责“做到什么算完成、允许产生什么副作用、证据从哪里来，以及失败后从哪里恢复”。下面保留字段英文名，便于直接对照 MCP 参数。

常用节点：

- `command` / `assertion` / `coverage_gate`：由程序确定性执行或验收。
- `agent`：由当前 Codex、Claude 等宿主完成任务。
- `judge`：由模型根据 rubric 和 Evidence 判断。
- `human`：等待用户明确批准或拒绝。
- `invariants`：只声明必须满足的性质，不把 Agent 的实现步骤写死。

运行前先调用 `craft_workflow_plan` 查看计划。遇到 `needs_execution_approval` 时，必须根据 `side_effect` 获取对应授权；`allow_execution=true` 只代表本地写入授权。程序验证或人工批准会形成可信 checkpoint，失败后可通过 `craft_workflow_restore` 从该位置派生新 Session。

Craft executes structured workflow attempts; the host agent performs repairs. A workflow can contain:

- `inputs`: named values with `required` and `default`.
- `preconditions`: structured steps executed before the main steps.
- `steps`: ordered `command`, `assertion`, or `coverage_gate` objects.
- `success_criteria`: structured steps executed after the main steps. Plain strings remain valid for storage but make the workflow non-executable until replaced by structured criteria.
- `repair_policy`: `enabled`, `max_attempts` (1-20), and `no_progress_limit` (1-10).
- `artifacts`: caller-defined output references.
- `invariants`: declarative required properties. `enforcement` is `program`, `model`, or `human`; program invariants include a deterministic `validator`, while model and human invariants compile to judge and approval nodes.
- `permission_policy.allowed_side_effects`: the maximum side-effect classes this workflow may request.

Mixed workflows also support externally performed nodes:

- `agent`: ask the current host agent to complete an objective with its available tools. A missing verdict defaults to `passed`, and the receipt is labeled `agent_reported`.
- `judge`: ask a model to apply a rubric. Its submission requires `verdict: passed|failed|unknown` and is labeled `model_judged`.
- `human`: wait for `approved: true|false` and label the event `human_approved` or `human_rejected`.
- `on_result`: route verdicts to another step ID, `passed`, or `failed`. This enables repair loops without embedding a model provider in Craft.

Use `craft_workflow_start` for a mixed workflow. It advances deterministic nodes until it returns `awaiting_agent`, `awaiting_model_judge`, `awaiting_human`, or `needs_execution_approval`. The current Codex or other host performs the pending work and calls `craft_workflow_submit`. `craft_workflow_session_get` returns the pending request, accumulated context, and provenance-bearing event history. `repair_policy.max_transitions` bounds loops.

Every normalized node has one side-effect class: `read_only`, `local_write`, `external_write`, or `destructive`. Read-only work is always eligible. The compatibility flag `allow_execution=true` grants only `local_write`; higher classes must be named in `approved_side_effects`, and must also be allowed by the saved workflow's permission policy. Model execution remains subject to the host's own approval and sandbox controls.

A passed deterministic node or explicit human approval creates a content-addressed trusted checkpoint. List them with `craft_workflow_checkpoint_list`; `craft_workflow_restore` creates a new session branch from the selected snapshot and records `restored_from_checkpoint`. It never erases the failed session or its evidence. Agent/model success alone does not create a trusted checkpoint.

An invariant can require evidence references before accepting a model submission:

```json
{
  "id": "quality",
  "statement": "The final artifact satisfies the brief",
  "enforcement": "model",
  "evidence_required": ["artifact", "review_report"]
}
```

Plan before execution. `craft_workflow_plan` resolves `{{input}}` placeholders and never runs commands. `craft_workflow_run` requires `allow_execution=true`, runs one attempt, and persists its receipt. If it returns `needs_repair`, the host agent may make an authorized repair and call the tool again with the same `run_id` and resolved inputs.

Terminal states are `passed`, `failed`, and `no_progress`. A successful candidate version is promoted to `tested`, never directly to `reusable`.

## Python incremental coverage example

```json
{
  "name": "Python diff coverage",
  "goal": "Run tests and require complete coverage of changed executable Python code",
  "inputs": [
    {"name": "python", "required": true},
    {"name": "baseline", "default": "origin/main"}
  ],
  "steps": [
    {
      "id": "tests",
      "type": "command",
      "command": ["{{python}}", "-m", "coverage", "run", "-m", "unittest", "discover", "-s", "tests"],
      "timeout_seconds": 900
    },
    {
      "id": "coverage_json",
      "type": "command",
      "command": ["{{python}}", "-m", "coverage", "json", "-o", "coverage.json"]
    }
  ],
  "success_criteria": [
    {
      "id": "diff_coverage",
      "type": "coverage_gate",
      "report": "coverage.json",
      "baseline": "{{baseline}}",
      "line_threshold": 100,
      "branch_threshold": 100
    }
  ],
  "repair_policy": {
    "enabled": true,
    "max_attempts": 5,
    "no_progress_limit": 2
  },
  "artifacts": [
    {"path": "coverage.json", "kind": "coverage_report"}
  ]
}
```

The gate parses the coverage report and Git diff in code. Changed executable Python files omitted from the report are counted as uncovered. A result with no changed executable statements is marked `applicable: false` rather than relying on model judgment.

## Model-driven coverage example

This version needs no Craft-specific coverage adapter. The current host agent chooses and runs the project's existing tools. Its conclusion remains explicitly model-reported.

```json
{
  "name": "Agent-driven coverage improvement",
  "goal": "Inspect and improve incremental test coverage",
  "steps": [
    {
      "id": "inspect",
      "type": "agent",
      "objective": "Identify the test framework, run the appropriate coverage command, and report current incremental line and branch coverage with evidence.",
      "tools": ["shell", "filesystem"],
      "output_schema": {
        "line_coverage": "number",
        "branch_coverage": "number",
        "uncovered": "array",
        "evidence": "array"
      }
    },
    {
      "id": "judge",
      "type": "judge",
      "objective": "Decide whether the submitted evidence demonstrates 100% incremental line and branch coverage.",
      "rubric": ["Tests pass", "Line coverage is 100%", "Branch coverage is 100%", "Evidence identifies the executed command or report"],
      "on_result": {"failed": "repair", "unknown": "inspect", "passed": "passed"}
    },
    {
      "id": "repair",
      "type": "agent",
      "objective": "Use the judge critique and uncovered locations to add meaningful tests, then report the changes.",
      "next": "inspect"
    }
  ],
  "repair_policy": {"max_transitions": 12}
}
```

The model may run coverage tools without a dedicated Craft evaluator, but it cannot know live coverage without reading existing evidence or invoking a tool. Use a deterministic `coverage_gate` when exact enforcement matters; use the agent-driven form for portability and exploration; combine both for a hybrid workflow.

Command execution uses argument arrays without a shell, restricts `cwd` and artifact paths to the supplied project root, limits output size, and redacts common credential patterns before receipts are stored. Do not place secrets directly in workflow definitions or inputs.

## Reliable program execution

Before a deterministic mixed-Workflow node runs, Craft atomically creates a
`workflow_execution` lease and marks the Session `executing`. Concurrent hosts
cannot claim the same transition. Commands receive a stable
`CRAFT_IDEMPOTENCY_KEY`; downstream writes should use it when supported.

If the host exits after the command starts but before its receipt commits, an
expired lease is changed to `result_unknown` by
`craft_workflow_execution_reclaim`. Craft does not guess whether the external
effect happened. `craft_workflow_execution_reconcile` can record observed
success or failure, or approve a retry. Retrying `local_write`,
`external_write`, or `destructive` work requires `approved_retry=true`.
