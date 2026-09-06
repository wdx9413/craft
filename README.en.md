# Craft

[简体中文](README.md) | [English](README.en.md)

Craft is a local-first capability catalog, task-continuity layer, and trusted workflow control plane for AI agents. Codex, Claude, and other hosts can share the same Skill index, task state, validation rules, and recovery history.

## What it does

- Index multiple external Skill directories and refresh them incrementally.
- Retrieve a small candidate set before loading a selected Skill.
- Preserve progress, decisions, feedback, and artifact references across sessions.
- Combine program verification, model judgment, and human approval.
- Gate local writes, external writes, and destructive actions separately.
- Resume from trusted checkpoints without rewriting failed history.

Runtime data is stored under `~/.craft_data`, never in the active business project.

## Requirements

- Python 3.11+
- Windows, macOS, or Linux
- [`uv`](https://docs.astral.sh/uv/getting-started/installation/) for Marketplace-launched MCP

## Install from source

Windows:

```powershell
py -3 scripts/install_plugin.py
```

macOS / Linux:

```bash
python3 scripts/install_plugin.py
```

The default target is `~/plugins/craft`. To use only the CLI:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/craft info
.venv/bin/craft add-source /path/to/skills
.venv/bin/craft search "diagnose service failure"
```

## Codex

After `craft-agent-harness==0.1.0` is published to PyPI, add `https://github.com/wdx9413/craft` as a Marketplace source in `/plugins`. Leave the sparse path empty, use `main` for prerelease testing, or select a release tag for reproducible installs. Until the first PyPI release is available, use the source installer above.

## Claude Code

```bash
claude --plugin-dir ~/plugins/craft
```

Inspect `/mcp`, invoke `/craft:craft`, or let Claude select the Skill from task context.

## Typical flow

```text
craft_source_add → craft_capability_search → craft_capability_get
craft_task_open → craft_task_checkpoint → resume by task_id
craft_workflow_plan → craft_workflow_start → craft_workflow_submit
```

`allow_execution=true` grants local writes only. External writes and destructive actions require an explicit `approved_side_effects` grant.

## Logging

Craft writes concise INFO events to stderr and reserves stdout for MCP JSON-RPC. It does not implicitly log prompts, credentials, or full business content. Set `CRAFT_LOG_LEVEL=WARNING` to reduce output.

## Documentation

- [Architecture and trusted control plane](docs/architecture.en.md)
- [Workflow schema, states, and examples](skills/craft/references/workflow-runtime.md)
- [MCP tool contract](skills/craft/references/tool-contract.md)

## Test

```bash
.venv/bin/python -m coverage run --branch -m unittest discover -s tests
.venv/bin/python -m coverage report
```

The repository enforces 100% statement and branch coverage.

## Current boundary

Craft v0.1 is a local technical preview. Remote Skill Hub synchronization, vector retrieval, a graphical interface, workspace snapshots, and parallel-agent scheduling are not implemented yet. SQLite retrieval is the default; embedding providers will remain optional.
