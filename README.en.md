# Craft

[中文](README.md) | [English](README.en.md)

Craft is a general-purpose Agent harness. It discovers and manages reusable capabilities, preserves long-running task state and evidence, and turns verified execution paths into reusable Workflows. The current release provides capabilities to Codex, Claude Code, DeepSeek Harness, and generic MCP hosts; standalone Agent and Supervisor runtimes remain planned modes.

Craft is not tied to one model or industry. Software engineering, AI video production, sales, education, and content workflows share the same primitives: capabilities, tasks, evidence, artifacts, workflows, and evaluations.

## Principles

- Discover, then load: index user-selected directories and return a small candidate set instead of injecting every Skill into model context.
- Durable long tasks: keep goals, checkpoints, decisions, feedback, artifacts, and evidence across sessions and hosts.
- Explicit verification: deterministic gates are executed by programs; subjective quality can be judged by a model or human with provenance.
- Workflows evolve from use: version successful paths, replay them, and improve them through evaluations.
- User-owned data: store data under `~/.craft_data` by default. Persist credential environment-variable names, never secret values.

## Implemented

- Multi-directory capability sources, real-path resolution, linked directories, and incremental scans.
- Skill frontmatter parsing, SQLite FTS candidate retrieval, and on-demand reads; search results omit full bodies.
- Durable tasks, checkpoints, feedback, artifacts, and evidence.
- Versioned Workflows with inputs, safe paths, redaction, side-effect approval, deterministic commands, assertions, coverage gates, and receipts.
- Versioned evaluation-suite and Agent-profile primitives.
- MCP plus Codex, Claude Code, DeepSeek Harness, and generic MCP integration surfaces.
- One TypeScript/Node.js runtime on Windows, macOS, and Linux, with no Python dependency.

Vector search is optional rather than required. A future provider interface can combine compatible embedding endpoints with zero-configuration lexical retrieval.

## Install

Node.js 24+ is required. Python is not required.

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

## Claude Code and MCP

Claude metadata is in `.claude-plugin/plugin.json`. Any MCP host can use a global installation:

```json
{
  "mcpServers": {
    "craft": { "command": "craft-mcp", "args": [] }
  }
}
```

Tools use the `craft_` prefix to avoid collisions, including `craft_source_add`, `craft_capability_search`, `craft_task_checkpoint`, `craft_workflow_run`, and `craft_evidence_record`.

## Verification

```bash
pnpm run typecheck
pnpm test
```

The test command enforces 100% line, function, and branch coverage. Coverage is calculated by the test runtime, never self-reported by a model.

See [architecture](docs/architecture.en.md) for boundaries and data models.
