# Craft architecture and trusted control plane

[简体中文](architecture.zh-CN.md) | [English](architecture.en.md)

## Principle

Craft keeps the agent loop thin and the control plane thick. Codex, Claude, DeepSeek, and other hosts own reasoning and exploration. Craft preserves stable state, permissions, side-effect boundaries, evidence provenance, failure limits, and recovery records across hosts.

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

- `Capability`: an indexed Skill or future capability asset.
- `Task`: a user goal that continues across sessions.
- `Checkpoint`: a trusted continuation boundary.
- `Workflow`: versioned goals, steps, invariants, and policies.
- `Session / Run`: one execution and its immutable events.
- `Artifact / Evidence`: references today; planned first-class entities later.

## Execution and validation

Program nodes include `command`, `assertion`, and `coverage_gate`. External nodes include host-executed `agent`, rubric-based `judge`, and explicit `human` approval. Declarative invariants compile to the appropriate validation node.

Every node declares `read_only`, `local_write`, `external_write`, or `destructive`. Saved permission policy sets the workflow ceiling; runtime grants authorize a specific invocation. `allow_execution=true` grants local writes only.

Provenance distinguishes `agent_reported`, `model_judged`, `program_verified`, and `human_approved`. Program success and human approval create trusted checkpoints. Restore creates a new session branch and never rewrites failed history.

Transition and attempt limits provide fail-fast behavior. MCP stdout remains reserved for JSON-RPC; concise metadata-only logs go to stderr. Runtime state defaults to SQLite under `~/.craft_data`.

## Next steps

Planned adapters include first-class artifact/evidence lineage, workspace snapshots, idempotent external operations and compensation, parallel candidate evaluation, remote hubs, and optional vector retrieval. None should bind Craft to one model provider.
