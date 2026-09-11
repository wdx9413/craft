# Craft

> Current release: v0.11.46. The latest bounded control loop joins terminal Host receipts, independent acceptance, recoverable delivery actions, sanitized comparison batches, and optional platform preflight.

[中文](README.md) | [English](README.en.md)

## Product in brief

Craft aims to be a shared digital workbench for people and AI: understand goals, organize capabilities, execute tasks, maintain results, and learn from verified work.

The product is intended for workers across video, sales, education, content creation, software engineering, and other fields. Domain extensions provide appropriate objects, views, tools, and acceptance criteria; users should not need programming knowledge to use the future workbench.

The roadmap has two steps. Short term, Craft is a cross-host governance plugin layer: it plugs into hosts such as Codex CLI, Claude Code, and DeepSeek Harness through MCP/plugins and provides unified capability discovery, authorization gates, evidence chains, and evaluation gates, while execution stays inside the host. Long term, Craft aims to become an autonomous agent platform that carries its own conversation loop, schedules hosts, and improves through gated evaluation. Both steps share one kernel.

The current version keeps local directories as multiple Source Mounts while indexing identical content as one logical capability. Activation Plans and Resolution pin, recheck, and bound read-only capability content. Capability-bound Dispatches can provide that exact context to Codex CLI or Claude Code, then recheck it just before execution and fail closed on drift; this never executes a local Skill or grants extra tool or write permissions. A verification-driven iteration controller classifies independent acceptance as pass, bounded retry, environment/configuration block, or human handoff without granting extra write authority.

| Product pillar | Target capabilities |
| --- | --- |
| Work and collaboration | Goals, shared workspace, editable results, capabilities and context |
| Execution and assurance | Planning, tools, sandboxing and permissions, recovery, verification and observation |
| Learning and improvement | **Evaluation and experiments**, knowledge and memory, adaptation, compilation and reuse |

See the [product architecture (Chinese)](docs/product/architecture.zh-CN.md) and [roadmap (Chinese)](docs/product/roadmap.zh-CN.md) for scope and implementation status.

## Principles

- Discover, then load: index user-selected directories and return a small candidate set instead of injecting every Skill into model context.
- Durable long tasks: keep goals, checkpoints, decisions, feedback, artifacts, and evidence across sessions and hosts.
- Explicit verification: program, model, human, and operational results use distinct Graders; a Signoff Policy decides whether an exact version is reusable.
- Workflows evolve from use: version successful paths, replay them, and improve them through evaluations.
- User-owned data: store data under `~/.craft_data` by default. Persist credential environment-variable names, never secret values.
- Editable and controllable work: the target experience includes partial edits, version comparison, and execution controls. Guarantees depend on the execution backend; file restoration and external compensation are distinct operations.

## Implemented

- Multi-directory capability sources, real-path resolution, linked directories, and incremental scans.
- Skill frontmatter parsing, SQLite lexical candidate retrieval with a keyword-ranking fallback when FTS5 is unavailable, and on-demand reads; search results omit full bodies.
- Durable tasks, checkpoints, feedback, artifacts, and evidence.
- Default routing for substantial work: verified Workflows execute only at their exact selected version; unmatched goals become resumable, evidence-backed safe host plans.
- Versioned Workflows with inputs, safe paths, redaction, side-effect approval, deterministic commands, assertions, coverage gates, and receipts.
- Versioned evaluation-suite and Agent-profile primitives.
- Six-dimensional Harness Configurations, immutable Trials and Outcomes, append-only Traces, automatic evidence capture for Workflow runs, and held-out-eval-gated promotion and rollback.
- Automatic Orchestration Trial capture with pinned Agent Profile versions, dispatch and reroute traces, node costs and evidence, and terminal Outcomes.
- Versioned Graders, provenance-preserving Grades, and Signoff Policies; a model judgment cannot masquerade as program proof.
- Same-benchmark comparisons for Workflow, Agent Profile, and Harness Configuration versions, with aggregate quality, cost, duration, and failure-type deltas. Comparability requires the exact suite version, split, subject type, and case set.
- Experience patterns and Skill proposals: derive applicability, successful strategies, failure modes, and Evidence references from multiple Trials and Outcomes. Proposals reuse the existing held-out Eval/Signoff Gate; only a verified version can write an existing `SKILL.md` with explicit approval, digest protection, local backup, and safe rollback.
- MCP plus Codex, Claude Code, DeepSeek Harness, and generic MCP integration surfaces.
- A persistent recovery queue that projects due waits, ambiguous effects and failed Sagas into bounded priority work; compatible workers use expiring leases and evidence-backed stale-state checks.
- Signed webhook subscriptions with HMAC verification, replay defense, deterministic filtering, throttling, allowlisted scalar projection, and optional resource-budget reservation; raw request bodies are not persisted and projected data has no execution authority.
- Controlled speculative preparation for indexing, summaries, drafts, and metadata prefetch: candidates pin input fingerprints, policy versions, budgets, and TTLs; workers use short leases and ready results require Artifact and Evidence references. Trial, Trace, actual cost, and Outcome are captured automatically; human edits become preference signals but cannot masquerade as program proof, promote a policy by themselves, or authorize external writes.
- Object-level provenance: immutable exact-version links connect sources, outputs, Workflow/Capability transforms, and Evidence. Optional locators support paragraphs, cells, shots, or domain objects; bounded upstream/downstream traversal, cycle rejection, and newer-version warnings avoid copying business content into the graph.
- Capability canaries use sticky baseline/candidate routing and evidence-backed quality, cost, latency, and human-correction samples. Regressions stop new candidate traffic and recommend rollback; promotion and rollback are never silently executed.
- Capability federation packages healthy verified assets without raw trajectories, supports human redaction and independent publication, pins consumers to exact release/asset versions, and fails closed after revocation. Remote hubs and enterprise identity remain adapter work.
- Hub Sync verifies paginated metadata catalogs against pinned Ed25519 keys, advances a hash-linked monotonic cursor atomically, propagates withdrawals, and searches only the local catalog instead of scanning every remote Skill. Network fetching and content materialization remain adapter work.
- On-demand materialization verifies a bounded package against the signed catalog digest, writes only safe relative files into `~/.craft_data/cache`, blocks critical findings, gates high-risk findings on security review, and registers only a non-executable candidate asset.
- Candidate certification binds an exact materialized asset to held-out evaluation, per-Trial Sandbox receipts, evidence-backed program Grades, and Signoff. Independent promotion atomically marks an unchanged asset verified but still grants no execution authority.
- Continuous supply-chain governance propagates source disablement, catalog withdrawal, digest drift, and high-risk advisories into blocked assets, invalid Activation Profiles, and recoverable recertification work.
- A single-instance local maintenance worker reclaims expired leases, expires speculative candidates, reconciles Hub supply-chain state, and refreshes recovery work without silently executing user tasks.
- Long-task dehydration and hydration: freeze minimal references to Task, Workspace revision, Wait, Runtime fingerprints, budgets, and recovery work without raw conversation context or credentials. Revalidation distinguishes still waiting, resume, and replan; short Host leases and Evidence-backed completion prevent concurrent or fabricated restoration.
- One TypeScript/Node.js runtime on Windows, macOS, and Linux, with no Python dependency.

Versions 0.9.10–0.10.2 also provide scoped file snapshots, local transaction records, restricted TypeScript proposals, and host execution handoffs. Version 0.10.0 adds shared typed work objects; v0.10.1 adds field-level ChangeSets; v0.10.2 adds durable waits, hierarchical budgets, fallback contracts, isolated parsing, trusted egress, an external Effect/Saga Kernel, and tiered autonomy policies. An authorization can require automatic execution, notification, one human approval, or multi-signature approval and is bound to an exact task, action, target, digest, TTL, and single consumption. Ambiguous effects can use pre-authorized read-only reconciliation. The compensation adapter freezes authorization, request digest, approval, and HTTP outcome mappings before dispatch; transport uncertainty and compensation failure remain explicit. Proposal operations are still supplied by the caller, not inferred automatically from raw traces. See [execution boundaries (Chinese)](docs/technical/modules/execution-policy.md).

External Effects and Runtime Host Adapters atomically consume those authorizations when dispatching. Computer Use is a first-class operation kind with an exact action identity, while the actual browser or desktop driver remains a host responsibility.

Vector search is optional. Configured OpenAI-compatible embeddings augment lexical retrieval; absent configuration or service failures retain the lexical path.

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

`craft init` currently selects Agent, Supervisor, or Provider mode. Planned onboarding will start with goals and materials and move technical modes into advanced settings; that UI change is not implemented yet. Configuration, SQLite data, indexes, logs, and backups live under `~/.craft_data`; set `CRAFT_DATA_DIR` to override it.

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

Tools use the `craft_` prefix to avoid collisions. For substantial work the Craft Skill automatically starts with `craft_default_route`, without requiring a repeated orchestration prompt. A matching verified Workflow is executed via `craft_default_route_execute`; an unmatched safe plan is progressed with `craft_default_route_update`. A required Project Policy makes structured Git, test, coverage, and review receipts server-enforced; a Host Adapter can receive only its declared next safe action. In a later session, `craft_default_route_find` resolves a uniquely matching active task from a natural-language continuation and never guesses on a tie; `craft_default_route_resume` resumes a known task ID. After two or more passed routes from distinct tasks with confirmed or bounded evidence share a strategy, `craft_route_workflow_proposal_create` may save one Host-distilled, project-neutral `draft` Workflow; it cannot promote or publish it.

## Verification

```bash
pnpm run typecheck
pnpm test
```

The test command enforces 100% line, function, and branch coverage. Coverage is calculated by the test runtime, never self-reported by a model.

See the [documentation index](docs/README.md) and [architecture](docs/architecture.en.md) for product direction, boundaries, and data models.
