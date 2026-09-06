# Craft

[简体中文](README.md) | [English](README.en.md)

> Help agents find capabilities, choose well, finish work, pass verification, and accumulate what works.

Craft is a capability-management and task runtime for AI agents. It treats Skills, Workflows, tools, and service connections as discoverable, composable, and verifiable capability assets, then manages their full lifecycle around real tasks: discover, register, and index capabilities; retrieve, select, and compose them; coordinate and continue execution; preserve state, artifacts, and evidence; use evaluation and regression checks to assess outcomes and capability versions; and turn validated methods into reusable Workflows.

Version 0.1 implements local Skill discovery and management, task continuity, mixed validation, Workflow execution, trusted recovery, reusable Case Suites, cross-version evaluation comparison, cross-host Agent Profiles, dependency orchestration, recoverable leases, manual controls, and model fallback. Adding plugin and MCP metadata to the capability catalog, automated evaluation execution, and threshold-based promotion remain later stages.

## Why Craft

Long-term agent use still has recurring gaps:

- A library of hundreds or thousands of Skills cannot be placed into every context.
- Progress, decisions, and failure causes are easily lost between sessions.
- An agent saying “done” is not the same as a tested or approved outcome.
- Switching agent platforms often means rebuilding the same setup.
- Repeated work is replanned from scratch instead of evolving into a tested workflow.

Craft manages a capability lifecycle:

```text
discover → manage → match/select → compose/execute → preserve state/evidence → evaluate → reuse
```

## Core ideas

### A control plane decoupled from agents

Craft does not bind itself to one model, agent loop, or interface. A connected client may reason, plan, and execute, while Craft independently manages capability discovery, state, permissions, evidence, checkpoints, and audit history. The client may be Codex, Claude, another agent application, or custom software.

### Retrieve before loading

Craft incrementally indexes only user-selected Skill sources. It retrieves a small candidate set for each task and loads the selected Skill rather than sending the full library to a model.

### Evidence over self-reported success

Program verification, model judgment, and human approval are all useful, but their provenance stays distinct. A model conclusion never silently becomes deterministic proof.

### Long tasks advance through durable state, not unlimited context

Long tasks drift when sessions end, context is compacted, or repeated repairs preserve bad assumptions. Craft stores goals, progress, decisions, evidence, artifact references, and pending work outside the conversation. Bounded loops stop repeated failure, and a new Session can branch from the latest trusted checkpoint. Work can continue across sessions or clients without replaying the entire history into context.

### Workflows grow from real work

Craft does not require a vendor to prebuild every industry template. Successful task histories can be abstracted into workflow candidates and promoted through repeated validation.

### Evaluation belongs throughout the lifecycle

Evaluation is more than a final score. A run verifies its outcome; representative cases test whether a Skill or Workflow is stable before reuse; upgrades need regression comparisons; and Craft itself should measure retrieval quality, recovery continuity, and consistency across clients. These are traceable quality gates, not a promise that agents never fail.

## Target scenarios

| Domain | Preserved assets | Completion evidence |
|---|---|---|
| Agent engineering | code, cases, traces, test reports | tests, coverage, compatibility, review |
| AI video | scripts, shots, references, generations | specifications, consistency, human selection |
| Sales | customer facts, stages, constraints | field checks, compliance, send approval |
| Education | learning goals, exercises, feedback | answer checks, outcomes, teacher approval |
| Content | sources, drafts, editorial rules | fact checks, structure review, publish approval |

These domains can share one control loop while supplying their own Skills, tools, and validators. They are adaptation targets, not claims that v0.1 ships complete domain connectors or templates. Real engineering work is the first validation environment.

## Available today

- Multiple Skill sources with real-path resolution and incremental indexing.
- Candidate retrieval and on-demand loading for large capability libraries.
- Cross-session tasks, checkpoints, feedback, and versioned workflows.
- Mixed program, model-judge, and human-approval execution.
- Separate `read_only`, `local_write`, `external_write`, and `destructive` gates.
- Trusted checkpoint recovery without rewriting failed history.
- Versioned evaluation Case Suites, immutable Case results, aggregate metrics, and same-suite comparisons.
- Cross-platform Agent Profiles, dependency DAGs, concurrent dispatch, lease TTL/heartbeat/crash recovery, ordered fallback, and immutable orchestration events.
- Codex, Claude Code, MCP, and Python CLI integration.

## Evaluation boundary today

Craft provides deterministic run verification, mixed Agent/Model/Human checks, provenance levels, versioned Workflows, and immutable run records. It can also save versioned Case Suites, create Eval Runs for capabilities, Skills, Workflows, tools, MCPs, plugins, Agents, models, systems, or combinations, record per-Case verdicts, scores, metrics, evidence, and provenance, then deterministically aggregate completion rate, pass rate, weighted score, and version deltas.

The host Agent, a program, or a human still executes each Case and submits its result. Automatic runners, Grader adapters, Dataset import, statistical confidence, repeated-run regression detection, promotion recommendations, and dedicated cross-client or long-task recovery evaluations are still planned. Craft now has a minimal reusable evaluation loop, but it is not yet a complete Agent evaluation platform.

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
craft_eval_suite_list/save → craft_eval_run_start → craft_eval_result_submit → craft_eval_compare
craft_agent_profile_save → craft_orchestration_plan_create → dispatch → host execution / heartbeat → submit
```

`allow_execution=true` grants local writes only. External writes and destructive actions require an explicit `approved_side_effects` grant.

## Documentation

- [Architecture and trusted control plane](docs/architecture.en.md)
- [Workflow schema, states, and examples](skills/craft/references/workflow-runtime.md)
- [Evaluation cases, results, and comparison semantics](skills/craft/references/evaluation-runtime.md)
- [Multi-Agent routing, dispatch, and lease semantics](skills/craft/references/multi-agent-runtime.md)
- [MCP tool contract](skills/craft/references/tool-contract.md)

## Current boundary

Craft v0.1 is a local technical preview covering capability retrieval, long-task continuity, verification, recovery, human-driven version evaluation, and host-mediated multi-Agent orchestration with lease recovery and audit events; it is not an unattended background execution platform. Remote Skill Hub synchronization, vector retrieval, a graphical interface, workspace snapshots, scheduled/background execution, and automatic host-process startup are not implemented yet. SQLite retrieval is the default; embedding providers will remain optional.
