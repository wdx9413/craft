# Craft architecture and trusted control plane

[简体中文](architecture.zh-CN.md) | [English](architecture.en.md)

## Principle

Craft is an independent agent harness, not a component beneath Codex, Claude, or a model vendor. It does not bind itself to an agent loop. Any agent application or custom program can use Craft through MCP, a plugin, or the CLI. Connected clients may reason and explore while Craft independently preserves the capability catalog, state, permissions, side-effect boundaries, evidence provenance, failure limits, and recovery records.

```text
Goal + Invariants + Permission Policy
                  ↓
             Host Agent
                  ↓
        Artifact / Evidence
                  ↓
 Program verifier / Model judge / Human
                  ↓
 pass / repair / fail fast / restore
```

## Core objects

- `Capability`: Craft's umbrella abstraction for discoverable capability assets. Skill is the implemented type today; plugin and MCP server metadata can be added later.
- `Task`: a user goal that continues across sessions.
- `Checkpoint`: a trusted continuation boundary.
- `Workflow`: versioned goals, steps, invariants, and policies.
- `Session / Run`: one execution and its immutable events.
- `Artifact / Evidence`: references today; planned first-class entities later.
- `Evaluation`: cases, graders, and results for Runs, Capabilities, Workflows, Agents, or combinations. Execution-validation foundations exist today; the full entity does not.

## Skills, MCP, plugins, and Workflows

These are different layers, not interchangeable names. A Skill provides methods and instructions. MCP connects tools, data, and services. A plugin packages and distributes components such as Skills and MCP servers for a platform. A Workflow composes capabilities around a goal. `Capability` is Craft's internal umbrella abstraction for discovery and relationships.

The current catalog scans and indexes `SKILL.md` only. Craft itself can be distributed as a plugin and expose tools through MCP, but v0.1 does not yet discover arbitrary plugins or MCP servers.

## Execution and validation

Program nodes include `command`, `assertion`, and `coverage_gate`. External nodes include host-executed `agent`, rubric-based `judge`, and explicit `human` approval. Declarative invariants compile to the appropriate validation node.

Every node declares `read_only`, `local_write`, `external_write`, or `destructive`. Saved permission policy sets the workflow ceiling; runtime grants authorize a specific invocation. `allow_execution=true` grants local writes only.

Provenance distinguishes `agent_reported`, `model_judged`, `program_verified`, and `human_approved`. Program success and human approval create trusted checkpoints. Restore creates a new session branch and never rewrites failed history.

Transition and attempt limits provide fail-fast behavior. MCP stdout remains reserved for JSON-RPC; concise metadata-only logs go to stderr. Runtime state defaults to SQLite under `~/.craft_data`.

## Evaluation layers

- `Run validation`: program, model, or human checks for one execution; implemented.
- `Capability evaluation`: representative-case comparisons across Skills, Workflows, Agents, and model combinations; planned.
- `System evaluation`: retrieval choice, long-task recovery, cross-client consistency, and safety boundaries; planned beyond current unit tests and indexing benchmark.

Evaluation should inform promotion from `candidate` to `tested` or `reusable`, but one successful run must not imply long-term reliability.

Set `CRAFT_LOG_LEVEL=DEBUG|INFO|WARNING|ERROR` to control log verbosity.

## Next steps

Planned adapters include first-class artifact/evidence lineage, workspace snapshots, idempotent external operations and compensation, parallel candidate evaluation, remote hubs, and optional vector retrieval. None should bind Craft to one model provider.
