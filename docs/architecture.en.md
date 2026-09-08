# Craft architecture

[简体中文](architecture.zh-CN.md) | [English](architecture.en.md)

Craft is a model-neutral Agent harness. Codex, Claude Code, DeepSeek Harness, a CLI, a future desktop app, or custom software can act as its host or client.

The TypeScript application service manages capabilities, durable tasks and checkpoints, artifacts and evidence, versioned workflows and receipts, evaluation suites, Agent profiles, and dependency-aware orchestration plans. State lives under `~/.craft_data` in SQLite; project directories are read or modified only by explicitly approved Workflow steps.

Capability discovery stores both requested and resolved source paths, follows linked directories with cycle protection, skips unchanged files using metadata, and hashes changed content. Local lexical retrieval uses SQLite FTS instead of deserializing every Skill body for each query. Search returns at most 20 summary cards without bodies; full instructions are loaded only after selection.

Workflow steps declare `read_only`, `local_write`, `external_write`, or `destructive` effects. Unapproved effects do not run. Deterministic command, file, JSON, and coverage checks are computed by code rather than accepted from model self-reporting.

Orchestration plans are DAGs. Dispatch leases only ready nodes within host capacity. Failed routes can advance to another Agent Profile, terminal failures block descendants, and submissions require a valid lease plus provenance. Craft never bypasses host sandbox or approval rules.

Version 0.6.0 pins every candidate Agent Profile version when a Plan is created. Evaluation-bound Orchestration Trials automatically trace dispatches, fallback attempts, submissions, costs, artifacts, and evidence, then create a terminal receipt and Outcome. Ordinary Plans remain available for transient coordination that should not enter evaluation history.

Version 0.9.0 makes default routing the Craft Skill policy for substantial work rather than a repeated user prompt. `craft_default_route` selects an exact verified Workflow when one matches. Otherwise it creates a resumable safe host plan: each sequential stage is recorded through `craft_default_route_update` with real Artifact/Evidence references, and the final review creates an Outcome. `craft_default_route_resume` returns only the next safe action for a durable Task. Version 0.9.1 adds `craft_default_route_find`: a natural-language continuation resumes only one uniquely matching active Task; ties, completed Tasks, and misses are never guessed. Version 0.9.2 lets `craft_route_workflow_proposal_create` save Host-distilled, project-neutral steps from at least two passed evidence-backed routes with one strategy, but only as a provenance-linked `draft` Workflow. Version 0.9.3 adds versioned Project Policies, structured Route Receipts, and Host Adapter dispatch: a required policy enforces observed receipts server-side, while an adapter can claim only its declared next safe action. The existing held-out Evaluation/Signoff Gate remains the only promotion path.

The current release implements the MCP provider path, local catalog, optional embedding retrieval, durable task/evidence primitives, deterministic Workflow execution, resumable default routing, the first Experience/Eval kernel, and basic multi-Agent routing. A standalone model loop, Agent IR compiler, Capability Kit registry, remote hubs, desktop UI, automatic graders, budget prediction, and compensation transactions remain future work.

## Learning from execution experience

Future learning is modeled as `Task → Trial → Trace → Outcome`, not as an ever-growing conversation summary. Harness configurations are divided into six diagnosable control surfaces: context assembly, tools and retrieval, generation budget, orchestration, memory, and output validation. Every change should retain the configuration version and delta, cost, evidence, and failure diagnosis.

Experience has two layers: complete case-level executions and reusable patterns distilled across cases. An Experience Pattern references at least two completed Trials and Evidence records, retaining successful strategies, failure modes, applicability, and Outcome-derived summaries without duplicating Trace or creating a second evaluation state. A Skill Proposal is versioned and uses the existing held-out Evaluation/Signoff Gate before it becomes verified.

Craft normally indexes capability Sources without modifying them. A verified Proposal may write an existing `SKILL.md` inside a selected Source only with `allow_external_write=true`. The Publisher verifies a caller-provided SHA-256 digest, backs up the prior file, verifies it again before atomic replacement, and records publication and rollback receipts. Rollback requires the current digest to still equal the published content, so concurrent user edits are never overwritten.

Version 0.9.3 qualifies repeated-route candidates by pass rate, independent task count, and confirmed/bounded evidence, and reranks lexical capability matches with names, descriptions, and aliases. Version 0.9.4 adds optional OpenAI-compatible embedding retrieval: no configuration means no network request and lexical-only results; successful indexing and querying of sanitized capability metadata are fused with lexical ranks, while timeout, authentication, format, or dimension failures fall back to lexical results. It does not claim statistical significance or automatic host execution. Repeated sampling and confidence estimates, automatic host drivers, automatic model and operational grading, Agent IR compilation, Capability Kit registries, and case-adaptive assembly remain future work. Codex and Claude plugin distributions use a dependency-free single-file MCP bundle.
