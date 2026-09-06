# Craft

[简体中文](README.md) | [English](README.en.md)

> Help AI find the right capability, continue previous work, prove outcomes, and turn successful methods into reusable workflows.

Craft is a general-purpose work system that helps AI agents discover the right capabilities, continue long-running tasks, verify outcomes, and reuse proven methods. It organizes agent capabilities and work history as user-owned capability assets: today it starts with Skill indexing and preserves task state, evidence, and reusable Workflows. Codex, Claude, and other agent applications can connect through MCP, plugins, or the CLI.

“Capability asset” is Craft's umbrella term, not a synonym for “plugin.” A Skill teaches an agent how to perform a class of tasks; MCP connects tools, data, and services; a plugin packages and distributes components such as Skills and MCP servers; a Workflow composes capabilities for a goal. Craft v0.1 implements Skill indexing and Workflow management. Plugin catalogs and MCP server catalogs remain future extensions.

## Why Craft

Long-term agent use still has recurring gaps:

- A library of hundreds or thousands of Skills cannot be placed into every context.
- Progress, decisions, and failure causes are easily lost between sessions.
- An agent saying “done” is not the same as a tested or approved outcome.
- Switching agent platforms often means rebuilding the same setup.
- Repeated work is replanned from scratch instead of evolving into a tested workflow.

Craft closes the loop:

```text
discover → execute → preserve state and artifacts → verify → recover → reuse
```

## Core ideas

### A control plane decoupled from agents

Craft does not bind itself to one model, agent loop, or interface. A connected client may reason, plan, and execute, while Craft independently manages capability discovery, state, permissions, evidence, checkpoints, and audit history. The client may be Codex, Claude, another agent application, or custom software.

### Retrieve before loading

Craft incrementally indexes only user-selected Skill sources. It retrieves a small candidate set for each task and loads the selected Skill rather than sending the full library to a model.

### Evidence over self-reported success

Program verification, model judgment, and human approval are all useful, but their provenance stays distinct. A model conclusion never silently becomes deterministic proof.

### Workflows grow from real work

Craft does not require a vendor to prebuild every industry template. Successful task histories can be abstracted into workflow candidates and promoted through repeated validation.

## Example domains

| Domain | Preserved assets | Completion evidence |
|---|---|---|
| Agent engineering | code, cases, traces, test reports | tests, coverage, compatibility, review |
| AI video | scripts, shots, references, generations | specifications, consistency, human selection |
| Sales | customer facts, stages, constraints | field checks, compliance, send approval |
| Education | learning goals, exercises, feedback | answer checks, outcomes, teacher approval |
| Content | sources, drafts, editorial rules | fact checks, structure review, publish approval |

All domains share one control loop while supplying their own Skills, tools, and validators.

## Available today

- Multiple Skill sources with real-path resolution and incremental indexing.
- Candidate retrieval and on-demand loading for large capability libraries.
- Cross-session tasks, checkpoints, feedback, and versioned workflows.
- Mixed program, model-judge, and human-approval execution.
- Separate `read_only`, `local_write`, `external_write`, and `destructive` gates.
- Trusted checkpoint recovery without rewriting failed history.
- Codex, Claude Code, MCP, and Python CLI integration.

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
