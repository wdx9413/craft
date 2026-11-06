# Workflow runtime

A Workflow contains a name, optional input definitions, and steps. `{{input_name}}` placeholders preserve native values when they occupy the whole field and become strings when embedded in text.

Supported deterministic steps:

- `command`: string-array command, optional `cwd`, `env`, timeout, and expected exit code.
- `assertion` with `file_exists` or `json_value` evaluator.
- `coverage_gate`: reads a coverage-summary JSON document and checks line, branch, function, and statement thresholds.

Every step has a side-effect class. Planning reports whether all steps are executable under the supplied approval set. Runtime paths cannot escape `project_root`; command execution does not use a shell; output is truncated and credential-like values are redacted.

Example:

```json
{
  "name": "TypeScript verification",
  "inputs": [{"name": "package_manager", "default": "pnpm"}],
  "steps": [
    {"id": "test", "type": "command", "command": ["{{package_manager}}", "test"], "side_effect": "local_write"},
    {"id": "coverage", "type": "coverage_gate", "report": "coverage-summary.json", "line_threshold": 100, "branch_threshold": 100}
  ]
}
```
