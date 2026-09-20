# Changelog

> Note on numbering: the declared package version is now **0.12.35**. Earlier
> `v0.12.34`–`v0.12.43` headings name **incremental work on the previous revision**,
> not releases. Each is a self-contained change set with its own 100%-coverage
> test script; the version bump happens only when the work is released.

## v0.12.35（本次发布）

- 收口 P0-P2 控制面：新增 Runtime Execution Attempt、Context Working Set、Workbench Command、Capability Intake 和 Graph Compiler；Graph 只生成交给 `VerifiedWorkLoop` 的 Plan。
- 运行 Attempt 绑定 Task/Run/Host/Environment/Effect/Receipt/Observation，并将 `effect_unknown` 固定为需人工或受控 reconcile、禁止自动重放；上下文回执只保存引用、预算与选择原因。
- 新增能力来源扫描、Conformance、审批、撤销和升级计划；扩展 MCP、CONTEXT、技术模块文档与 ADR，并为新模块建立 100% 行/函数/分支门禁。
- 将 `craft_component_readiness_get` 明确限定为内容无关的可达性预检：返回值标记为 `readiness_only`，不会冒充 Knowledge 检索、Memory 读取、Experience 观察或 Context Resolution。
- 独立 Knowledge、Memory、Experience MCP 面只接受自身组件的 readiness/diagnose 请求；错挂载调用会失败并指向正确的组件入口。
- 同步组件插件、适配器和 Marketplace 版本元数据至 `0.12.35`。

## v0.12.34

- 统一 `Agent / Harness / Environment / Context / State` 契约，并将 `Goal → Target → Plan → Step → Accept → Outcome` 接入 VerifiedWorkLoop。
- 新增单点能力 `EvaluationContract`，阶段从机制证据单调推进到 `routeable`，不会因单次调用或握手自动放行。
- 统一发布版本元数据、组件依赖、插件 manifest、MCP serverInfo 与 Marketplace 校验；Schema 与 Protocol 版本独立保留。
- `craft-knowledge`、`craft-memory`、`craft-experience` 的 Codex Hook Bridge 现可独立工作：仅注入各自范围内的 Context；Memory 只接受 `记住：…` 或 `/remember: …`；Experience 仅从“本地修改 + 可观察验证”生成脱敏 Observation 和候选请求，绝不记录聊天正文或自动发布 Workflow。

## v0.12.43 (continued) - origin/main merged: 0.12.32's work re-expressed on the split kernels

`origin/main` was ten commits ahead with the 0.12.32 feature set (Markdown content store,
Memory Governance, Workflow DAG, Task State, MCP Tasks, Runtime Proof, Trace Review, Memory
Maintenance, legacy knowledge migration). This branch had meanwhile split the same modules
along capability boundaries, so the merge had to answer, feature by feature, which of the two
structures each one belongs to.

**Ported onto the split kernels.** `payload` no longer returns a body that lives behind a
`content_ref`. `MemoryLedgerKernel.remember` writes the body to the content store, keeps the
reference and the digest, and gives a working note 24 hours and an episode 30 days by default.
`ContextResolutionKernel.resolve` reads bodies through that same reference, and reports a scope
it could not obtain as `skipped: true, reason: "scope_unavailable"` instead of searching every
scope. `MemoryGovernanceKernel` takes the Ledger half it actually calls (`remember`,
`transition`) rather than the single object this branch split up. `validation.ts` gained the
shared `fallback`, `optionalText` and `optionalScope` helpers and the `session` scope kind,
because three modules carried private copies of them.

**Deliberate losses, recorded rather than hidden.** The remote's cosmetic `x ?? d` ->
`fallback(x, d)` rewrites inside the eight modules this branch split out of `v01211-runtime.ts`
were not carried over: the shared helper exists, the spellings are behaviour-identical, and
re-applying them would have rewritten files for no reader. `defaultSettings().theme` stays
`"system"`, harmonised with `normalizeSettings`, instead of being reverted to the remote's
`"light"`: the two describe the same first launch and must agree, and this branch had already
changed the factory rather than the test.

**Found while merging.** Both sides added `tests/runtime-proof.test.ts`; the collision cost the
remote's RuntimeProofKernel tests, now restored as `tests/runtime-proof-kernel.test.ts` and
`src/runtime-proof.ts` back at 100%. `.gitignore`'s `coverage/` pattern matched
`scripts/coverage/` at any depth, so the coverage gate scripts themselves were never committed
and a fresh clone could not run its own gate; the directory is now un-ignored explicitly. Two
shared helpers that `git` merged textually had to be reconciled by hand because the two sides
disagreed about meaning: the theme default above, and `runtime-acceptance`'s evaluation identity,
which included the plan version that `evaluate` itself bumps, so the remote's idempotency test
and this branch's kernel could not both be right.

**Verification.** `pnpm run typecheck`, `pnpm run lint`, the four audits and all **39** per-module
coverage gates pass, and **1038** tests pass. The single combined coverage run
(`scripts/ci/test.ts`) still reports a residue below its 100/100/100 thresholds
(99.93 line / 99.65 branch / 99.40 function over 23 files). That gate was already failing before
this merge on 53 files at 97.03% branch coverage, so the merge improves it rather than causing
it; the residue is dominated by class-field lines that V8 attributes as uncovered only in a
combined run -- the effect `tests/coverage-gates.json` documents -- plus a few delegates the
remote added that only its per-version scripts exercised.

## v0.12.43 (continued) — the four open questions, decided and landed

`context-members.md` ended with four things it deliberately would not decide. All four are now
decided, implemented, and tested.

### Three compaction mechanisms became one

`compactConversation`, `ReversibleContext.project` and `compactionPlan` each answered "what fits in
the budget" independently. They disagreed where it mattered: two ranked by weight but broke ties in
**opposite** directions, and only one protected anything — so a caller's result depended on which
function it happened to call rather than on a policy anyone chose.

`src/compaction.ts` is now the one implementation, with two stages whose fill rules deliberately
differ: a **contiguous recent suffix** stops at the first segment that does not fit, because
contiguity is what makes the elided span describable as one run; then the remainder **competes by
weight, skipping** what does not fit, because that is what packs a budget. One tie-break for the
whole system: weight descending, then the more recent segment. Protection stays **subtraction** —
removed from the budget and from the omitted set, its cost reported separately — because giving a
constraint a large weight still loses to a tighter budget, which is the failure the governance
research measures.

Two dead branches were found and removed while covering this: an id tie-break and a position
fallback, both unreachable because segment ids are unique. An unreachable branch reads as a rule
that exists.

### `restore` became durable, because the tool had promised something it could not do

`craft_context_project` said *"omitted segments are named and can be restored"*, and
`craft_context_restore` then demanded the **original segments again** — the one thing a caller that
omitted them no longer has. Measured before: `restore({segment_id})` threw
`Context segment s2 does not exist` and `context_segment` held nothing.

`src/context-projection.ts` stores a session's segments under `context_session` and a
**content-free** projection under `context_projection`, so a later call needs only
`session_id` + `segment_id`. The two paths are distinguishable rather than silently different: no
session means the old stateless answer plus `restored_from: "arguments"`. The segments are one
versioned record per session rather than one per segment, and that is a consequence worth stating —
the store has no `delete`, so per-segment rows would accumulate and stale ones could only be hidden.

Writing the tests found two real logic errors in it: `already_present` was derived from what would fit
at the **new** budget rather than from the session's stored projection, and the existence check came
after that derivation, so a segment the session did not hold at all looked present and the restore
returned a projection without it — silently, which is the one thing a restore must never do.

### `state` has one read-only view

`StateViewKernel` reads the contract, run, run state, launch, delivery loop, manifest and workspace
snapshot, and reports **one** status and **one** safe next action. Its whole content is the
precedence: a stopped run outranks a loop that still has work queued; `needs_replan` outranks
everything downstream of it; a pending approval outranks the loop's action, because reporting
`deliver` instead would invite the caller to skip a human decision. It has no write method and the
status is derived, so it cannot become a second source of truth, and `sources` names the records it
actually read so a reader sees the basis rather than the conclusion.

It also had a bug the tests caught: `store.list` is ordered **newest first**, and the kernel took
`.at(-1)` — the *oldest* contract and run. For a re-planned task that is the wrong answer, and it
looked plausible because a task with one contract has only one record to find.

### The transcript stays out of the capability system

`CONTEXT_MEMBER_SOURCES.history` is unchanged. `contributes` exists for a Host that keeps its own
prompt and asks Craft for material; when Craft *is* the Host it builds the request directly and needs
no such round trip. Making the transcript a capability would add indirection for the one caller that
does not need it, and would replace a checkable fact — the conversation is not in Craft's database —
with a policy.

Recorded as ADR 0012 and 0013; the ADR index now lists 13.

### Verification

`tsc --noEmit`, `lint` (623 files), `audit-layering`, `audit-surfaces` (834 tools), `audit:docs`
(391 links, 13 decision records), `check-version`, `check-consistency-falsifiable` (9/9) — clean.
Three new coverage groups (`compaction`, `context-projection`, `state-view`) at
**100.00 / 100.00 / 100.00**. Full suite: **919 tests, 913 pass, 6 fail** — the same six documented
sandbox `spawn EPERM` cases.
## v0.12.43 (continued) — the hook reaches the flow, and experience gets a read side that cannot leak

### `runPhase` had eighteen tests and no caller

That is the same defect as a provider nothing invokes, and it meant "a hook can stop a tool call"
was a claim nothing exercised end to end. The phase is now entered from **MCP `tools/call`**, in a
new `src/hook-plane.ts`:

| the protocol owed | what landed |
|---|---|
| capability attribution | `buildCapabilityRegistry` stamps `owned` onto every hook — **the registry is the only writer**, so a capability cannot appear in another's numbers — and `PhaseResult.outcomes` carries `capability` beside `hook` |
| honest context | `HookContext.scope_kind` / `scope_id` are **optional**; a tool call at the MCP boundary may belong to no task, and inventing a scope would put an unobserved fact into an instrumentation record |
| observability | `HookPlane.records` appends one **content-free** record per phase: the phase, how many hooks ran, whether any refused, which capabilities they were. No tool name, no arguments, no result |

`tool_before` is a gating phase, so a refusal **returns without dispatching** and `tool_after` does
not run either — hooks that decide about an effect that is no longer going to happen would be
deciding about nothing. The tests go through `McpServer.handle`, so a refusal travels the whole way
before it counts.

`input_digest` is a digest of the tool name and its arguments — content-free by construction, the
same discipline `prompt_digest` and `request_digest` already follow. `capability.name` comes from a
new `ownerOfTool(tool)`, which is what turns the `owns` declarations into something the flow
actually uses rather than a second list that could disagree with them. When no capability owns a
tool the field is **omitted, not defaulted**: `{name: "unowned"}` would be a fabricated attribution.

### `contributes` had to become a factory, and that is a protocol gap it exposed

A contribution needs the kernels `register` just built, and which kernel that is only the registry
knows — so a static provider could not hold a store that does not exist until assembly. A capability
with a genuine read side had no way to declare one. `contributes` is now
`(registry) => ContextContributionProvider`, called after every `register` in capability order. No
capability had a contribution when this changed, so making it a factory cost nothing.

### The experience read side, which may only hand over pointers

`craft-experience` is the **only** one of the three members with a contribution, and it is the
opposite of the other two. Knowledge and memory read back through `ContextResolutionKernel.resolve`
in the core; experience cannot, because `compile` stores only
`hypothesis_digest` / `applicability_digest` / `counterexample_digest` with `content_free: true`, and
every record is `execution_visible: false` — *"execution Hosts never receive it directly."*

So the prose a Host must not receive **does not exist in Craft to leak.** What the contribution
carries is a reference and its provenance: which pattern, at which version, of which kind, backed by
how many independent observations and how much Evidence, whether the ledger marks it
execution-visible, and whether anything for it has reached Signoff
(`requires_governed_route: true`). That is what a routing policy needs in order to decide to consult
the ledger through a governed path.

The failure mode this file could have is growing a field, so the test asserts the absence: no item
may carry `hypothesis`, `applicability` or `counterexample`, and the record itself is checked to
have no such key. Matching is on `scenario_key`, and the request's scope is deliberately unused — a
pattern has no scope, and filtering by one would look like it narrowed the result when nothing could
satisfy it.

### `resolve` is async now, and that is a real behaviour change

Contributions are asynchronous, so `ContextResolutionKernel.resolve` is too. The consequence worth
naming: a validation failure (a query containing a credential, an invalid budget) is now a
**rejection** rather than a synchronous throw. Identical through MCP, where the handler catches
both, but different for a direct caller — every `assert.throws` in the affected tests became
`assert.rejects`.

The receipt keeps only a content-free summary of what the contributions selected
(`member`, `receipt_id`, `item_count`, `omitted_count`), while the result carries the material. A
receipt holding the items would be storing retrieved content. The summary is part of the receipt's
identity, so replaying a resolution against changed compiled experience is a conflict rather than a
silent second receipt describing a different pack.

### Verification

`tsc --noEmit`, `lint` (615 files), `audit-layering`, `audit-surfaces`, `audit:docs`,
`check-version`, `check-consistency-falsifiable` (9/9) — clean. New coverage groups and tests:
`hook-plane.ts` and `capability-protocol.ts` at **100.00 / 100.00 / 100.00** together with
`capability-catalog.ts`; `experience/contribution.ts` and `context-resolution.ts` at the same. Two
groups were extended (`evaluation-model-workflow-evolution`, `universal-runtime`) and both re-run
directly, since `scripts/coverage/coverage-gates.ts` cannot spawn in this session. Full suite:
**902 tests, 896 pass, 6 fail** — the same six documented sandbox `spawn EPERM` cases.

### One self-inflicted error, again

`Regex.Replace(text, pattern, replacement, 1)` reads its fourth argument as `RegexOptions`, not as a
count — so the import insertion hit **every** import line, twenty-two duplicates in `mcp-server.ts`.
This is the second time in this session, and the first time was documented in this same changelog.
The lesson belongs in the practice rather than in another paragraph: a multi-file text transform
gets a line-based implementation or a dry run, never a four-argument `Regex.Replace`.
## v0.12.43 (continued) — Experience becomes a package, and the core stops constructing it

### The capability had a contract and no instance

`capability-protocol.ts` declared what a capability *is* — a name, an ownership pattern, a
`register` hook, an optional context contribution, hooks on the flow — and nothing
implemented it. The core still did this, in `service-foundation.ts`:

```ts
this.experienceLedger = new ExperienceLedgerKernel(store);
this.evaluationModelProfiles = new EvaluationModelProfileKernel(store, this.modelProviders);
this.workflowEvolution = new WorkflowEvolutionKernel(store);
```

Three `new` calls naming three classes through three direct imports. A capability could not
be added, omitted, or replaced: deleting a line would have left an `undefined` property to be
discovered at call time, which is not the same thing as being unable to omit it.

`capability/craft-experience/` is now a package:

| file | role |
|---|---|
| `package.json` | `@craft/capability-experience`, version `0.12.33`, `exports` for the descriptor and each kernel |
| `tsconfig.json` | compiles against the repository config with `rootDir` at the repository |
| `ownership.ts` | `EXPERIENCE_FAMILIES`, `EXPERIENCE_OWNS`, `EXPERIENCE_COMPONENT` — imports nothing |
| `capability.ts` | the `CraftCapability`: name, product, `owns`, `register` |
| `experience-ledger.ts`, `workflow-evolution.ts`, `evaluation-model-profile.ts` | the kernels, moved here from `src/` |

The core now states the capability set once, in `src/capability-catalog.ts`, and resolves what
the capabilities built:

```ts
const capabilities = buildCapabilityRegistry(CRAFT_CAPABILITIES, {
  [CORE_KERNELS.store]: store,
  [CORE_KERNELS.modelProviders]: this.modelProviders,
});
this.experienceLedger = capabilities.registry.require<ExperienceLedgerKernel>(EXPERIENCE_KERNELS.ledger);
```

### `core` is a registry parameter because a capability must not own its environment

A capability has to *require* the store and the model catalogue, and cannot *provide* them:
both are decided before the capability set is known. `buildCapabilityRegistry` therefore takes
the core's kernels and registers them first. Two things follow, and both are tested rather
than asserted:

- **A removed capability reports the kernel it owed.** `buildCapabilityRegistry([])` then
  `require(EXPERIENCE_KERNELS.ledger)` throws `kernel is not registered: experience.ledger`,
  naming the capability. This is the property the contract existed for.
- **A capability cannot displace the environment.** A capability that provides
  `core.store` collides with the core's own entry and fails assembly with
  `kernel already registered: core.store`, rather than winning by registering last.

### The moved kernels brought their layer with them

`audit-layering.ts` walked `src/` only. Moving a kernel to `capability/` would have removed it
from the audit — the exact "moving the file silences the rule" failure that script was
rewritten to close. The walk now covers `capability/` too, at a declared rank of 1: a
capability owns kernels, so it may use infrastructure and domain kernels and may **not** reach
into `application/` or `interfaces/`. A capability that could import the facade that discovers
it would make the dependency run both ways, and neither side could then be replaced alone.

Falsified before being trusted: a probe file at `capability/_probe-upward.ts` importing
`src/interfaces/mcp-server.ts` produced `capability/_probe-upward.ts -> src/interfaces/mcp-server.ts`
and exit 1; removing it returned the audit to clean.

### The Experience product could not reach its own ledger

`COMPONENT_SURFACES["component-experience"]` was the literal

```
/^craft_(workflow_evolution|evaluation_model|experience_mine|experience_candidate|experience_shadow|route_workflow_proposal|workflow_(?:save|get|search|transition|rollback))/
```

which does not match `craft_experience_ledger_observe`, `_compile`, `_propose`, `_evaluate`,
`_decide` or `_get` — the ledger is *the* write side of experience, and it was unreachable
through the product named after it. Nothing reported this because the surface list and the
implementation had no relationship anything could check.

The projection is now derived from the capability's declared families, in the same
`ownership.ts` that declares them, and it adds back the separate kernels the same product
serves (`craft_experience_pattern_*`, `_mine`, `_candidate_list`, `_shadow_experiment_*`,
`_capture_*`). Ownership stays narrow — this capability does not implement those families and
does not claim them, because a declaration that cannot be wrong is not a declaration.

`component-context`, `component-knowledge` and `component-memory` had each restated
`context_resolution|retrieval_adapter` verbatim; they now compose it from one source, so
adding a shared verb is a one-line change instead of a three-line one.

## v0.12.43 (continued) — the class that served two members, cut into three modules and a third package

### Why craft-memory could not be declared

`knowledge-memory-runtime.ts` was one class serving **two context members' writes** and one read
side at once:

| the class held | which member |
|---|---|
| `installBuiltins`, `sourceRegister`, `sourceList`, `sourceTransition` | knowledge |
| `remember`, `transition`, `compatBind`, `get` | memory |
| `retrievalConfigure`, `retrievalEvaluate`, `resolve`, `receiptGet` | all three, on read |

A class serving two members belongs to neither package, so `craft-knowledge` could not claim
`craft_knowledge_source_*` and `craft-memory` had nothing to register. Cut along the **member
boundary** — not by size — into three modules:

| file | owner |
|---|---|
| `capability/craft-knowledge/knowledge-source-registry.ts` | the knowledge package |
| `capability/craft-memory/memory-ledger.ts` | the memory package |
| `src/context-resolution.ts` | **the core** |

The read side has to stay in the core, and the projection says why: `component-knowledge`,
`component-memory` and `component-context` all expose `craft_context_resolution_*` and
`craft_retrieval_adapter_*`. A Host that loads only one concern still has to resolve what that
concern holds, so it cannot belong to either package — and both packages therefore declare **no**
`contributes`, because two contributors for one member are rejected by `buildCapabilityRegistry`.

### Sharing came first, and only where the behaviour agreed

Extracting the helpers was the prerequisite, and the discipline is the one `layer-map.md` set:
merge only where the **behaviour** agrees.

| helper | copies | distinct bodies | distinct behaviours | outcome |
|---|---|---|---|---|
| `canonical` | 18 | 14 | **1** | merged as `canonicalJson` |
| `digest` over `canonical` | 17 | 1 | **1** | merged as `stableDigest` |
| `scope(args)` | 2 | 2 | **1** | merged as `parseScope` |
| `strings(required=false)` | 3 | 2 | **2** | the two agreeing copies merged as `sortedUniqueList` |
| `noSecret` | 4 | 4 | **3** | the two agreeing copies merged as `noCredentialAssignment` |
| `craft-service.ts` `fingerprint` | 1 | 1 | same algorithm, **different public shape** | kept |

`stateful-compute.ts` adds `if (required && !result.length) throw` to its `strings`. Folding it
into `sortedUniqueList` would make two modules that never threw start throwing, which is a
behaviour change disguised as an extraction — so the divergence stays where it is, and
`tests/validation.test.ts` asserts it, including a source-level check that fails if either copy is
ever migrated without a deliberate change.

### The validators and the digest module now have tests and branch gates

`src/validation.ts` and `src/digest.ts` were each the **only** place a contract lived —
"merge only where behaviour agrees" and "the digest name decides a record's identity" — and neither
had a test importing it. Both now do, in per-group branch gates (`shared-validation`,
`shared-digest`) at **100.00 / 100.00 / 100.00**.

Writing the validator test found a real gap in the credential guard, recorded rather than
fixed: `authorization: Bearer abcdefgh` is **not** refused, because the pattern requires eight
non-space characters immediately after the separator and a scheme word is shorter. Widening it
would change what two kernels refuse, so it is a decision with its own blast radius rather than a
drive-by fix during a split; the test pins the current behaviour so it cannot be lost.

### Two product surfaces changed, both repairs

- `component-memory` previously matched `craft_knowledge_bootstrap_install` but **not**
  `craft_knowledge_memory_install_builtins` — the same handler under two names, so a Host could
  bootstrap with one name and not the other. Both are now exposed, and the test asserts the added
  set is exactly that one name.
- `component-knowledge` gains the Source families as **owned** rather than projected-on-the-core's-
  behalf, because the registry now lives in that package. The test that asserted the old claim was
  rewritten rather than deleted, since a deleted assertion would have let the reversal go unnoticed.

`component-context` is unchanged, and asserted so: it composes the **frozen** knowledge and memory
name spaces, because its membership is a compatibility surface and the split is not a reason to
change what an existing Host sees.


### The memory signals move into the package, and a false ownership claim is corrected

Moving the Ledger was not the whole of item (2). `src/memory-wiring.ts` — decay weight, decay-aware
reranking, capture policy, legacy-promotion planning, hybrid scoring, usage evidence — was already a
module of pure functions with a one-line facade wrapper each. It is now
`capability/craft-memory/memory-signals.ts` plus a `memory.signals` kernel, so the five derived
signal families are **claimable** and the facade reaches them through the registry like everything
else. Claiming them needed no behaviour change, only the file move — which is the difference between
an ownership declaration and an aspiration.

Writing the ownership test then found a **false claim of my own**. `MEMORY_OWNS` asserted
`craft_memory_remember` and `craft_memory_transition` as "the Ledger's older names", and the test
asserted it too. Reading the handler map showed both are served by `WorkbenchKernel` over the legacy
`memory_item` collection, which this package does not assemble. The claim was plausible, the test
agreed with it, and nothing would have contradicted it — which is exactly the failure mode the
ownership pattern exists to catch. Both are now excluded, the exclusion is asserted, and the
correction is named in `ownership.ts` where the next reader will see it.

What memory still does **not** claim, each for a stated reason: the shared read side
(`ContextResolutionKernel`, projected by three products and owned by none) and the consolidation
family (`MemoryConsolidationKernel`, a separate core kernel).

Coverage: the ``memory-wiring`` group was repointed to the two moved files and is at
**100.00 / 100.00 / 100.00**, including a test that calls **every** kernel method — a signal reachable
only by importing the module is a signal no capability consumer can reach. Full suite: **889 tests,
883 pass**, the same six documented sandbox ``spawn EPERM`` cases.
### Verification

`tsc --noEmit`, `lint` (613 files), `audit-layering` (the new `capability/craft-memory/` is
ranked with the other packages), `audit-surfaces`, `audit:docs` (387 links, 11 decision records),
`check-version`, `check-consistency-falsifiable` (9/9) — clean. Coverage:
`knowledge-source-registry.ts`, `memory-ledger.ts`, `context-resolution.ts`,
`work-runtime-mode.ts` and `verified-work-loop.ts` all at **100.00 / 100.00 / 100.00** in the
`universal-runtime` group, and the `capability-packages` group at the same with the memory
package added. Full suite: **888 tests, 882 pass, 6 fail** — the same six documented sandbox
`spawn EPERM` cases.
## v0.12.43 (continued) — the conclusions get written down, and the docs get a check that can fail

### What was missing

A long design conversation produced conclusions that existed only in the conversation: what the
five context members are and who holds each, what `state` actually stores, why `history`
stays host-provided even when Craft *is* the host, why goal and acceptance must be built in while
the evaluation method is pluggable, and which three compaction mechanisms exist without knowing
about each other. docs/adr/ already had **six** decision records that `docs/README.md` did
not list, no technical document linked, and nothing referenced at all — so the directory was as
forgettable as no directory.

### Written down

| Where | What it now records |
|---|---|
| `docs/technical/modules/context-members.md` **(new)** | the five members with owner, lifetime, gate and pluggability; the `state` triple and `stability_digest`; the three compaction mechanisms measured side by side; why dropping ≠ compressing; why goal/acceptance are built in; **four open decisions** |
| `docs/technical/modules/capability-protocol.md` **(new)** | why MCP is the external protocol and this is the internal one; `register` / `owns` / `contributes` / `hooks` / `product`; core as a registry parameter; ownership vs projection; the three hook safety rules and the three missing pieces for per-capability instrumentation; package layout and the rank-1 layering rule; the two remaining blockers for `craft-memory` |
| `docs/adr/0007`–`0011` **(new)** | context members have fixed natures; goal and acceptance are built in; ownership is not projection; a hook belongs to the flow; shared helpers merge only where behaviour agrees |
| `docs/adr/README.md` **(new)** | the index the directory never had, all 11 decisions, plus which technical document expands each |
| `docs/technical/modules/internal-host.md` | the section it was missing: when Craft runs its own loop it *is* the host, so it holds and compacts the transcript, with the two-stage policy and the distinction from tool-result truncation |
| `docs/technical/modules/runtime-truth.zh-CN.md` | the sentence "恢复只读取同一会话的检查点" was aspirational; it now names the read verbs that make it true and says which version added them |
| `docs/technical/modules/context-memory.md`, `docs/architecture.zh-CN.md`, `docs/technical/overview.zh-CN.md`, `docs/architecture/layer-map.md` | the `agent = model + harness` framing, and pointers to the two new documents from every place a reader would start |

### The check, because writing it down is not enough

`scripts/ci/check-doc-links.ts` is wired into the `test` chain as `audit:docs` and checks
two things a reader cannot check by reading:

1. **Every relative Markdown link resolves.** Measured when written: 382 internal links across
   162 documents, of which exactly one was broken — a link written in the same session as the
   document containing it.
2. **The ADR index and the ADR directory agree in both directions** — no unlisted record, no
   entry without a record. Records are discovered from the directory, never from the index, so
   the index cannot define its own correctness.

Falsified before being trusted: deleting one row from `docs/adr/README.md` made it report
`1 decision record(s) missing from the index` and exit 1; restoring the row returned it to
clean.

Its own first run reported six dangling entries, and the cause was a flaw in the check rather
than in the index: it counted *every* link in the ADR index, including the ones pointing out to
the technical documents each decision expands. Only links naming a record count now — a check
whose first result is noise is a check that gets turned off.

### Verification

`tsc --noEmit`, `lint` (611 files — the two new documents and the new script are swept too),
`audit-layering`, `audit-surfaces`, `audit:docs`, `check-version`,
`check-consistency-falsifiable` (9/9) — clean. Full suite unchanged at **873 tests, 867 pass,
6 fail** (the same six documented sandbox `spawn EPERM` cases): this change touches no code
that runs.
## v0.12.43 (continued) — the digest naming decision, and the 18 copies it unblocked

### digest.ts said what was blocking it, and the blocker was measurable

The module's own doc ended with:

> The key-sorted variant is **not** exported yet: its 17 copies agree with each other, but the
> `canonical` helper they depend on is itself duplicated with differing definitions, so it
> needs its own decision before it can be shared.

That decision is now made, by measuring rather than reading:

| helper | copies | distinct bodies | distinct **behaviours** | outcome |
|---|---|---|---|---|
| `canonical` | 18 | 14 | **1** | merged as `canonicalJson` |
| `digest` over `canonical` | 17 | 1 | **1** | merged as `stableDigest` |
| `craft-service.ts` `fingerprint` | 1 | 1 | **1, but a different shape** | kept — bare hex, no prefix |
| `strings` | 30 | 6 signatures | ≥ 3 | not merged |
| `noSecret` | 4 | 4 | **3** | not merged |

The interesting result is that `canonical` and `digest` reached **opposite** conclusions from
the same kind of measurement, and the difference is the whole point: `digest` had five
behaviours, so its copies were doing different things; `canonical` had one behaviour in 14
spellings, so its copies were only written differently. The 14 differ in parameter names
(`a/b`, `left/right`, `k/v`, `child/item/entry`) and in where the body wraps — and in
nothing else.

The 18th caller is the one worth naming: `craft-service.ts`'s `fingerprint` serializes the
same way and returns **bare hex**, with callers that add `sha256:` themselves. It is not a
variant of `stableDigest`; it has a different public shape, and a stored fingerprint is an
identity, so merging it would have changed what the facade persists.

### The golden digests caught a real mistake in the merge

`tests/digest-canonical.test.ts` pins digests captured from the **pre-merge** implementation.
That is not decoration: an extracted function cannot prove it preserved identity by re-deriving
the values from itself.

It caught one. The first version of `canonicalJson` returned the text `undefined` for a
nested `undefined` everywhere, on the reasoning that template interpolation renders
`undefined` as `undefined`. That is true for an object **value** and false for an array
**element**, where `Array.join` renders it as the empty string:

| position | expression | `undefined` renders as |
|---|---|---|
| array element | `[\]` | `""` |
| object value | `\\:\\` | `undefined` |

So the merged function silently changed the digest of `[undefined]` — and the golden entry
`undefined-element` failed with "changed identity". The fix is that the recursion returns
`undefined` verbatim (typed `string | undefined` and not exported) and the public
`canonicalJson` guarantees a string or throws. The two renderings now come from the two
templates for free, exactly as before.

The one behaviour change is at the **top level** of a value that cannot be serialized: the old
copies returned `undefined` from `JSON.stringify`, so `Hash.update` raised
`ERR_INVALID_ARG_TYPE` naming the crypto call instead of the input. It now raises
`canonicalJson cannot serialize undefined`. Only inputs the old code could not serialize either
are affected.

### Coverage for the module the distinction lived in

`digest.ts` had **no test importing it** — the distinction between the two digest kinds was
carried entirely by prose in 18 files. It now has a per-group branch gate
(`tests/coverage-gates.json` → `shared-digest`) at **100.00 / 100.00 / 100.00**.

### A damaged refactor, and what the process caught

The migration script that removed the 18 definitions matched `\n}\n` to find the end of a
multi-line function. On CRLF files that never matches, so the pattern ran past the function and
swallowed whatever followed — including, in three files, the entire class body. Earlier attempts
also inserted an import before *every* import (a `Regex.Replace` overload where the intended
count argument was read as `RegexOptions`) and renamed `.digest("hex")` on a crypto `Hash`.

All of it was caught before it could be reported as done, by `tsc` and by the module tests, and
repaired: `certification.ts`, `contracts.ts` and `supply-chain.ts` were rebuilt from their
committed bodies plus the intended de-duplication, and their tests (19 across the eight affected
modules) pass unchanged — which is the evidence that the rebuild is faithful rather than
plausible. The remaining lesson is recorded here rather than in a script comment: a text
transform over 18 files needs its own verification step, and `git` is not a safety net while a
session's work is still uncommitted.

### Verification

`tsc --noEmit`, `lint` (602 files), `audit-layering`, `audit-surfaces`,
`check-version`, `check-consistency-falsifiable` (9/9) — clean. Full suite: **873 tests, 867
pass, 6 fail** — the same six documented sandbox `spawn EPERM` cases, so the 18-way merge
changed no observable behaviour across a suite that exercises every affected kernel.
## v0.12.43 (continued) — the compacted history could be written and never read

### Two records that existed only to be read, and could not be

RuntimeTruthKernel persisted two things whose entire purpose is to be read back later, and
neither had a read verb:

| record | written by | purpose, from its own description |
|---|---|---|
| `context_compaction` | `runtimeTruthCompact` | the compacted window a resuming Host rebuilds its request from |
| `work_note` | `runtimeTruthWorkNote` | *"for long-running Agent sessions"* |

`craft_runtime_truth_compact` returned the compacted messages, so the caller that *made* the
compaction got them; a Host *resuming* that session could learn only that a compaction had once
happened, never what it contained. `work_note` was worse: its description says it is for
long-running sessions, and a note you cannot read on resume does not do that.

Both are now readable, with the same shape every other Craft kernel uses:

| verb | reads |
|---|---|
| `craft_runtime_truth_compaction_get` | one compaction by `session_id`, optionally pinned to a `version` |
| `craft_runtime_truth_compaction_list` | summaries of stored compactions, so a Host can find a session it never named |
| `craft_runtime_truth_work_note_get` | one note by `note_id`, optionally pinned to a `version` |

The record id *is* the session id — `compact` already saved under `args.session_id` — so
resuming needs only the session's own name and no new index. The listing projects the summary
and deliberately omits `messages`, so listing ten sessions does not pull ten transcripts into
the response.

### Why this is the blocker for "history holds the whole thing plus the compacted block"

The compaction machinery itself was already there and already good:
`runtime-truth.ts::compactConversation` keeps the system message and a recency-filled tail up
to 65% of the budget, elides the middle, and stages a rule-based elision before an optional
model summary with a deterministic fallback that is content-free and carries the dropped text's
digest. `internal-host-driver.ts` calls it on every turn against `limits.max_context_tokens`
and persists the result to `internal_session`.

What was missing was one direction of the round trip. A stored window that cannot be retrieved
makes the "whole thing plus a compacted block" arrangement impossible to build on top of,
however good the compaction policy is. That is now closed for the two records that had the gap.

### Also recorded, not changed

`ContextContributionProvider` says only an accumulating member can be contributed, and
`buildCapabilityRegistry` enforces it. The doc comment now also states the self-hosted case,
which looks like a counterexample and is not one: when Craft runs its own loop it *is* the Host,
so it holds the transcript and compacts it against the request it is building rather than asking
itself for a `ContextContribution`. `history` stays `host_provided` in both modes — what
changes is who the host is, not which member is pluggable.

### Verification

`tsc --noEmit`, `lint`, `audit-layering`, `audit-surfaces` (832 tools, unchanged
domain classification), `check-version`, `check-consistency-falsifiable` (9/9) — clean.
`runtime-truth-kernel.ts` is at **100.00 line / 100.00 function** coverage;
`tests/runtime-truth.test.ts` gains one test (8 total) covering the round trip, the version
pin, the generated-id listing, and both new verbs over MCP including their failure paths. The
module is not in a per-group branch gate and its branch coverage is 84.44% — a pre-existing
shortfall in `standardize`/`otlp`/`export`, recorded rather than papered over by adding a
threshold it does not meet. Full suite: 869 tests, 863 pass, the same six documented sandbox
`spawn EPERM` failures.
## v0.12.43 (continued) — the context decision read one member and the model has three

`TurnCognitiveRuntime.decide` chose whether to assemble a context pack like this:

```ts
const context = policy.mode === "observe_only" ? "none"
  : (matches(policy.context_on, ["needs_context"]) || intents.has("knowledge") ? "resolve" : "none");
```

Context is `history + knowledge + memory + experience + state`, three of those members are
accumulated by capabilities, and resolving context assembles all of them at once. The decision
named exactly one. A Host that declared `intents: ["memory"]` got `context: "none"` — the
member was in the MCP surface and in the registry and not in the decision that decides whether
to consult it.

The other half was that it could not be declared. `SIGNALS` had `needs_context`,
`needs_capability`, `needs_workflow`, `needs_execution`, `durable_value` and
`sensitive` — no `needs_memory` and no `needs_experience` — so there was no way to say
"this turn needs memory" even for a Host that wanted to.

Both are closed:

| | added |
|---|---|
| `INTENTS` | `memory`, `experience` |
| `SIGNALS` | `needs_memory`, `needs_experience` |
| `context` decision | resolves for any of `knowledge`/`memory`/`experience`, or for any of `needs_context`/`needs_memory`/`needs_experience` |

The widening is a widening and not a decision to always resolve: the test asserts that a turn
declaring none of the six still gets `context: "none"`, and that `observe_only` still
refuses to act on any of them. Both directions are asserted per member rather than in
aggregate, because the failure mode being fixed was one member being omitted from a list.

`turn-cognitive-runtime` stays at **100.00 / 100.00 / 100.00** with the new case.
## v0.12.43 (continued) — Knowledge becomes a package, and ownership separates from projection

### The same pattern at seven kernels instead of three

`capability/craft-knowledge/` now carries the seven kernels that were constructed inline in
`service-foundation.ts`, plus its own `package.json`, `tsconfig.json`, `ownership.ts` and
`capability.ts`:

| kernel | what it holds |
|---|---|
| `knowledge-workbench` | the bounded read-only Workbench projection and a Context Bundle preview |
| `knowledge-bound-launch` | a Work Launch pinned to one exact Context Bundle, revalidated before any Host run |
| `knowledge-relation` | typed, evidence-backed relations between addressable knowledge objects |
| `wiki-candidate-governance` | attestation, publication authorization, portable package preparation |
| `local-candidate-import` | writing one reviewed package to a user-selected path, without executing it |
| `project-knowledge` | the rebuildable Markdown index, its search, its scope expiry |
| `project-brain` | the project's goals, decisions, bound material and recorded outcomes |

`CORE_KERNELS` moved into `capability-protocol.ts` during this, because the Knowledge and
Experience packages were each declaring their own `core.store` — the same string, in two
places, with no way to notice a divergence. The protocol now owns the names the core
contributes, since that is part of the contract rather than any capability's business.

### Ownership and projection are different questions, and the difference is now load-bearing

Declaring Knowledge's `owns` forced a distinction that had been implicit:

- **`owns`** answers *who implements it*. It must be true, so it is deliberately narrow. The
  Knowledge package does **not** claim `craft_knowledge_source_*` or
  `craft_knowledge_bootstrap_install`, because the class that implements them —
  `knowledge-memory-runtime.ts` — also serves memory's Ledger writes. One class, two members,
  so it belongs to neither package and stays in the core.
- **`component-*`** answers *what a Host loading this product sees*. It may be wider: a Host
  with only the Knowledge product still needs its own Sources.

`tests/capability-knowledge-package.test.ts` asserts both directions, so a claim that is
merely plausible fails: a tool whose implementation is outside the package must not match
`owns`, and every family `owns` does match must be inside the projection.

### The Knowledge product could not reach two of its own kernels

`component-knowledge` was the literal `/^craft_(wiki|knowledge|claim|relation|context_resolution|retrieval_adapter)/`.
Two of the seven kernels this capability assembles — `project-knowledge` and `project-brain` —
serve `craft_project_knowledge_*` and `craft_project_brain_*`, and that name space matches
neither. The product named after the capability could not reach two of its kernels, and
nothing reported it, for the same reason the Experience ledger was unreachable: ownership and
the projection had no relationship anything could check.

`project` is now part of the Knowledge projection. `craft_project_*` is already a `knowledge`
domain family in `SURFACE_RULES`, so this aligns the product with the domain rather than
crossing it. The test measures the repair: it asserts the added tools are exactly the
`craft_project_*` ones and no others, and that all four previously-promised families are still
present.

`component-context` deliberately does **not** get the same widening. It is the older, narrower
projection and its membership is a compatibility surface, so changing it would alter what an
existing Host sees for a reason that is not about that Host. `ownership.ts` exports two
constants — `KNOWLEDGE_COMPONENT_SOURCE` and `KNOWLEDGE_CONTEXT_SOURCE` — and the difference
between them is a decision on the record instead of an oversight.

### Still not a package, and why

**`craft-memory`.** Two seams, both named in `src/capability-catalog.ts` where the next
capability would be added:

1. `knowledge-memory-runtime.ts` is one class serving knowledge's Source registry *and*
   memory's Ledger writes (`remember`/`transition`/`compatBind`/`get`). Splitting it needs a
   home for the helpers it shares with the rest of the codebase — and `layer-map.md` already
   records why those cannot be merged by name: `digest` alone has 112 copies with five
   different behaviours, and merging them by name would silently change content-addressed
   identity.
2. The rest of memory's behaviour is in the `craft-service.ts` facade, not in a kernel. A
   capability's `register` has nothing to construct until that is extracted.

### Verification

- `tsc --noEmit`, `lint.ts` (601 files), `audit-layering.ts`, `audit-surfaces.ts` (829 tools,
  7 domain rules, 7 component surfaces), `check-version.ts`,
  `check-consistency-falsifiable.ts` (9/9) — clean.
- New coverage group `capability-packages` over `craft-knowledge/capability.ts`,
  both `ownership.ts` files and `src/capability-catalog.ts`, at **100.00 / 100.00 / 100.00**
  with both package tests. `tests/capability-knowledge-package.test.ts` adds 7 tests.
- Full suite: 867 tests, 861 pass, 6 fail — the same six documented sandbox `spawn EPERM`
  cases in `codex-driver`, `capability-access`, `security` (×2), `capability-platform` and
  `generic-adapter-runtime`. Each was re-run and its `EPERM` confirmed individually.

### Two things this does not fix, recorded rather than implied

- **`craft-knowledge` and `craft-memory` are still not packages.** They are the two members
  `capability-catalog.ts` names as missing, with the reason: `KnowledgeMemoryRuntime` is one
  class serving both members' writes (`installBuiltins`/`sourceRegister`/`sourceList`/
  `sourceTransition` for knowledge, `remember`/`transition`/`compatBind`/`get` for memory),
  and memory's remaining behaviour lives in the `craft-service.ts` facade rather than in a
  kernel. Neither can be declared until those two seams are cut.
- **Experience declares no `contributes`.** Every tool it exposes is on the write side, so
  there is no read side to declare. Recorded in `capability.ts` at the place a reader would
  look for it.

### Verification

- `tsc --noEmit`, `lint.ts`, `audit-layering.ts`, `audit-surfaces.ts` (829 tools, 7 domain
  rules, 7 component surfaces), `check-version.ts`, `check-consistency-falsifiable.ts` (9/9
  mutations) — all clean.
- Coverage groups `evaluation-model-workflow-evolution` and `durable-experience` at
  **100.00 / 100.00 / 100.00** with the new `tests/capability-experience-package.test.ts`
  added to both (6 new tests). The moved files are named in `tests/coverage-gates.json` under
  their new paths, so a later move cannot leave them unmeasured either.
- `scripts/coverage/coverage-gates.ts` and `check-plugin-package.ts` cannot run in this
  session: both spawn a child with piped stdio and hit the documented sandbox `EPERM`. Each
  group was therefore re-run directly with `node --test --experimental-test-coverage`.

## v0.12.43 (continued) — one name per capability, and a check that the name declares its surface

### The same capability answered to four names

The Evolution component was addressed by four different strings depending on which
layer you were reading:

| layer | before | after |
|---|---|---|
| marketplace entry | `craft-workflow-evolution` | `craft-evolution` |
| plugin directory | `plugins/craft-workflow-evolution` | `plugins/craft-evolution` |
| skill directory | `skills/craft-workflow-evolution` | `skills/craft-evolution` |
| MCP product (`--product`) | `evolution` | *(unchanged)* |
| internal surface | `component-workflow-evolution` | `component-evolution` |

`component-plugin-architecture.md` already called it *"the formal Evolution product
projection"*, so the product name is the accurate one and the others now align to it.
**22 files, 51 occurrences.** `craft-skill-quality` was left alone: that one is a
declared compatibility alias, and this was not.

Separately, **`craft-workflow` (singular) is a different thing** — the publication
target host for a Workflow candidate in `wiki-candidate-governance.ts`. Sharing a
prefix with the plugin made the two easy to confuse, so it became `craft-workflow-host`.

The rename table is ordered longest-first: rewriting `craft-workflow` before
`craft-workflow-evolution` would have corrupted every occurrence of the latter. A dry
run also caught the script rewriting **its own replacement table**, which would have
broken the next run.

### The surface registry claimed a contract nothing checked

`surface-registry.ts` says of itself: *"The registry owns only names and matching
rules; execution remains in McpServer."* That makes a tool's name a contract — and
nothing verified it. `domainSurfaceOf` returns the **first** rule that matches, so two
things were invisible:

1. **A rule every match of which an earlier rule also claims is unreachable.** It reads
   as coverage while selecting nothing.
2. **A tool whose prefix belongs to one domain can be served by another.**

`scripts/ci/audit-surfaces.ts` now reports both, wired into the test chain. It follows
`audit-layering.ts`: unreachable rules fail outright, and a cross-domain match must be
named in `KNOWN_OVERLAPS` **with a reason**, so the judgement is recorded where a reader
finds it rather than implied by rule ordering. An entry that stops matching is reported
*stale* and fails.

### What it found: four tools whose name reads as the wrong domain

```
craft_agent_eval_lab_create / _start / _observe / _get
    served by: evaluation        (not collaboration, whose `agent` term also matches)
```

Both rules match; `QUALITY_TOOLS` contains `agent_eval` and the collaboration rule
contains `agent`, so `find` order decides. Serving them under `evaluation` is correct —
the lab instruments a versioned agent asset — and the shared `agent` prefix is the only
reason it looks otherwise. That is now stated, rather than depending on ordering.

No unreachable rules exist, and all 829 tools land in a surface.

### The audit made ownership order-dependence visible, as a check on itself

Two falsifications, because a check that has never failed may be incapable of it:

1. **Changing the exemption's `servedBy`** produced *4 undeclared + 1 stale, exit 1*.
2. **Reordering the rules and nothing else** moved the same four tools from
   `evaluation` to `collaboration` — `ownership is order-dependent`, which is the whole
   reason the audit exists: "the name declares the domain" holds only while the
   ordering happens to agree.

A first version of the audit reported **593** undeclared cross-domain tools. The
catch-all rule `/^craft_/` matches *every* tool, so counting it made every tool
overlap everything. The catch-all is now identified by behaviour (matching all tools)
and excluded from overlap detection, because only prefix rules can disagree about a
name — 593 false positives became 4 real ones.

### Verification

`typecheck` exit 0, `lint` clean, `version:check` exit 0, `audit:layering` clean with the
same single exemption, `audit:consistency` 9/9, `audit:surfaces` clean, and the full
suite at **836 / 830 pass** with the same 6 pre-existing `spawn EPERM` failures.

## v0.12.43 (continued) — one evaluation entry point, scoped

### Four disjoint paths became one

`craft-eval` had four scripts that did not share a case set: `suite.ts` ran all fourteen
cases with no way to ask for one capability, while `run.ts`, `recurrence.ts` and
`abstraction.ts` were earlier explorations with their own cases. "Evaluate knowledge"
had no entry point.

Now:

```
pnpm eval              # all fourteen
pnpm eval:memory       # the memory axis
pnpm eval:knowledge    # the knowledge axis
pnpm eval:workflow     # the workflow axis
pnpm eval:end-to-end   # the end-to-end axis
pnpm eval:governance   # the governance axis
```

Any scope can also be passed directly: `node capability/craft-eval/suite.ts <scope>`,
where `<scope>` is `all`, an axis, or a ledger (`capability` / `safety` / `value`).

### The selected cases *become* the suite

The alternative — running everything and marking unselected cases "did not run" — was
rejected because it corrupts three things at once. Here, `defineEvalSuite` is called
with the selected subset, so:

- the denominator is the axis measured, not five axes with four empty;
- `suite_digest` identifies the set that actually ran;
- a ledger with no selected case still reports **no observation**, so `quotable` stays
  `false` instead of being satisfied by whatever subset happened to run.

A `memory` run therefore reports `capability 3/3`, `safety NO OBSERVATION`, `value NO
OBSERVATION`, `quotable: false` — and says so rather than implying the whole suite was
green.

### Guards sit outside the `try`

Each of the fourteen cases is wrapped by `if (inScope("<id>"))` **before** its `try`, so
an unselected case is not executed at all. That matters for the two axes that call a
live model: a case discarded after running still costs a request.

A related consequence: the credential check now runs only when a selected case declares
`model_output` evidence. `pnpm eval:memory` and `pnpm eval:knowledge` run with no
`WORKBUDDY_API_KEY` at all, because those axes are graded from kernel results.

### Two defects found while building it

1. **The per-case list was misindexed.** It iterated `evalCases()` (all fourteen) while
   indexing into `results` (the selected subset), so `scope=knowledge` printed a
   `memory.` case name beside a knowledge result. Both sides now iterate `selected`.
2. **`scope=value` reported "unknown scope".** `value` is a *declared* ledger that holds
   no case, and the check derived known ledgers from the cases, so it was absent from
   its own list. The declared `LEDGERS` is now the authority, and the two conditions
   report differently: *unrecognised name* versus *declared but empty*.

### A catch clause that counted any exception as a pass

`workflow.failure_is_reported_not_hidden` ended with `catch { record(id, true) }` —
every exception, including one from setup, was recorded as a **pass**. An exception
means the case did not complete, not that the workflow reported its failure correctly.
It now records `unobserved`, consistent with every other case and with the suite's rule
that an unobserved case is neither a pass nor a failure.

### Verification

`typecheck` exit 0, `lint` clean, `version:check` exit 0, and every scope exercised:
`memory` 4 cases, `knowledge` 4, `workflow` 3, `value` declared-but-empty, `all` and the
model-bearing scopes failing cleanly on the absent credential. Full suite with the same
6 pre-existing `spawn EPERM` failures and no new ones.

## v0.12.43 (continued) — `continuous-runtime.ts` becomes eight modules

### What the file actually was

`layer-map.md` named it as an example of the problem: a module whose name records the
release that added it rather than what it does. Reading it showed eight classes that
share **nothing but private helpers** — editing cost accounting and editing replay
both meant opening the same file.

| new module | kernel |
|---|---|
| `src/context-plane.ts` | `ContextPlaneKernel` + `MANIFEST_FIELDS` |
| `src/replay-runner.ts` | `ReplayRunnerKernel` + `ReplayExecutor` |
| `src/local-runtime-service.ts` | `LocalRuntimeServiceKernel` |
| `src/project-bundle.ts` | `ProjectBundleKernel` + `positive` |
| `src/feedback-learning.ts` | `FeedbackLearningKernel` |
| `src/domain-evaluator.ts` | `DomainEvaluatorKernel` |
| `src/handoff-manifest.ts` | `HandoffManifestKernel` |
| `src/cost-ledger.ts` | `CostLedgerKernel` |

### Where the two remaining helpers went, and why differently

Their destination follows how they are used, not what they are called:

- **`positive`** is called by **one** kernel, so it moved with `project-bundle.ts`
  rather than becoming a shared export nobody else needs.
- **`list`** is called by **two**, so it was promoted to `validation.ts` as
  `uniqueList`. It is **not** the `list` already there: that one treats `undefined` as
  an absent optional field and tolerates repetition, while this one rejects a repeated
  value outright. Two modules had used the same name for different contracts, which is
  exactly why the earlier extraction left it alone — and why its promotion here renames
  the call sites instead of aliasing the import.

### Two import mistakes, both caught by `typecheck`

1. The slices still call `list(`, the name they had locally; importing `uniqueList`
   did not rename them. Five call sites across two files.
2. `context-plane.ts` uses `payload`, which the per-file import list omitted — the list
   was written by reading each slice, and reading turned out not to be checking.

Both were reported as `TS2304` and fixed. No behaviour was at stake in either: an
unresolved name cannot silently compute the wrong answer.

### Verification

`typecheck` exit 0, `lint` clean, `version:check` exit 0, `audit:layering` clean with
the same single documented exemption, `audit:consistency` 9/9, and the full suite with
the same 6 pre-existing `spawn EPERM` failures and no new ones.

`distribution-and-first-run.ts` remains: credential resolution, first-run readiness,
MCP protocol negotiation, isolation capability probing and distribution planning in
one file.

## v0.12.43 (continued) — a digest is named for its semantics, not for its brevity

### Why `digest` was the one helper that could not simply be shared

The earlier extraction shared `text`, `object` and `list` and deliberately left
`digest` alone, because its 112 copies are not one function. Measured in full:

| body | copies |
|---|---|
| `` `sha256:${…JSON.stringify(value)…}` `` | **82** |
| `` `sha256:${…canonical(value)…}` `` | **17** |
| `createHash(…JSON.stringify…).digest("hex")` (no prefix) | 3 |
| `` `sha256:${…value…}` `` for `value: string` | 3 |
| `typeof value === "string" ? value : JSON.stringify(value)` | 2 |
| `Number.parseInt(…)` returning a number | 1 |
| remainder | 4 |

`digestJson({a:1,b:2})` and `digestJson({b:2,a:1})` produce **different** digests;
the key-sorted variant produces the same one. Craft uses digests for content
addressing, so picking the wrong one silently changes a record's identity — and the
name `digest` does not say which it is. That is why the shared export is
`digestJson` and not `digest`, and why its 323 call sites were renamed rather than
aliased on import.

### `payload`: three spellings, one behaviour

73 copies in three shapes that differ only in destructuring binding names
(`...rest` versus `...value`, `_created` versus `_createdAt`). Behaviour is identical,
so all 73 are shared. `positive` was checked too: 4 copies in 4 genuinely different
signatures, so none are shared.

### Result

`src/digest.ts` exports `digestJson` and `payload`. **109 files edited, 155
definitions removed, 323 call sites renamed**, with 30 copies kept because their
bodies differ — including the key-sorted variants, whose `canonical` helper is itself
duplicated with differing definitions and needs its own decision.

### The rename hit Node's Hash method

`\bdigest\(` also matches `createHash("sha256").update(x).digest("hex")`: `.` and `d`
share a word boundary, so four call sites became `.digestJson("hex")`. `typecheck`
caught all four — `digestJson` does not exist on `Hash` — and they were restored. The
correct pattern excludes a preceding `.`. Nothing about the shared helper changed;
the selector was wrong.

### Verification

`typecheck` exit 0, `audit:layering` clean with the same single documented exemption —
`src/digest.ts` sits at the `src/` root (rank 1), which is safe only because no
`infrastructure/` module needs it, and the audit confirms no upward import appeared —
`lint` clean, `version:check` exit 0, and the full suite with the same 6 pre-existing
`spawn EPERM` failures and no new ones.

## v0.12.43 (continued) — the shared validators, extracted only where the bodies agreed

### What `layer-map.md` said, and what measuring showed

`layer-map.md` recorded the duplicated private helpers as the blocker for splitting
the version-stacked modules: *"these files share private validation helpers
(`text`/`list`/`digest`), and the copies' signatures are not identical, so the split
must begin by carefully extracting the helper rather than cutting along the export
surface."*

Measuring found the warning half right, and the half that differs decides what may
be shared:

| helper | copies | bodies that actually match |
|---|---|---|
| `object(value, name)` | 35 | **35** |
| `text(value, name)` | 131 | **122** |
| `list(value, name)` | 8 | **1** |
| `digest` | 112 | **0** — five distinct behaviours |
| `strings` / `integer` | 32 / 26 | 9 signatures each |

`src/validation.ts` now holds `text`, `object` and `list`, and **158 definitions were
removed from 129 files**.

### The nine `text` copies that differ are not spelling differences

- `parser-process.ts` returns the value **untrimmed**.
- `trajectory.ts` additionally runs a `SECRET.test` check.
- Six more do post-processing after the emptiness check.

They keep their own implementations. Sharing them would have changed validation, not
just layout.

### `digest` is deliberately not shared

112 copies across **five behaviours**: 73 use `JSON.stringify`, 21 hash the raw value,
16 use a key-sorted `canonical`, one returns a number via `parseInt`, one uses
`String(value)`. `canonical({a,b})` and `JSON.stringify({b,a})` produce different
digests for the same object, and Craft uses digests for content addressing — merging
these by name would silently change identity across the codebase. Sorting them out
needs its own decisions about naming (a stable digest versus a JSON digest), so it is
left to the kernel-split work rather than smuggled in with a mechanical extraction.

### Three bugs in the extraction, each caught by the next check

1. **Matching on signature alone removed a different contract.** `list` has eight
   copies with the mainstream signature but only one with the mainstream body;
   `verification-plane.ts` rejects an empty array where the others treat `undefined`
   as absent. Caught by a dry run, which reported one more `list` than expected. The
   script now compares normalized bodies and keeps anything that differs.
2. **A non-greedy `[\s\S]*?\}` stopped at the first brace — inside `${name}`.** These
   bodies contain template interpolations, so the match ended mid-body and every copy
   looked like a different contract. Requiring the closing brace to be followed by
   end-of-line skips the interpolation braces.
3. **An earlier verification reported a false "1 distinct body".** It sliced each
   body to 120 characters before printing, so the differences — all past that offset —
   were invisible. The conclusion that all 131 copies were identical was wrong, and
   only comparing full normalized bodies reversed it. This is the same failure the
   coverage gate had: a tool that truncates its own evidence.

### Verification

`typecheck` exit 0 (129 files with a rewritten import block), `audit:layering` clean
with the same single documented exemption — placing `src/validation.ts` at the `src/`
root is safe because no `infrastructure/` module defines or needs these helpers, which
was checked before the file was created — `lint` clean, `version:check` exit 0,
`audit:consistency` 9/9, and the full suite with the same 6 pre-existing
`spawn EPERM` failures and no new ones.

## v0.12.43 (continued) — the infrastructure primitives move into `infrastructure/`

### Three modules, 493 specifiers

`layer-map.md` and `audit-layering.ts` both recorded that `store.ts`, `paths.ts`
and `store-migrations.ts` are infrastructure implementations living at the `src/`
root, and that `infrastructure/index.ts` was exempt only because of it.

They cannot be moved with a string substitution. Each referrer sits at a different
depth, so `"./store.ts"`, `"../store.ts"`, `"../src/store.ts"` and
`"../../src/store.ts"` all name the same file and each needs a different
replacement. Every specifier is therefore resolved to an absolute path, compared
against the move list, and only then rewritten relative to the file containing it —
covering `import ... from`, `export ... from` and dynamic `import(...)` alike.

**323 files, 493 specifiers** for `store.ts` and `paths.ts`:

| scope | specifiers |
|---|---|
| `src/` | 196 |
| `tests/` | 293 |
| `scripts/` | 2 |
| `capability/` | 2 |

`typecheck` verified all 493. Two classes of specifier are outside its reach and
were caught by the audit instead.

### The move exposed a real layering inversion

`store.ts` imports `store-migrations.ts`. Moving only `store.ts` produced:

```
unexpected upward import: src/infrastructure/store.ts -> src/store-migrations.ts
```

`infrastructure/` ranks below the `src/` root, so a persistence module depending on
a root-level module is an inner layer importing an outer one. `store-migrations.ts`
exports `MIGRATIONS`, `applyMigrations` and `backupDatabase` — it is persistence, not
a domain kernel — so the fix was to move it down rather than add a fifth exemption.
It has three referrers.

### Two bugs in the relocation script, both caught before they shipped

1. **The module's own imports were rewritten against its old directory.** Running it
   turned `store.ts`'s `"./paths.ts"` into `"./infrastructure/paths.ts"` — resolving
   against where the file *was* while computing the path from where it *would be*.
   The rule is: resolve against the old directory, rewrite against the new one.
2. **The moved module's imports pointing at modules that stayed put were left
   alone.** `"./store-migrations.ts"` needed to become `"../store-migrations.ts"`, and
   the first version changed nothing.

Both surfaced as `TS2307` on the next `typecheck`, not as a silent wrong import.

### `infrastructure/index.ts` is no longer an exempt barrel

Its exemption existed for one stated reason: the primitives it re-exports lived at
the root, so a rank comparison read the barrel as importing upward while it was in
fact re-exporting its own implementation. With all three modules under
`infrastructure/`, the barrel imports its own layer and the exemption was **deleted**
rather than left to excuse a problem that no longer exists. `REEXPORT_BARRELS` is
down to the three genuine entrypoints: `src/service.ts`, `src/mcp.ts`,
`src/domains/index.ts`.

`src/` root went from 176 modules to 172.

### Verification

`typecheck` exit 0, `audit:layering` clean with 1 documented exemption (the
`canonical-tools` edge, unchanged), `version:check` exit 0, `lint` clean,
`audit:consistency` 9/9, and the full suite with the same 6 pre-existing
`spawn EPERM` failures and no new ones.

## v0.12.43 (continued) — the first layering move the audit itself prescribed

### The audit was already derivable; the earlier plan to "make it derivable" was wrong

A previous entry in this file proposed that `src/` could not be layered until
`audit-layering.ts`'s "hard-coded path list" was made derivable. Reading the script
showed that was false: it ranks files by **directory segment** (`RANK` keyed on the
first path component under `src/`), walks every `.ts` file, parses every relative
import, and compares ranks. Nothing is enumerated per file.

The five entries it does hard-code are `KNOWN_UPWARD` exemptions — known, dated
violations, each carrying the reason it exists — and the script reports an entry as
*stale* the moment its import stops occurring. That is the opposite of a list that
rots.

### The exemptions named their own fix

Four of the five were `service-foundation.ts` importing `application/coordinators/*`,
and the exemption text said exactly what to do:

> `service-foundation is imported only by application/craft-service.ts, so the module
> itself belongs in application/; that relocation removes all four coordinator edges
> at once.`

`docs/architecture/layer-map.md` recorded the same plan and noted it had "no
timetable". This change is that move.

`src/service-foundation.ts` → `src/application/service-foundation.ts`. It carried
131 relative imports, which split three ways and could not be rewritten by a single
rule:

| Specifier form | Count | Becomes | Why |
|---|---|---|---|
| sibling `./x.ts` | 126 | `../x.ts` | one level deeper |
| `./application/coordinators/x.ts` | 4 | `./coordinators/x.ts` | lands beside `coordinators/` |
| `./interfaces/canonical-tools.ts` | 1 | `../interfaces/...` | still upward |

An assertion in the move script rejected the naive `"./" → "../"` rewrite, which is
what surfaced the five nested specifiers in the first place — a blanket rewrite would
have produced `../application/coordinators/x.ts` and silently broken the module.

### Result

```
layer audit: 1 upward import(s) across 5 declared layers
  known: src/application/service-foundation.ts -> src/interfaces/canonical-tools.ts
layer audit: clean (1 documented exemption(s) outstanding)
```

Five exemptions became one, and the remaining one survives for a stated reason:
`interfaces/` still outranks `application/`, and `canonical-tools.ts` still needs the
tool table moved to a neutral module. The four coordinator entries were deleted
rather than left in place, because the audit fails on a stale exemption — it would
have caught them either way.

`layer-map.md` and the audit's own comment were updated in the same change, so the
documented count and the enforced count cannot disagree.

### Verification

`typecheck` exit 0, `audit:layering` clean, `version:check` exit 0, and the full
suite at **836 tests / 830 pass**, with the same 6 pre-existing `spawn EPERM`
failures and no new ones.

## v0.12.43 (continued) — scripts/ is grouped, and evaluation moves beside the other capabilities

### Six scripts that only checked what `check-version.ts` already checked

Six scripts carried a `v01233` in their name. Reading them rather than trusting the
name showed only two were genuine migrations; the other four were live checks whose
names merely recorded the release that added them — the same problem
`coverage-gates.json` complains about in its own header.

Worse, all six were redundant. `verify-v01233-manifests.mjs` hard-coded `0.12.33`
and compared thirteen files; `check-version.ts` derives the version from
`package.json` as the source of truth and checks the same twelve manifests **plus**
`src/service.ts`'s `VERSION`, the README release line, the adapter skill quotes, a
sibling marketplace checkout, and a guard that no source path carries a release
version. It is a strict superset, so all six were deleted and `check-version.ts` is
the one version-and-manifest check.

This is a deliberate loss and is recorded as one: the deleted set also included a
Studio endpoint audit, a Studio icon audit, and a `files` allow-list check. None was
referenced by `package.json` or CI, so all three were manual tools that had already
stopped being run. They can be rebuilt from their descriptions if wanted.

### `scripts/` is grouped by what the script does

```
scripts/ci/         test  lint  check-version  check-consistency-falsifiable  audit-layering
scripts/release/    pack-plugin  pack-adapters  package-desktop  check-plugin-package
                    generate-icon  windows-launcher.cs
scripts/coverage/   coverage-gates  coverage-gate-report  coverage-report
scripts/smoke/      plugin-smoke  plugin-component-smoke  plugin-full-smoke
scripts/            clean.ts  migrate.ts
```

`coverage-v01234-report.mjs` lost its version from the filename for the same reason
the others did.

### Two kinds of path broke, and only one was obvious

Eleven scripts computed the repository root as `resolve(import.meta.dirname, "..")`.
One directory deeper, that resolves to `scripts/` instead of the root — and because
most of these scripts have no test, a wrong root reads the wrong tree rather than
failing. Each was repointed, with an assertion that exactly one occurrence was
rewritten.

That was the obvious break. The second was the scripts' own `../src/...` imports,
which also needed one more level — six more rewrites across `check-consistency-falsifiable.ts`
and the three smoke scripts, plus the coverage test that follows its module into
`scripts/coverage/`. `typecheck` caught every one of these; the root calculations it
could not, which is why each repointed script was then **run**, not just compiled.

### `eval/` becomes `capability/craft-eval/`

Twenty imports were repointed from `"../src/` to `"../../src/`. It sits under
`capability/` so that the evaluation harness has a home beside the other capability
directories rather than at the repository root.

### Still open: `src/` remains 176 files deep in one directory

Not attempted here. `tsconfig.build.json` uses `rootDir: "."` and `outDir: "dist"`,
so moving a file inside `src/` changes the path of its built artefact — and
`package.json`'s `bin.craft` points at the literal `dist/src/cli.js` while
`audit-layering.ts` and `check-version.ts` both hard-code lists of `src/` paths as
strings, which `typecheck` cannot verify. It is a mechanical change with several
non-obvious couplings, and belongs in its own focused change rather than beside a
directory tidy-up.

## v0.12.43 (continued) — the evaluation scripts move to `eval/`, and the tree stops carrying build output

Three pieces of repository hygiene, found by auditing the evaluation scripts and
the Git index.

### One model configuration, not three

`scripts/eval-run.ts`, `scripts/eval-recurrence.ts` and `scripts/eval-suite-run.ts`
each declared the same provider, the same transport and an identical `ask()` —
twenty-four lines copied verbatim — and had already drifted: `supports_tools` was
`true` in two and `false` in the third. `ARITHMETIC` existed twice as well, once as
a case object and once as a separate `MAX_PASSED = "391"` constant beside a
repeated prompt literal.

They now share `eval/model.ts` (provider, transport, `ask`) and `eval/cases.ts`
(the tasks). `supports_tools` is unified to `true`, which is not a silent behaviour
change: `buildChatRequest` never reads the flag — it emits `tools` only when the
caller passes them, and no evaluation script does.

The credential is no longer embedded. The scripts injected a literal value for
`WORKBUDDY_API_KEY`, which overrode the transport's own lookup — and was itself a
string the project's secret detectors would flag. The transport already reads
`process.env` and already fails with *set WORKBUDDY_API_KEY before running Craft*,
so the configuration carries only the endpoint and the budget.

`eval/` sits beside `src/` rather than under `scripts/` because evaluation is a
first-class capability here — 18 kernels, a plugin and two skills — not an
undifferentiated dev tool next to `generate-icon` and the spent `bump-v01233-*`
migration scripts. It is typechecked via `tsconfig.json` and stays out of the
published build, which includes only `src/**` and `bin/**`.

### A missing credential was graded as four wrong answers

Wiring the shared transport exposed a real defect. With no `WORKBUDDY_API_KEY`,
`eval/run.ts` printed `FAIL` for every case with an empty answer, reported
`score: 0/4`, and **exited 0** — the transport's *not configured* error was caught
by each case's `try/catch` and graded as a wrong answer. A run that never reached a
model reported a model that answered everything wrong.

`requireEvaluationCredential()` now runs before the first case and fails loudly with
a non-zero exit. This is the same mistake the coverage gates and the evaluation
suite each had to be taught not to make: **an environment failure wearing a
capability failure's clothes.**

### Still open: an unreachable endpoint is reported two different ways

Not fixed, and reported here rather than silently. Under one condition — endpoint
unreachable — the two scripts now disagree:

- `eval/suite.ts` records the model cases as `inconclusive` and excludes them from
  every denominator. Correct.
- `eval/run.ts` records `FAIL` for each case and then feeds those failures to the
  abstraction pass, which produced `abstractions: 1 sufficient_evidence=true` — a
  lesson generalised from an outage rather than from a model defect.

The second is the more damaging of the two: it manufactures a durable artefact out
of an infrastructure failure. Deciding the right shape (distinguish transport
errors from wrong answers, and skip abstraction when the cause is transport) is a
design choice, so it is left for a separate change.

### Build output no longer lives in Git

`/dist/` was ignored at the repository root, but `plugins/*/dist/` was not. Ten
tracked files totalled **21.53 MB**, and eight of them were byte-identical
(`DB48354BBC329F41`) because `scripts/pack-plugin.ts` copies `dist/plugin/craft-mcp.cjs`
into every component plugin. Eight tracked `SKILL.md` files were the same kind of
copy of `skills/<name>`.

`.gitignore` now covers `/plugins/*/dist/` and `/plugins/*/skills/`, and the 18
derived files are removed from the index with `git rm --cached` — the working tree
keeps them, because a plugin needs them at runtime. Plugin metadata
(`.mcp.json`, `.codex-plugin/plugin.json`) stays tracked.

### Credential patterns were not ignored either

`.gitignore` had no credential rules at all. Craft can import a desktop credential
file, so a stray `.env` or key in the working tree is a realistic accident, and the
detectors in `src/federation.ts` and `src/materialization.ts` only run on specific
data paths — they are not a pre-commit gate. `.env`, `*.pem`, `*.key`, `*.p12`,
`*.pfx`, `.npmrc`, `.netrc` and common credential file names are now ignored.

An audit found no leaked credential in the working tree or in any of the 162
commits. The `PRIVATE KEY` hits in history are the detectors' own pattern strings,
and the `AKIA` hits are a byte sequence inside a `node.exe` that was once packaged
under `dist/`.

## v0.12.43 (continued) — the gate read the wrong column, and the value ledger was never empty

Two defects found while auditing the coverage gates and the evaluation ledger.
Both were in the measurement layer, and both had the same shape as the ones they
were found alongside: **a number that looked like a result about the code was
actually a result about the instrument.**

### The coverage gate compared the branch column against the function threshold

`scripts/coverage-gates.ts` read Node's table as if the columns were
`line | funcs | branch`. They are `line | branch | funcs`, so the shortfall check
did this:

```js
if (Number(match[2]) < lines || Number(match[3]) < functions) return true;  // match[3] is branch
return group.branches && Number(match[4]) < branches;                       // match[4] is funcs
```

All three thresholds are 100, so for a `branches: true` group the swap was
invisible — the same rows were flagged either way. For a `branches: false` group
it was not: a genuine **function** shortfall went unreported, while an **ungated
branch** gap was printed as a coverage failure. The real consequence is that a
`spawn EPERM` test failure in such a group was reported as a missing test, which
sends someone to write a test for code that was never executed.

The gate's PASS/FAIL verdict was never affected — that is Node's exit code, using
the correct columns. Only the explanation was wrong, which is the part a human
reads and does not re-derive.

The parsing now lives in `scripts/coverage-gate-report.ts`, a tested pure module,
and `tests/coverage-gate-report.test.ts` pins the column order against a verbatim
copy of Node's header and rows. A swap can no longer satisfy the fixture because
the fixture's columns hold different numbers. It lives in `scripts/` rather than
`src/` because `tsconfig.build.json` includes only `src/**` and `bin/**`: this is a
development instrument and must not ship. It is still typechecked and still gated,
via a new `coverage-gate-report` group in `tests/coverage-gates.json`.

### A blocked spawn was reported as a coverage gap

`detectEnvironmentBlocker` names a condition that stopped the run rather than a
shortfall in the code. The two produce the same red gate and demand opposite
responses — "write a test" versus "run this where child processes are permitted" —
so the environment cause is printed first and the shortfall list is suppressed
when nothing actually fell below a threshold.

Two further defects surfaced only by running the gate in a sandbox that denies
child processes, which is the case the change exists for:

1. **The failure arrives on the error object, not in the output.** `EPERM` is set
   on `result.error`, so stdout and stderr are empty and a detector reading only
   the output sees nothing. The earlier code then hit `throw result.error` and the
   whole script died with a stack trace on the first group, so the state of the
   other twenty-seven was never reported. The script now handles both a returned
   `error` and a throwing spawn, names the block, and continues. Measured: 28 groups
   reported instead of one stack trace.

2. **The real message is not `spawn EPERM`.** It is
   `Error: spawnSync <absolute node path> EPERM` — the executable sits between the
   call name and the errno, so the original pattern missed it and the friendly
   reason was never printed. The regression test now uses the verbatim message
   rather than a tidied one; a fixture written to match the pattern instead of the
   system is how the gap survived the first test.

### `governance` was filed under `value`, and `value` was never meant to hold it

`AXIS_LEDGER` assigned `governance` and `end_to_end` to the `value` ledger on the
grounds that they observe model behaviour rather than kernel return values. That
conflates **the kind of evidence** with **the question the measurement answers**.

Compliance is not value. A system can refuse every forbidden action and still be
irrelevant, cold, or confusing to the person using it. An end-to-end case asserting
that a task was graded correctly, or that the loop refuses a self-report, is loop
integrity — also not value. So filing them under `value` meant that once the model
endpoint returned, a compliance case would become the only observed `value` case,
`sufficient_evidence` would flip true, and `quotable` would license a value claim
nothing had measured. That is the overclaim the ledgers exist to prevent, moved one
level down.

There are now three ledgers:

- **capability** — can the system do it: memory, knowledge, workflow, end_to_end.
- **safety** — does the model obey a stated rule: governance.
- **value** — does it help the person: **no axis, by design.**

`value` is deliberately empty rather than satisfied by relabelling. Craft measures
no relevance, understanding or naturalness dimension yet, and an empty ledger with
`sufficient_evidence: false` is a true statement: it keeps `quotable` false even
when the model is reachable, which is the honest state rather than a defect.

The `defineEvalCase` rule was widened with it: previously only a `value`-ledger
case had to observe model output, and since `value` now has no axis, that rule had
become unreachable. Any ledger other than `capability` makes a behavioural claim,
so all of them now require `model_output` evidence.

Evidence kind and ledger are independent and must not be conflated in either
direction: a `capability` case may legitimately drive a model (an end-to-end task
does), while a `safety` or `value` case may never be graded from a synthetic input.

### Tests

`tests/coverage-gate-report.test.ts` (8 tests) and `tests/eval-suite.test.ts`
(11 tests) at 100% line, branch and function coverage. One test constructs a suite
whose `value` ledger is observed — an input `defineEvalSuite` cannot currently
produce, since no axis maps to `value`. It exists because the summariser must work
the moment a real value case is added, and without it that path would be silently
unreachable and never exercised.

## v0.12.43 (continued) — the suite was reporting a number it had not earned

A review of this suite against a real product postmortem found three defects in
its measurement design. All three were in the reporting layer, not the cases, and
all three had the same shape: **a component result standing in for a product
result.**

### The headline hid that nothing was observed

`summarizeSuiteRun` returned `score: `${pass}/${pass + fail}`` over every axis. In
the run before this change it printed:

```
score: 13/13   (passed 13, failed 0, inconclusive 3)
```

16 cases, 3 of which never ran, and **all 3 of the cases that touched the model
were among the unobserved**. The 13 that passed were kernel checks: BM25 ranking,
decay weights, relation intervals, step approval. So the report said `13/13`
while **no model output had been evaluated at all** — and `13/13` was the first
line a reader saw.

The same string had appeared in an earlier run with 15 cases and 2 inconclusive.
Identical headline, different evidence. A score that does not move when the suite
grows by one unrun case is not a score.

### The two ledgers were summed

`memory`, `knowledge` and `workflow` measure whether the machinery works.
`governance` and `end_to_end` measure whether the model behaves. Those answer
different questions, and `pass / (pass + fail)` added them together.

The fix is structural rather than a caveat:

- **There is no top-level `score`.** Each ledger reports its own, and they are
  never combined. A number that would conflate them does not exist to be quoted.
- **`model_observations` is counted, not described.** Zero means nothing about real
  output was measured, whatever the capability score says.
- **`quotable` is a pre-committed line.** A headline may only be quoted once both
  ledgers have at least one observation. When one is silent, `quotable` is false
  and `quotable_reason` names which ledger is missing — declared in advance so it
  cannot be relaxed at the moment the numbers look good.
- **An absent measurement is `null`, never `0/0`.** A ledger with no observation
  reports `sufficient_evidence: false`, because "we did not measure this" and "we
  measured zero" are different facts.

The same run now reads:

```
Ledger 1 — System Capability   score: 11/11   (observed 11, failed 0, inconclusive 0)
Ledger 2 — User Value          score: NO OBSERVATION   (observed 0, failed 0, inconclusive 3)
model observations: 0
quotable: false — no headline may be quoted: value ledger has no observation
```

That is a worse-looking and much more truthful report.

### Two end-to-end cases were unit tests

`e2e.failure_is_attributed` and `e2e.refuses_to_generalise_one_failure` fed
hand-written observations into the v01238 and v01237 kernels — a fixed
`{ answer_wrong_with_full_context: true }` and a fixed one-trajectory list. They
were unit tests wearing an end-to-end label, and they made that axis report
`observed 2, passed 2` **without observing any end-to-end behaviour**. The axis
was green because it was not measuring what its name claimed.

Both were removed. Their subject matter is already covered at 100% by the v01237
and v01238 unit tests, so nothing is lost and the axis now contains only cases
that observe a model.

To stop it coming back, every case must now declare `evidence`: `kernel` for a
case graded from a Craft function's return value, `model_output` for one graded
from a real model's output. There is no default. And the ledger rule is enforced:
**a value-ledger case must be `model_output`**, because a case graded from a
synthetic input cannot report on how the system behaves.

### A new failure class: `echo_gap`

The same review supplied the case craft's taxonomy could not name: a system whose
"memory use" was really the current turn being repeated back. The answer looks
fine, so nothing else in the taxonomy fires — `synthesis_gap` requires a wrong
answer, `retrieval_gap` requires a failed retrieval, and neither is true.

`echo_gap` is now checked **first**, ahead of `coverage_gap`. The ordering is the
point: if the evidence is circular, every downstream conclusion about retrieval
and grounding is uninterpretable, so naming a pipeline stage would describe a
stage that never legitimately ran. The signal is
`evidence_already_in_input`, and its remedy says plainly that the turn
demonstrates echoing, not recall.

Craft already rejected contamination in two other places — v01237 refuses reused
`trace_id`s, v01239 refuses to treat an unchecked claim as confirmed. It could
still record a current-turn echo as a successful memory use. It no longer can.

### Tests

`v01242`/`v01243`: 10 tests at 100% line, branch and function coverage, including
the category-error rejection, the absence of a top-level score, and the
quotability gate in both directions. `v01238`: 10 tests at 100% including
`echo_gap` priority over every other signal.

## v0.12.43 — held-out evaluation suite

The first measurement of Craft that can be quoted without overclaiming.

### Three rules that make the numbers mean something

1. **Deterministic grading only.** Every case is decided from bytes by the
   v0.12.36 sensor vocabulary. No case asks the model to judge its own output, and
   there is no LLM judge, because neither is reproducible.
2. **`inconclusive` is never a pass.** A case that could not run is excluded from
   the numerator *and* the denominator, and reported at equal volume — the same
   discipline the verification sensor applies to `blocked`.
3. **The denominator travels with the score.** `score` is an exact fraction
   (`13/13`), and `total_cases` is always present, so `3/4` can never be quoted as
   "75% ability".

### Reusing the existing contract instead of inventing one

The project already had `delivery_evaluation_case` with a `held_out` partition, a
sanitized requirement, and independent approval, plus `EvalCampaignKernel` over
it. That campaign is built for A/B comparison, so it needs a baseline and a
candidate arm and cannot answer "how good is this build on its own". Rather than
build a second incompatible mechanism, the suite reuses the same *contract* —
held-out, sanitized, approved, content-addressed, no promotion authority — for
absolute measurement. The suite digest covers the case definitions, so editing a
case changes the identity and two runs cannot be compared while measuring
different things.

### Five axes

| Axis | Cases | What it measures |
|---|---|---|
| memory | 4 | decay ordering, superseded facts losing, scope isolation, capture threshold |
| knowledge | 4 | identifier hit, term rarity, `supersedes` traversal, closed validity interval |
| workflow | 3 | real step execution, side-effect approval gate, per-step failure reporting |
| governance | 1 | whether a stated prohibition is actually obeyed (needs the model) |
| end_to_end | 4 | closed loop: observation → attribution → capture → refusal to over-generalise |

The memory, knowledge and workflow cases measure Craft's own mechanisms and call
no model, so a model cannot take credit for work it did not do.

### Result of the first run

**13/13 across 16 cases**, with 3 recorded `inconclusive`:

```
memory       observed 4  passed 4  failed 0  inconclusive 0
knowledge    observed 4  passed 4  failed 0  inconclusive 0
workflow     observed 3  passed 3  failed 0  inconclusive 0
governance   observed 0  passed 0  failed 0  inconclusive 1
end_to_end   observed 2  passed 2  failed 0  inconclusive 2
```

The three inconclusive cases need the local model endpoint, which went down
mid-session. Recording them honestly is the point: the suite distinguishes "the
model was unreachable" from "Craft's mechanism is broken", and an outage does not
become a capability finding. This is a deliberate demonstration of rule 2 rather
than a gap.

### What the suite found by being run

Writing it against real contracts surfaced four places where my assumptions were
wrong, each caught by execution rather than reading:

- `neighbors` **resolves the far endpoint record and silently drops an edge whose
  record is missing**, so a relation between bare ids is invisible. The cases now
  create real claims.
- `knowledgeClaimSave` requires at least one real Evidence record — an empty
  `evidence_ids` array is rejected.
- Workflow steps use `type` (values `command`, `assertion`, `coverage_gate`), not
  `kind`, and `command` spawns a process the sandbox denies, so the cases use
  `assertion`, whose evaluators read the filesystem directly.
- `retract` defaults `valid_to` to now, leaving no queryable window, so the
  closed-interval case states an explicit window and queries inside and outside it.

Two of these were bugs **in my own eval code**, not in Craft, which is the
expected cost of testing something against its real interface.

### One flaw removed before shipping

The governance axis first had a control case asserting that the *unpinned* model
complies. That would have counted a governance failure as a pass and let
misbehaviour raise the score. It was removed: a control belongs in a decay
measurement that compares two conditions, not in a pass/fail suite.

### Script

`scripts/eval-suite-run.ts` drives the suite against the live endpoint and
prints the per-axis and per-case breakdown. It reports
`comparable_to_published_benchmarks: false` and states the denominator next to
every rate. This measures one model on one endpoint in one environment; it is not
an industry conclusion and is not comparable to the multi-model published
benchmarks cited in the research notes.

## v0.12.42 — evaluation suite kernel

`defineEvalCase`, `defineEvalSuite`, `gradeCase`, `summarizeSuiteRun`, plus the
case catalogue in `eval-cases.ts` and the runner in
`scripts/eval-suite-run.ts`. See v0.12.43 above for the results and the contract
it reuses. 7 tests at 100% line, branch and function coverage across both files.

## v0.12.41 — MCP 2026-07-28 forward compatibility

### What this is, precisely

The 2026-07-28 revision is not a version bump. The official changelog lists nine
major changes: it removes the `initialize` handshake, makes the protocol stateless
with per-request `_meta`, mandates `server/discover`, requires `resultType` on
every result, removes `ping`, `logging/setLevel`, `resources/subscribe` and SSE
resumability, moves Tasks into an extension, and replaces server-initiated
requests with Multi Round-Trip Requests. Craft cannot adopt that opaquely: its
human approval flow and durable long-task model sit exactly where MRTR and the
Tasks extension now live.

So this change does **not** claim compliance. It implements the two changes that
are safe while still speaking 2025-11-25, and records the rest as deliberate,
checkable debt.

### Implemented (both strictly additive)

- **`server/discover`** — mandated with MUST by the new revision, and harmless on
  every earlier one, so a newer client gets an honest answer instead of
  `Method not found`. `discoverResult` reports the revisions actually spoken, and
  separately the assessed revision and migration state, so a client cannot infer
  support from the fact that this build knows the revision exists.
- **`_meta` tolerance** — a peer sending 2026-07-28 per-request keys is served
  rather than rejected, and unknown `io.modelcontextprotocol/*` keys are reported
  rather than silently discarded. Keys outside that namespace are not treated as
  protocol drift.

### Deliberately not done

`initialize` removal, `_meta` statelessness, MRTR, and the Tasks extension
mapping. Each is recorded with its reason in `MCP_REVISION_REQUIREMENTS`, and
`forwardCompatibility()` returns `compliant_with_target: false` with the remaining
list. The point of the honesty is that `assessMcpMigration` already blocks on
`host_supports_mrtr` and tasks-extension mapping — this makes the same judgement
machine-readable instead of leaving it in prose.

Two smaller decisions, both recorded rather than left implicit:

- **`ping` is retained.** It belongs to every revision this build speaks, and
  2026-07-28 removed it only for the revision this build does *not* speak.
  `pingPolicy` makes retention conditional with a stated removal condition, so a
  future migration cannot rediscover the question by accident.
- **`resultType` is NOT emitted.** The revision requires it, but this build speaks
  2025-11-25 and the spec says a client MUST read an absent field as `"complete"`.
  Emitting it now would be exactly the premature declaration this project keeps
  catching. `outboundResult` documents the omission and the correct reading.

### Guarded by G8

Three declarations were added to `mcpDeclarations()` — `server/discover` is
implemented, no `resultType` is emitted, and the build is not claiming
compliance — so the readiness report cannot drift into a compliance claim. The
falsifiability check was extended to **9/9 mutations caught**, including "the build
starts claiming compliance".

7 tests at 100% line, branch and function coverage.

## v0.12.40 — governance pinning (G2)

### The gap

`ReversibleContext.project()` selects segments purely by weight, so a governance
constraint competes for the token budget against the active task state — and a
constraint is old, off-topic, and low-salience next to the current sub-goal. That
is the mechanism the Governance Decay work measures: compaction raises the
violation rate from 0% to 30% (up to 59%), because compaction is engineered for
task continuity and treats standing policy as evictable content.

Craft is exposed on exactly the channels that work finds vulnerable. Its threat
model explicitly excludes the system message — frameworks that preserve it
"simply protect one channel while leaving memory and conversation-carried
governance exposed" — and `agent-loop.ts` has no system channel at all, so
governance necessarily arrives through memory, tool output, or a user turn: the
three channels measured at +45, +33 and +50 points of decay, against +0 for a
preserved system message.

### The fix is structural, not a better summary

`compactionPlan` takes constraints **out of the eviction competition entirely**.
The pinned block is carved off first, the remaining segments are projected as
before, and the pinned text is re-injected on top, so the result is bounded by
`maxTokens + pinTokens` and cannot drop a rule at any budget. A test drives the
budget down to one token and the constraint still survives, because it never
enters the loop that decides eviction.

Design rule inherited from `agent-loop.ts`: a guard must be an explicit ceiling
owned by Craft, never a prompt instruction the model could reinterpret.

### Integrity is checked by content, not presence

`verifyPinIntact` distinguishes `dropped` from `reworded`: a constraint whose id
is still quoted but whose statement has changed is not the rule that was pinned.
A naive id check would pass it, and the digest would then be lying.

### Refusing to protect an undeclared rule

A segment that *looks* like a constraint but was never declared stays evictable,
and a declared constraint with no matching segment is reported as
`unbound_constraints` rather than quietly treated as satisfied. Auto-pinning
either one would protect a policy nobody declared.

### Tiering

`craft_governance_pin_get`, `craft_governance_pin_check` and
`craft_governance_compaction_evaluate` are `read` and mounted, so the loop can
verify its own guardrail. `craft_governance_constraint_define` is deliberately
`governed` and **not** mounted: a guard the loop can redefine is not a guard. The
tests assert the tier rather than trusting the name.

9 tests at 100% line, branch and function coverage.

## v0.12.39

Declaration/implementation consistency (G8).

Every defect the v0.12.38 live run found had one shape: a claim disagreed with the
code, and nothing compared them. `MCP_ASSESSED_REVISION` recorded that this build
had assessed 2026-07-28 while the handler still whitelisted only the three older
revisions and still implemented `ping`, which 2026-07-28 removed.
`buildChatRequest` promised an `authorization` header and emitted template source
text. A test asserted the wrong value and locked it in place.

The lesson is not "be careful" — it is that a claim and its implementation drift
apart silently, because nothing in the build forces them to agree. So the
declarations are now *data* with a named falsifying fact, and the comparison is
mechanical.

### `unverifiable` is not `confirmed`

Each claim resolves to `confirmed`, `contradicted`, or `unverifiable`. A claim
whose expected facts are absent from the observation is `unverifiable` — never
`confirmed`. That distinction is the whole module: the MCP contradiction survived
because an unchecked declaration was read as a true one, and collapsing "I could
not check this" into "this is fine" is exactly how it happened. Only
contradictions make a build inconsistent; honest unknowns are reported at equal
volume but do not fail it.

### The checker had the bug it exists to catch

The first version of `observeMcpFacts` returned the runtime constant as the
handler's advertised set, so `mcp.advertised_versions` compared a value against
itself and **could never fire**. A check that passes because it never looks at the
thing it claims to check is worse than no check, since it manufactures confidence.

`scripts/check-consistency-falsifiable.ts` now mutates each fact in turn and
requires the check to notice: **6/6 mutations caught**, including a handler
advertising the assessed revision, a handler dropping a declared version, and a
mounted tool escaping classification.

### A claim was corrected, not the code

`mcp.no_removed_methods` asserted that the server does not implement methods
2026-07-28 removed. That failed immediately — `ping` is implemented. But `ping` is
*correct* while speaking 2025-11-25, so the declaration was wrong, not the code.
It is now `mcp.removed_methods_acknowledged`: the gap is recorded and deliberate.
This is the difference between a declaration and an aspiration, and the check
drawing that line on itself is the point. The test asserts the corrected claim
*and* that the aspirational version is still caught, so it cannot be softened back.

### Wiring

`craft_consistency_check` and `craft_mcp_declarations_get` are `read` and mounted
on the internal loop, so the agent can check a claim against the implementation
instead of trusting the claim.

### Tests

`tests/declaration-consistency.test.ts` — 8 tests at 100% line, branch and function
coverage, including a self-check that reads the shipping source files rather than
a copy, and every verdict path.

## v0.12.38 (continued) — first run against a live model

A working local endpoint (`http://127.0.0.1:8000/v1`, OpenAI protocol) made it
possible to run Craft's real transport against a real model for the first time.
Two defects surfaced that no amount of reading had caught, and both were the kind
only execution finds.

### A credential header that announced itself

`buildChatRequest` set `authorization` to a template with a doubled dollar sign,
emitting the literal string `Bearer $WORKBUDDY_API_KEY` — the un-interpolated
source text. It was wrong in the worst way: valid-looking, so nothing rejected
it, while the transport happened to rebuild its own headers and masked the
result. Anyone reading the built request would see what appeared to be a
credential that was not one.

Two things kept it alive, and both are instructive:

- **A test asserted the bug.** `model-gateway.test.ts` pinned
  `"Bearer $DEMO_API_KEY"` as the expected value, so the suite protected the
  defect instead of catching it. The assertion now encodes the real contract —
  `env:DEMO_API_KEY`, naming the variable rather than a value — and a new check
  rejects any header matching `Bearer <token>` in either wire format.
- **Nothing compared the header to what the transport sends.** The fix is
  verified against the live endpoint, not just the unit suite.

### Abstraction could never see recurrence across tasks

Running v0.12.37 against real model output exposed a contract hole in the
signature. Checks are naturally named per task — `rev-1:exact`, `rev-2:exact` —
and as raw strings those never match, so a failure repeating across independent
tasks was invisible and the evidence floor could never be met. The grouping was
correct and unreachable at the same time.

`trajectoryFailureSignature` now reduces each name to the check's own identity by
stripping the task-specific prefix, so `rev-1:exact` and `rev-2:exact` both yield
`exact` and group — while `exact_sum` correctly stays separate. Verified live:
three distinct tasks sharing a failure signature now produce one abstraction,
with the unrelated failure reported as a named near-miss.

### What the live runs actually showed

On four deterministic cases the model scored 3/4, failing only
`reverse('craft')` → `tfarC` (a case-folding slip). On three character-counting
tasks it scored 3/3.

The important result is the negative one. `abstractAcrossTrajectories` returned
**zero abstractions** with `sufficient_evidence: false` for those runs, and that
is the mechanism working: one isolated failure, on one task, is not a pattern,
and inventing one would have been the failure mode the evidence floor exists to
prevent. A learning system that reports "nothing to learn" when nothing recurred
is behaving correctly; a scoreboard that only counts lessons produced would have
hidden this.

The full chain ran end to end on live output: v0.12.36 observed the failure from
bytes, v0.12.38 attributed it to `synthesis_gap` (evidence complete, answer still
wrong), and v0.12.34 captured it as a `correction` with `requires_review`.

Scripts: `scripts/eval-run.ts`, `eval-recurrence.ts`, `eval-abstraction.ts`.

## v0.12.38

Failure attribution (G3).

v0.12.36 gave the harness a way to observe that it had failed. It could not say
*why*. Every failure was a single undifferentiated fact, so a lesson drawn from
one could not be checked against the cause it claimed — and a lesson with an
unverified cause is indistinguishable from a superstition.

The taxonomy is taken from the Eywa memory report (2026), whose central argument
is that a single end-to-end score cannot tell which layer failed: a wrong answer
may come from missing evidence, unsupported extraction, stale state, retrieval
loss, or the answer model itself. Each needs a different fix.

### Derived from observations, never asserted

`attributeFailure` accepts eight observed signals and returns one of: coverage,
grounding, revision, scope, temporal, retrieval, synthesis, or `unattributed`.

The rule that shapes the module: **a guessed cause is worse than an admitted
gap.** A wrong cause produces a confident, useless, and permanently repeated
lesson, so the function names a cause only when the observations support it and
otherwise says `unattributed`. Two distinctions carry that:

- **`null` is not `false`.** `null` means "not observed"; `false` means "observed,
  and it was not the case". An unobserved signal can never justify a conclusion,
  and `wrong_scope_applied: false` is evidence rather than silence.
- **Diagnostic priority follows the pipeline, not severity.** A fact absent from
  the source cannot also have been mis-scoped, so `coverage_gap` is checked
  first. Naming the downstream cause would send the fix to the wrong layer, which
  defeats the entire purpose of having a taxonomy.

Revision is checked before retrieval on purpose: recalling the right fact and
then ignoring that it had been superseded is a revision failure, not a search
failure. Likewise `answer_in_context: false` is classed as retrieval rather than
grounding — the fact was found and then dropped between retrieval and context, so
the fix is the budget or the eviction order, not extraction.

### Where the system is weakest

`summarizeAttributions` answers the different question of what to fix first. It
ranks classes by count, reports `unattributed_count` rather than hiding it (a
falling attribution rate means observability is degrading, which is itself a
finding), and sets `primary` to the top **named** class — `unattributed` is never
a fix target, so an all-unattributed run reports `primary: null` instead of
pointing at ignorance.

### Wiring

`craft_failure_attribution_get` and `craft_failure_attribution_summary_get` are
`read`, mounted on the internal loop, and dispatched through the real service, so
the loop can diagnose its own failures. The name matters: a bare `_attribute`
suffix matches no verb in the classifier and silently falls through to
`governed`, which would leave the loop unable to reach its own diagnostic — the
tests assert the tier rather than trusting the name.

The full chain is now closed end to end: v0.12.36 observes the failure, v0.12.38
names its cause, and v0.12.37 generalises it across independent trajectories.

### Tests

`tests/failure-attribution.test.ts` — 9 tests at 100% line, branch and function
coverage, including every class, every priority ordering, the `null` versus
`false` distinction, and an end-to-end MCP run.

## v0.12.37

Cross-trajectory abstraction (G1).

Two independent sources pointed at the same missing capability. The ACL 2026
survey *From Storage to Experience* formalises agent memory as three stages —
Storage, Reflection, Experience — and names cross-trajectory abstraction as the
frontier mechanism. Mem0's 2026 memory report independently lists "temporal
abstraction at scale" among its three hardest open problems. Craft had Storage
and Reflection, and none of Experience.

### The gap, precisely

`decideExperienceCapture` scored one run's outcome, retries and corrections, and
`buildExperienceRecord` produced one record per run. Nothing ever looked *across*
runs. So Craft could record that a run went badly, but never that twelve runs
went badly the *same* way. A per-run lesson only helps the run that produced it;
the entire value of memory is that the thirteenth attempt starts smarter than the
first.

### Deserving to generalise

The hard part is not clustering, it is earning the right to generalise. An
over-eager abstraction is indistinguishable from a confident hallucination, and
it would poison every future run that trusts it. Three rules enforce restraint:

- **Recurrence must be independent.** A signature is refused unless it appears in
  two or more distinct traces spanning **two or more distinct tasks**. The same
  task retried twice inside one trace is one story told twice, not a pattern —
  and treating it as one is exactly how a broken loop convinces itself it has
  learned something. Replayed trace ids are rejected outright, since that is the
  one way to fake recurrence.
- **Generalisation happens over a deterministic signature, never over prose.**
  The signature is the sorted set of failed check names, so two runs group only
  when they failed the *same* checks by a rule anyone can re-run. Order
  independence matters: the same failure reported in a different sequence is
  still the same failure.
- **Below the floor, the answer is no abstraction, not a weaker one.** Refusals
  are returned with their reason and counts, so abstention is checkable rather
  than trust-based. `sufficient_evidence` is reported explicitly so silence is
  never mistaken for "nothing recurred" when it actually meant "nothing was
  examined".

### What an abstraction is

A candidate, never a published lesson. `buildAbstraction` always sets
`requires_review: true` and `execution_authority: false` — generalising is a
claim about the future drawn from the past, and Craft's whole posture is that
such a claim is proposed, not asserted. The statement is generated from the
evidence ("`tests` failed across 2 independent trajectories spanning 2 task(s)"),
so it cannot overclaim, and it carries the exact trace ids that justify it. A
signature with no check names produces an explicitly unnamed statement rather
than inventing names it was never given.

### Tiering

`craft_trajectory_signature_get` and `craft_abstraction_evaluate` classify as
`read` and are on the internal loop surface, so the loop can notice recurrence
itself. `craft_abstraction_build` is deliberately `governed` and **not** mounted:
the loop may observe a pattern, but minting an abstraction is a claim about the
future that needs review. The tests assert this asymmetry rather than leaving it
to naming convention.

### Tests

`tests/trajectory-abstraction.test.ts` — 9 tests at 100% line, branch and function
coverage, including the refusal paths (single-task recurrence, insufficient
occurrences, falsified recurrence via replayed trace ids) and an end-to-end MCP
run.

## v0.12.36

The deterministic verification sensor (V1).

An external review of the harness literature (Cycode, LangChain, 2026-09) prompted
a check of a claim Craft had been making implicitly: that its self-evolution loop
learns from failure. It did not. `decideExperienceCapture` weights a failure at 30
points, but the failure itself was always supplied by the caller as `outcome`. The
loop could be *told* it failed; it could never *observe* that it had. So its
`failure` weight was waiting for a signal that never arrived on its own.

### A sensor, not another record

Craft already had verification *records* (evidence, signoffs, held-out
evaluations), and they are strong. What it lacked was a verification *sensor*: a
way for the harness to decide, without a human or a model, whether the work it
just did was correct. That distinction is the whole point of the harness layer —
and it is why a passing test suite matters more than a detailed test report.

### Every check is deterministic, or reports that it is not

`evaluateVerificationCheck` supports five kinds, each decidable from bytes:
`exit_code`, `output_contains`, `output_matches`, `file_digest`, `file_absent`.

There is deliberately no LLM judge and no path where the agent's own claim of
success counts as evidence. Three design decisions follow from that:

- **`blocked` is not `failed`.** A check whose observation is missing never
  counts as a failure. A loop that treats "I could not verify this" as "this
  broke" fills its experience store with lessons drawn from ignorance.
- **`inconclusive` is its own verdict** for the same reason: "we could not tell"
  and "we know it broke" must drive different learning.
- **A broken check is blocked, not failed.** A regular expression that does not
  compile is a defect in the check, not in the work — failing the task for it
  would blame the wrong thing.

Combination is conservative and order-independent: any `failed` fails the plan,
otherwise any `blocked` blocks it, otherwise any `inconclusive`, otherwise it
passes. One real contradiction outweighs any number of passes.

### Closing the loop

`verificationCaptureSignals` is the wiring: it maps a sensor verdict onto the
`outcome` that `decideExperienceCapture` already scores, so a deterministically
observed failure produces a captured lesson with no human and no model input.

- A single failed check clears the capture threshold on its own (30 + 26 = 56
  against a threshold of 25), so the loop cannot miss a real regression.
- `blocked` and `inconclusive` map to `abandoned`, not `failed`, because the
  capture vocabulary is `succeeded|failed|abandoned` and an unverifiable run is
  not a demonstrated mistake. The real verdict survives in `verification_verdict`.

### Wiring, and why the names are what they are

The tool-authorization classifier reads the **last segment** of a tool name, and
treats any `_run` or `_propose` suffix as `governed` — a tier the internal loop
cannot mount. Naming the entry point `craft_verification_run` would therefore have
produced a sensor the loop is forbidden to call, reproducing exactly the wiring
gap this version exists to close. Hence `craft_verification_evaluate` and
`craft_verification_signals_get`, both of which classify as `read` and are
asserted to be in a mounted tier by the tests.

The `read` tier is honest here rather than merely convenient: the sensor is a
pure function over facts the caller already observed. It executes no command,
opens no file, and reaches no network. A test asserts that no observed content
survives into the result — only a digest and a reason code — so a sensor result is
safe to record even when the output it inspected contained a secret.

### The loop can now verify its own work

`verification_evaluate` and `verification_signals_get` are on the internal loop
surface and dispatched through the real service, so the failure signal originates
inside the loop.

### Tests

`tests/verification-sensor.test.ts` — 11 tests at 100% line, branch and function
coverage, including an end-to-end run where a deterministically observed failure
becomes a captured lesson over MCP with no `outcome` supplied by anyone.

Craft did not keep a changelog before v0.12.33. Git tags stopped at `v0.12.10`
while `package.json` reached `0.12.30`, so twenty releases existed only as commit
messages. This file starts at the version where that stopped, and v0.12.33 also
adds the cross-repository version check that makes silent drift fail a build.

## v0.12.35

Wiring the memory substrate into the agent loop.

An external assessment argued that Craft's memory, knowledge and self-evolution
substrate is complete but nothing flows into the running loop. Verification found
that claim **partly right and partly wrong**:

- The claim that `cli.ts` hardcodes `knowledge_refs: []` is **wrong**.
  `resolveStandaloneContext` (cli.ts:245) already calls
  `contextResolutionResolve`, searches knowledge and emits `memory_refs`.
- The claim that knowledge search is "`LIKE` only, no BM25" is **wrong**.
  `knowledge-index.ts:266` uses `LIKE` as a candidate prefilter and reranks with
  the `Bm25Index` added in v0.12.34.
- The claims about the loop surface, memory decay and the two-memory split are
  **right**, and are addressed here.

So the real gap was narrower and more precise than "all wiring is cut": the
memory *read* path was cut.

### The loop could write memories but never read them

- `DEFAULT_INTERNAL_TOOLS` exposed seven read-only tools, none of which touched
  memory; `memory_search` and `memory_propose` did not exist anywhere in the
  repository. An agent could record a lesson and never benefit from it.
- `memory_search` (read tier) and `memory_propose` (candidate tier) are now on
  the loop surface, dispatched through the real service. The read path delegates
  to the governed resolver, so it still produces a content-free receipt with
  per-memory reasons and an explicit omitted count — memory access was added
  without adding a way around the budget or the provenance trail.
- `memory_propose` routes to a turn proposal carrying a memory candidate and
  stops. It cannot create a durable memory; approval remains mandatory.

### Tier classification had to be earned, not special-cased

- The first tool names (`craft_memory_decay_weight`, `craft_memory_propose_policy`,
  `craft_memory_legacy_promote`) classified as `governed`, because the classifier
  reads the **last segment** and those names end in `weight`, `policy` and
  `promote`. Governed tools are outside the loop's mounted tiers, so the tools
  would have been invisible despite existing.
- Rather than weaken the fail-closed classifier, the tools were renamed to end in
  the verbs the existing vocabulary already recognises — `_get`, `_search`,
  `_preview` → read; `_propose`, `_record` → candidate. Classification now falls
  out of the rules that were already there.
- A test asserts every memory tool lands in a mounted tier, so this cannot
  silently regress.

### Memory decay and access weighting

- `memory_ledger` had no decay, weighting or access tracking; `resolve()` scored
  candidates by counting substring hits, so a stale preference competed on equal
  terms with yesterday's correction.
- `memoryDecayWeight` combines exponential half-life recency (90 days), a capped
  access bonus and a source-trust factor. Decay is floored, so "old" never
  becomes "gone" — an exponential underflows to exactly zero after ~26 years,
  which would make an ancient memory indistinguishable from a deleted one.
- A future `confirmed_at` is clamped rather than treated as a bonus, so clock
  skew cannot inflate a memory above every legitimate one.

### Capture policy: review by exception

- Automatic capture required both `memory_capture === "candidate"` and a
  `durable_value` signal, so by default nothing was ever proposed.
- `shouldProposeMemory` adds a `review_by_exception` mode where a correction, a
  retry, a decision or novelty each justify a candidate. The governance is
  unchanged — approval is still mandatory — only the proposal threshold moved, so
  the human moves from approving everything to vetoing what matters.
- `strict` mode reproduces the historical behaviour exactly, so a project that
  wants full manual approval keeps it.

### Two memory systems

- `compatBind` records `mode: "reference_only", migration_performed: false`, so
  the legacy and governed stores stay separate forever and a legacy memory can
  never gain provenance.
- `planLegacyPromotion` produces an approvable promotion candidate instead of
  migrating silently: an episode becomes `experience` (not a fact), raw episodic
  content is marked restricted, and `requires_approval` is always true.
- Writing this surfaced a concrete divergence: `service.memoryRemember` routes to
  the workbench memory whose scopes are `user|workspace|task` and which demands a
  `workspace_id`, while the ledger accepts `user|project|workspace|task`. That is
  recorded rather than papered over.

### A2: the vector path changed the label, not the result

- `resolve()` selected its mode with `adapter?.status === "eligible" ? strategy :
  "keyword"` but scored candidates by substring overlap either way — the vector
  branch only changed the `reason` string.
- `hybridMemoryScores` fuses keyword and vector rankings by reciprocal rank
  (matching `catalog.searchHybrid`), so an eligible adapter actually changes the
  result and neither method has to be trusted alone. The keyword-only path is
  preserved exactly when no adapter is eligible.

### Evidence that memory changed an outcome

- Every existing artifact proves the agent was *governed*; none proved it *got
  better because it remembered*. Without that link, decay would have no signal to
  learn from.
- `memoryUsageEvidence` records that resolved memories were in context for a turn
  that succeeded — and counts only successes, because counting a failure as usage
  would reward memories that were present when things went wrong.

### Tests

- `tests/memory-wiring.test.ts` — 15 tests at 100% line, branch and
  function coverage, plus end-to-end MCP calls.
- `tests/loop-memory-access.test.ts` — 4 behavioural tests asserting the
  loop's mounted surface, tier membership, the authorization projection, and real
  dispatch against a store.

## v0.12.34

The ideal-state gap closure. v0.12.33 carried capabilities to the user; this
release fixes three places where an existing capability was wired to the wrong
*shape*. Nothing here is a new runtime concept — all three were seams.

The gaps were identified by comparing Craft against first-party industry sources
(Anthropic's Managed Agents and Contextual Retrieval posts among them). The
comparison, its limits, and the outstanding gaps are recorded in
`docs/research/ideal-state-vs-industry-2026-09-18.md`. That document states
plainly that the sources are single-vendor and that no independent replication of
the cited numbers was found.

### Reversible context

- `truncateToBudget` is one-way: it returns a shorter string and the discarded
  tail is unrecoverable. Managed Agents names this directly — "irreversible
  decisions to selectively retain or discard context can lead to failures."
- `ReversibleContext` keeps every segment and shrinks only the *projection*.
  Dropped segments are named in `omitted` rather than lost, and `restore()` pulls
  one back. Ties break by recency so a projection is reproducible.
- `restore()` promotes the requested segment above all others. An earlier
  `weight + 1` bump made the outcome depend on the weights of *unrelated*
  segments; this was caught by the accompanying tests, not by review.

### BM25 retrieval

- Craft stores digests, ticket ids and record kinds — exactly the content an
  embedding model handles worst. `catalog.ts` had no BM25 and no IDF, so a query
  containing a common word was dominated by that word.
- `Bm25Index` implements standard BM25 (k1=1.2, b=0.75, +0.5 idf smoothing) with
  an exact-identifier boost, so `TS-999` finds the one record that mentions it.
- `fuseRankings` extracts the reciprocal-rank fusion already used by
  `catalog.searchHybrid` into a reusable, tested function.
- Note: the existing `rerank` is a local scoring function, not a model reranker,
  and `searchHybrid` already performed RRF fusion. Both were initially
  misread during the assessment.

### Deterministic experience capture

- Memory could previously be written only through an explicit tool call, so a
  lesson survived only if the model chose to remember it.
- `decideExperienceCapture` makes capture a deterministic function of observed
  signals with a threshold, producing an auditable candidate carrying its
  reasons and provenance rather than a silent write.
- Calibration corrected: a single correction now clears the default threshold on
  its own — it encodes the failure *and* its fix — and `requires_review` no
  longer gates a user-requested working pattern, which is already vouched for by
  the person who asked.

### Harness/session decoupling

- Whether the harness can be replaced without losing the session was previously
  *claimed*; it is now *demonstrated*.
  `tests/harness-session-decoupling.test.ts` boots three independent store
  instances with no in-memory object shared between them, and shows that a fresh
  harness recovers and continues a session, that a paused session survives a
  close/reopen and is resumable by a different harness, and that replaying the
  log reproduces identical history with the trace as an independent witness.
- `scripts/audit-v01234-layering.mjs` checks the declared layer direction. Only
  seven kernels import upward, all composition roots or compatibility shims.

### Seven surfaces added

`craft_context_project`, `craft_context_restore`, `craft_bm25_search`,
`craft_retrieval_fuse`, `craft_experience_capture_decide` and
`craft_experience_capture_build` are registered on the service facade and reachable
through MCP, with end-to-end tests through the real server rather than direct calls.

### Tests

- `tests/ideal-state-gaps.test.ts` — 20 tests at 100% line, branch and
  function coverage, plus end-to-end MCP calls.
- `tests/harness-session-decoupling.test.ts` — 3 behavioural tests.

## v0.12.33

Version unification, the distribution chain, and the first-run path. The theme is
that the runtime was already capable; what was missing was the last mile between
those capabilities and a user being able to succeed.

### Versioning

- `craft` and `craft-marketplace` now agree on `0.12.33`. Before this release the
  marketplace manifests said `0.12.32`, its README said `0.12.31`, and craft said
  `0.12.30` — three-way drift with nothing to detect it.
- `scripts/check-version.ts` now also verifies the sibling `craft-marketplace`
  checkout (release manifest, plugin manifests, README) when it is present, so the
  drift cannot recur. It validates craft alone when that checkout is absent.
- `release.json` records the exact craft `source_commit` the marketplace was cut
  from, refreshed at bump time rather than left stale.

### Distribution

- `.github/workflows/desktop-release.yml` builds the Windows ZIP on a Windows
  runner and the macOS DMG on a macOS runner, then attaches both to the GitHub
  Release. Previously no workflow built a desktop package and no release carried
  an asset, so a user had no download entry point at all.
- `package.json` `files` narrowed from `dist` to `dist/src` and `dist/plugin`. A
  bare `dist` would have published the 35MB Windows ZIP and the macOS `.app`
  bundle to npm — 1172 desktop artifacts.
- `publish.yml` runs the version check explicitly before publishing.

### First run

- `scripts/windows-launcher.cs` reads `%LOCALAPPDATA%\Craft\credentials.env` and
  injects each pair into the child environment, using the same mechanism that
  already injected `CRAFT_DATA_DIR`. A pasted key now reaches `env[apiKeyEnv]`
  without the user editing a system environment variable.
- `src/distribution-and-first-run.ts` adds credential resolution with an explicit overlay
  order, `readCredentialFile`, and `firstRunReadiness`, which answers "can a user
  run this right now" and names the exact variable that unblocks them.
- Six MCP tools expose this surface: `craft_first_run_readiness`,
  `craft_credential_resolve`, `craft_mcp_protocol_negotiate`,
  `craft_mcp_migration_assess`, `craft_isolation_capability_get`,
  `craft_distribution_plan_get`.

### Protocol

- MCP protocol negotiation is now explicit: a requested version that is not
  supported is recorded as a downgrade with a reason instead of silently falling
  back. The 2026-07-28 revision is tracked as `assessed_deferred`, with
  `assessMcpMigration` naming what blocks adoption (MRTR support, and mapping the
  durable task model to `io.modelcontextprotocol/tasks`).

### Honesty fixes

- `a2a-v1-adapter.ts` no longer writes `verified_transport: true`. The digest was
  the card hashing itself with no trusted key, so the record now states
  `transport_observed: true`, `signature_verified: false`, `signature_scheme: null`
  and `card_trust: "self_asserted"`. The old field claimed a signed-Agent-Card
  guarantee this adapter never provided.
- `isolationCapability` reports Windows as `enforced: false`. The `job_object`
  boundary is declared, not executed, so generated-code writes on Windows still
  require approval; the previous wording implied parity with macOS and Linux.
- README corrected in both directions: it understated a shipped HTTP transport
  (line 92) and disclaimed desktop packages that now exist (line 156).

### Studio approval surface

- Studio now has a **「待我批准」** view, the first persistent place to approve
  work. The runtime's headline guarantee is an approval gate, yet Studio had no
  pending-approval entry point at all — the most visible self-inconsistency
  between the backend and the product surface.
- It consumes the existing `/api/inbox/refresh` and `/api/inbox/decide`, which
  were already a persistent SQLite projection, so this required **no kernel
  change**. Decisions survive a page reload; previously an approval existed only
  for the life of the session.
- The view matches the real `attention_item` contract from `src/attention.ts`
  (`reason` / `action` / `priority` / `audience` / `details`), not an assumed
  shape, and offers only the two decisions the kernel accepts (`acknowledge`,
  `defer`), with a future `deferred_until` for deferral.
- `tests/studio-server.test.ts` asserts the served bundle actually wires the
  view, and that assertion was verified to fail when the nav entry is
  disconnected. Studio's reachable endpoints rise from 19 to 23.

### Tests

- `tests/first-run-readiness.test.ts` covers the new surface at 100% line,
  branch and function coverage, wired into the aggregate `test` chain.
