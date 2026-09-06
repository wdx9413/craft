# Workflow runtime

Craft executes structured workflow attempts; the host agent performs repairs. A workflow can contain:

- `inputs`: named values with `required` and `default`.
- `preconditions`: structured steps executed before the main steps.
- `steps`: ordered `command`, `assertion`, or `coverage_gate` objects.
- `success_criteria`: structured steps executed after the main steps. Plain strings remain valid for storage but make the workflow non-executable until replaced by structured criteria.
- `repair_policy`: `enabled`, `max_attempts` (1-20), and `no_progress_limit` (1-10).
- `artifacts`: caller-defined output references.

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

Command execution uses argument arrays without a shell, restricts `cwd` and artifact paths to the supplied project root, limits output size, and redacts common credential patterns before receipts are stored. Do not place secrets directly in workflow definitions or inputs.
