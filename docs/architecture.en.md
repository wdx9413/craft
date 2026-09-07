# Craft architecture

[简体中文](architecture.zh-CN.md) | [English](architecture.en.md)

Craft is a model-neutral Agent harness. Codex, Claude Code, DeepSeek Harness, a CLI, a future desktop app, or custom software can act as its host or client.

The TypeScript application service manages capabilities, durable tasks and checkpoints, artifacts and evidence, versioned workflows and receipts, evaluation suites, Agent profiles, and dependency-aware orchestration plans. State lives under `~/.craft_data` in SQLite; project directories are read or modified only by explicitly approved Workflow steps.

Capability discovery stores both requested and resolved source paths, follows linked directories with cycle protection, skips unchanged files using metadata, and hashes changed content. Local lexical retrieval uses SQLite FTS instead of deserializing every Skill body for each query. Search returns at most 20 summary cards without bodies; full instructions are loaded only after selection.

Workflow steps declare `read_only`, `local_write`, `external_write`, or `destructive` effects. Unapproved effects do not run. Deterministic command, file, JSON, and coverage checks are computed by code rather than accepted from model self-reporting.

Orchestration plans are DAGs. Dispatch leases only ready nodes within host capacity. Failed routes can advance to another Agent Profile, terminal failures block descendants, and submissions require a valid lease plus provenance. Craft never bypasses host sandbox or approval rules.

The current release implements the MCP provider path, local catalog, durable task/evidence primitives, deterministic Workflow execution, the first Experience/Eval kernel, and basic multi-Agent routing. A standalone model loop, Agent IR compiler, Capability Kit registry, vector providers, remote hubs, desktop UI, automatic graders, lease heartbeats, budgets, and compensation transactions remain future work.

## Learning from execution experience

Future learning is modeled as `Task → Trial → Trace → Outcome`, not as an ever-growing conversation summary. Harness configurations are divided into six diagnosable control surfaces: context assembly, tools and retrieval, generation budget, orchestration, memory, and output validation. Every change should retain the configuration version and delta, cost, evidence, and failure diagnosis.

Experience has two layers: complete case-level executions and reusable patterns distilled across cases. Workflow or harness candidates must pass a held-out evaluation suite before promotion and retain applicability conditions plus rollback history. Correctness ranks before token, latency, and monetary cost. Model judgments may support diagnosis but cannot replace deterministic evidence or explicit human approval.

Version 0.5.0 adds immutable same-benchmark comparisons across Workflow, Agent Profile, or Harness Configuration versions. It aggregates pass rate, numeric scores, costs, duration, verdicts, and failure types only when the exact suite version, split, subject type, and case set match. These are descriptive deltas, not statistical-significance claims. Repeated sampling and confidence estimates, automatic model and operational grading, automated search, a dual-layer experience bank, Agent IR compilation, Capability Kit registries, and case-adaptive assembly remain future work. Codex and Claude plugin distributions use a dependency-free single-file MCP bundle.
