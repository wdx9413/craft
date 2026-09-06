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
- `Evaluation`: first-class versioned Case Suites, Eval Runs, and immutable Case Results for capabilities, Skills, Workflows, tools, MCPs, plugins, Agents, models, systems, or combinations.
- `Agent Profile`: a versioned role, host, provider, model, reasoning effort, capability tags, and side-effect ceiling.
- `Orchestration Plan / Node / Lease`: a task dependency graph, ordered route candidates, concurrent claiming, and duplicate-safe execution receipts.

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
- `Capability evaluation`: same-suite comparisons can preserve program, model, or human results across Skills, Workflows, Agents, and model combinations; automatic execution and Grader adapters remain planned.
- `System evaluation`: the same Eval entities can record retrieval choice, long-task recovery, cross-client consistency, and safety-boundary results; systematic Case collections and scheduled regression runs remain planned.

Evaluation should inform promotion from `candidate` to `tested` or `reusable`, but one successful run must not imply long-term reliability.

## Multi-Agent and model routing

Each Plan Node declares a role, objective, dependencies, side effect, and ordered Agent Profile candidates. Dispatch leases only nodes whose dependencies passed, respects `max_concurrency`, and prevents duplicate claims. A failed submission returns the node to pending when another candidate exists; terminal failures propagate `blocked` to downstream nodes.

Leases have an owner and TTL and can be renewed with a heartbeat. An expired lease returns its node to the same Profile route, while the old lease can no longer submit. Plans support pause, resume, and cancel; failed nodes support explicit retry. Every dispatch, heartbeat, expiry, submission, and control action is recorded in a monotonic immutable event stream.

An MCP server cannot directly invoke Codex `spawn_agent` or Claude internal task APIs. A Codex/Claude Skill or another host reads the Lease Request, invokes its native execution surface, and submits provenance-bearing results. Future host adapters can automate that translation without bypassing host sandbox, approval, or concurrency controls.

Set `CRAFT_LOG_LEVEL=DEBUG|INFO|WARNING|ERROR` to control log verbosity.

## Core consistency invariants

- A Capability is identified by its logical relative path inside a Source and stores its current real path. Retargeted Source roots and nested directory links refresh their real location without deleting the same asset; a target already registered by another Source is rejected as a conflict. Scan generations prevent an older concurrent snapshot from overwriting a newer one. Rescans compare nanosecond mtime and file size first, avoiding content reads and hashing for unchanged Skills.
- Path casing follows host filesystem semantics: Windows normalizes case while case-sensitive platforms preserve it.
- A Workflow validates all transition targets, structured fields, and permission declarations before executing any step. Routed workflows use the auditable Session Runtime; linear `workflow_run` never silently ignores `on_result`.
- A `needs_repair` Run is atomically marked running before commands execute, preventing two clients from claiming the same repair attempt.
- Eval run state, Case identity, and duplicate-result checks occur in one write transaction. Weights and scores must be finite, rejecting NaN and Infinity.

## Next steps

Planned work includes Codex/Claude/API host adapters, token/time/cost budgets, orchestration-to-Eval integration, automatic Eval Runners and Graders, first-class artifact/evidence lineage, workspace snapshots, idempotent external operations and compensation, remote hubs, and optional vector retrieval. None should bind Craft to one model provider.
