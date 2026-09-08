# Craft architecture

[简体中文](architecture.zh-CN.md) | [English](architecture.en.md)

Craft is a model-neutral Agent harness. Codex, Claude Code, DeepSeek Harness, a CLI, a future desktop app, or custom software can act as its host or client.

The TypeScript application service manages capabilities, durable tasks and checkpoints, artifacts and evidence, versioned workflows and receipts, evaluation suites, Agent profiles, and dependency-aware orchestration plans. State lives under `~/.craft_data` in SQLite; project directories are read or modified only by explicitly approved Workflow steps.

Capability discovery stores both requested and resolved source paths, follows linked directories with cycle protection, skips unchanged files using metadata, and hashes changed content. Local lexical retrieval uses SQLite FTS instead of deserializing every Skill body for each query. Search returns at most 20 summary cards without bodies; full instructions are loaded only after selection.

Workflow steps declare `read_only`, `local_write`, `external_write`, or `destructive` effects. Unapproved effects do not run. Deterministic command, file, JSON, and coverage checks are computed by code rather than accepted from model self-reporting.

Orchestration plans are DAGs. Dispatch leases only ready nodes within host capacity. Failed routes can advance to another Agent Profile, terminal failures block descendants, and submissions require a valid lease plus provenance. Craft never bypasses host sandbox or approval rules.

Version 0.6.0 pins every candidate Agent Profile version when a Plan is created. Evaluation-bound Orchestration Trials automatically trace dispatches, fallback attempts, submissions, costs, artifacts, and evidence, then create a terminal receipt and Outcome. Ordinary Plans remain available for transient coordination that should not enter evaluation history.

The current release implements the MCP provider path, local catalog, durable task/evidence primitives, deterministic Workflow execution, the first Experience/Eval kernel, and basic multi-Agent routing. A standalone model loop, Agent IR compiler, Capability Kit registry, vector providers, remote hubs, desktop UI, automatic graders, lease heartbeats, budgets, and compensation transactions remain future work.

## Learning from execution experience

Future learning is modeled as `Task → Trial → Trace → Outcome`, not as an ever-growing conversation summary. Harness configurations are divided into six diagnosable control surfaces: context assembly, tools and retrieval, generation budget, orchestration, memory, and output validation. Every change should retain the configuration version and delta, cost, evidence, and failure diagnosis.

Experience has two layers: complete case-level executions and reusable patterns distilled across cases. An Experience Pattern references at least two completed Trials and Evidence records, retaining successful strategies, failure modes, applicability, and Outcome-derived summaries without duplicating Trace or creating a second evaluation state. A Skill Proposal is versioned and uses the existing held-out Evaluation/Signoff Gate before it becomes verified.

Craft normally indexes capability Sources without modifying them. A verified Proposal may write an existing `SKILL.md` inside a selected Source only with `allow_external_write=true`. The Publisher verifies a caller-provided SHA-256 digest, backs up the prior file, verifies it again before atomic replacement, and records publication and rollback receipts. Rollback requires the current digest to still equal the published content, so concurrent user edits are never overwritten.

Version 0.7.0 includes Experience Patterns, Skill Proposals, and the controlled Publisher alongside immutable same-benchmark comparisons and automatic Orchestration Trial capture. Repeated sampling and confidence estimates, lease heartbeats, automatic host drivers, automatic model and operational grading, automated search, Agent IR compilation, Capability Kit registries, and case-adaptive assembly remain future work. Codex and Claude plugin distributions use a dependency-free single-file MCP bundle.
