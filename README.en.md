# Craft

[中文](README.md) | [English](README.en.md)

## Product in brief

Craft is a capability-management and verification system for AI Agent work. It helps an Agent retrieve a small relevant capability set, continue long tasks across sessions, verify results with evidence instead of self-reporting, and turn successful paths into evaluable and rollback-safe Workflows.

Its core objects and protocols are not tied to one model or industry. Craft can provide capabilities to Codex, Claude Code, DeepSeek Harness, and other hosts through MCP, plugins, or adapters, while also forming the base of future standalone Agent and Supervisor products. Software engineering, AI video, sales, education, and content workflows share the same task, artifact, evidence, workflow, and evaluation kernel, then extend it with domain Skills, validators, and Kits.

## Principles

- Discover, then load: index user-selected directories and return a small candidate set instead of injecting every Skill into model context.
- Durable long tasks: keep goals, checkpoints, decisions, feedback, artifacts, and evidence across sessions and hosts.
- Explicit verification: program, model, human, and operational results use distinct Graders; a Signoff Policy decides whether an exact version is reusable.
- Workflows evolve from use: version successful paths, replay them, and improve them through evaluations.
- User-owned data: store data under `~/.craft_data` by default. Persist credential environment-variable names, never secret values.

## Implemented

- Multi-directory capability sources, real-path resolution, linked directories, and incremental scans.
- Skill frontmatter parsing, SQLite FTS candidate retrieval, and on-demand reads; search results omit full bodies.
- Durable tasks, checkpoints, feedback, artifacts, and evidence.
- Versioned Workflows with inputs, safe paths, redaction, side-effect approval, deterministic commands, assertions, coverage gates, and receipts.
- Versioned evaluation-suite and Agent-profile primitives.
- Six-dimensional Harness Configurations, immutable Trials and Outcomes, append-only Traces, automatic evidence capture for Workflow runs, and held-out-eval-gated promotion and rollback.
- Automatic Orchestration Trial capture with pinned Agent Profile versions, dispatch and reroute traces, node costs and evidence, and terminal Outcomes.
- Versioned Graders, provenance-preserving Grades, and Signoff Policies; a model judgment cannot masquerade as program proof.
- Same-benchmark comparisons for Workflow, Agent Profile, and Harness Configuration versions, with aggregate quality, cost, duration, and failure-type deltas. Comparability requires the exact suite version, split, subject type, and case set.
- Experience patterns and Skill proposals: derive applicability, successful strategies, failure modes, and Evidence references from multiple Trials and Outcomes. Proposals reuse the existing held-out Eval/Signoff Gate; only a verified version can write an existing `SKILL.md` with explicit approval, digest protection, local backup, and safe rollback.
- MCP plus Codex, Claude Code, DeepSeek Harness, and generic MCP integration surfaces.
- One TypeScript/Node.js runtime on Windows, macOS, and Linux, with no Python dependency.

Vector search is optional rather than required. A future provider interface can combine compatible embedding endpoints with zero-configuration lexical retrieval.

## Install

Node.js 23+ is required. Python is not required.

```bash
npm install -g github:wdx9413/craft
craft init
```

For development:

```bash
git clone https://github.com/wdx9413/craft.git
cd craft
pnpm install --frozen-lockfile
pnpm test
```

`craft init` selects Agent, Supervisor, or Provider mode. Configuration, SQLite data, indexes, logs, and backups live under `~/.craft_data`; set `CRAFT_DATA_DIR` to override it.

## Codex plugin

Add `https://github.com/wdx9413/craft` as a Git marketplace source. Pin a release tag when possible and use `.` as the sparse path because the plugin manifest is at repository root.

Since v0.2.1, the plugin MCP starts from a versioned single-file bundle committed with the plugin. A Codex cache copy therefore needs neither `npm install` nor the source repository's `node_modules`. Reinstall after upgrading from an older version and verify `craft_info` in a new session.

## Claude Code and MCP

Claude metadata is in `.claude-plugin/plugin.json`. Any MCP host can use a global installation:

```json
{
  "mcpServers": {
    "craft": { "command": "craft-mcp", "args": [] }
  }
}
```

Tools use the `craft_` prefix to avoid collisions, including `craft_source_add`, `craft_capability_search`, `craft_task_checkpoint`, `craft_workflow_trial_run`, `craft_evaluation_run_aggregate`, and `craft_evaluation_compare`.

## Verification

```bash
pnpm run typecheck
pnpm test
```

The test command enforces 100% line, function, and branch coverage. Coverage is calculated by the test runtime, never self-reported by a model.

See the [documentation index](docs/README.md) and [architecture](docs/architecture.en.md) for product direction, boundaries, and data models.
