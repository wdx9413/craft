# Craft Context 自进化闭环补齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 Craft Context 自进化诊断与 Experience 证据断点，验证 Knowledge、Memory、Experience 的隔离捕获、治理、使用回执，并发布安装可核验的新 Marketplace 包。

**Architecture:** 保留各子能力 owner 的捕获和晋级规则；Core 只汇总有来源的诊断状态，并通过 Evaluation Contract owner 校验任务效果报告。Experience Procedure 的所有创建分支沿用同一份已校验证据。测试写临时数据根；正式数据只由用户已授权的正常 Host 路径自然写入。

**Tech Stack:** TypeScript、Node.js test runner、CraftStore/SQLite、现有 Craft Capability 与 Craft-Eval API、Craft Marketplace 打包脚本、Codex Plugin CLI。

**Spec:** `docs/superpowers/specs/2026-11-24-craft-context-self-evolution-closure-design.md`

## Global Constraints

- 不迁移当前工作区身份；当前父工作区 ID 已与 Host 回执匹配。
- 不回放历史对话、不手工向正式数据根写候选或反馈；正常 Host 捕获可自然写入并保留。
- 独立效果结论需要不同任务/会话、冻结合同、可信 evaluator 和现有样本门槛；同会话自评不能晋级。
- Knowledge、Memory、Experience 各自拥有候选、阈值和启用权；Codebase 不进入候选晋级。
- 本次新增或修改的可执行代码，增量可执行行覆盖率和增量分支覆盖率分别达到 100%。
- 延续既有授权：Craft/Capability 同步、Marketplace 打包、远端推送、升级插件；不做 npm 发布。

## Review Focus

- `project_root` 有已注册身份但无 migration record：按 canonical ID 评估，不能误报身份迁移。
- `project_root` 缺失/身份未注册：不能悄悄退回项目或全局错误作用域。
- task-effect report 属于别的候选、合同或 scope：保持 `effect_pending` 或报告不匹配，不能按记录数放行。
- Eval owner 不可读或可信 evaluator 未配置：显示不可用/等待，不把空值当零或通过。
- Experience graph/composition 重试或幂等恢复：Procedure 仍绑定同一 Observation 与受控评测 Evidence。

---

### Task 1: 让闭环缺口诊断反映真实 scope 和受控评测

**Files:**
- Modify: `core/capability-iteration-gaps.ts`
- Modify: `core/application/actions/action-handlers.ts`
- Modify: `core/application/use-cases/context-extensions.ts`
- Modify: `core/application/craft-service.ts` (service interface only if needed)
- Modify: `core/mcp/tool-catalog.ts`
- Test: `tests/context-readiness-doctor.test.ts`
- Test: `tests/action-handlers.test.ts`
- Modify: `tests/coverage-gates.json` to enable branch coverage on the existing `context-readiness-doctor` group

**Interfaces:**
- The MCP handler obtains the same owner-store map used by `contextReadinessDoctor`; the gap audit must not count missing owner data as zero.
- Add optional read-only `effect_evaluation_ref` input with exact `contract_id`, `evaluation_id`, and `candidate_ref: { kind, id, version, digest }` fields. Resolve the report through the Eval owner and validate with its existing `EvaluationContractKernel.verifyTaskEffectEvaluation`; do not duplicate signature or sample validation.
- Scope resolution: when both `project_scope_id` and `project_root` are supplied, require them to resolve to the same canonical identity or return `identity_conflict` without querying either scope. With only a root, resolve the canonical ID; an unresolved supplied root never falls back to `global`. With neither root nor scope, retain the global diagnostic.

- [ ] **Step 1: Add failing tests**

  Extend the existing gap-audit tests to assert: a resolved workspace identity with no migration record does not produce `project_identity_migration`; matching root/scope resolves normally; mismatched root/scope returns `identity_conflict`; unresolved supplied root does not read global records; a matching eligible signed task-effect report clears the effect gap; wrong candidate/contract and unavailable Eval owner remain blocked; installed release is reported from active runtime evidence without the static `codex_plugin_cache` gap.

  Set `branches: true` on the existing `context-readiness-doctor` group so its configured 100% branch threshold applies to this logic.

- [ ] **Step 2: Run the context readiness coverage group and confirm the new assertions fail**

  Run: `pnpm run test:coverage-gates:one -- context-readiness-doctor`

  Expected: test failures for the missing scope, dynamic-state and Evaluation-owner behavior.

- [ ] **Step 3: Wire owner-aware gap diagnostics and state derivation**

  Reuse the owner map from the existing Context Doctor service path. Use actual project identity/migration state. Remove unconditional cache/migration/effect gaps. Keep effect pending unless the Eval owner verifies the exact candidate-bound report as eligible. Keep responses content-free and read-only.

- [ ] **Step 4: Run the focused tests and coverage gate**

  Run: `pnpm run test:coverage-gates:one -- context-readiness-doctor`

  Expected: the group passes its configured line, function and branch thresholds; every modified diagnostic branch has a behavior assertion.

- [ ] **Step 5: Commit the diagnostic fix**

  Commit the Task 1 source/tests only after the gate reports 100% lines and branches.

### Task 2: Preserve Experience evidence on graph and composition drafts

**Files:**
- Modify: `core/application/craft-service.ts`
- Test: `tests/component-integration.test.ts`
- Modify: `tests/coverage-gates.json` only if needed to bind the changed executable source to a 100% line/branch coverage group

**Interfaces:**
- Use existing `procedureEvidenceIds` assembled from request Observation Evidence and exact, passing controlled-evaluation links.
- All `experienceProcedures.draft` paths—graph/composition, prompt, workflow, and idempotent recovery—must receive that same allowlisted evidence set.

- [ ] **Step 1: Add failing graph/composition evidence tests**

  Extend the existing evidence-backed proposal integration test with graph and composition requests. Assert both source Observation Evidence and the valid controlled-evaluation Evidence appear on the resulting Procedure and its idempotent retry. Assert a tampered report remains excluded and unrelated caller Evidence is rejected.

- [ ] **Step 2: Run the focused integration test and confirm the graph/composition assertion fails**

  Run: `node --experimental-strip-types --test tests/component-integration.test.ts`

  Expected: failure because the graph/composition branch drops `procedureEvidenceIds`.

- [ ] **Step 3: Pass the validated evidence set into every draft branch**

  Modify the graph/composition draft call to pass `evidence_ids: procedureEvidenceIds`; preserve existing validation and idempotency behavior.

- [ ] **Step 4: Run the focused integration and covered service gates**

  Run: `node --experimental-strip-types --test tests/component-integration.test.ts`

  Expected: all integration assertions pass and the evidence IDs match exactly.

- [ ] **Step 5: Report incremental coverage and commit the evidence fix**

  Measure changed `craft-service.ts` executable lines and branches against the pre-change baseline; add behavior assertions for any uncovered changed line/branch, rerun the same focused test/coverage command, and commit only after both percentages are 100%.

### Task 3: Prove component stages and asset selection in isolated data

**Files:**
- Create: `tests/context-self-evolution-usage.test.ts`
- Modify: `tests/coverage-gates.json` to register the new integration test group only if production code is added to this task
- Run: existing packaged smoke `scripts/smoke/experience-autoevolution-smoke.ts` without changing it unless a missing assertion is demonstrated

**Interfaces:**
- Use one temporary `CRAFT_DATA_DIR` and existing owner stores; do not seed or mutate the user's data root.
- Assert each lifecycle using owner APIs: Knowledge candidate remains non-searchable until its own gates pass; Memory capture does not imply an active ledger entry; Experience remains non-routeable until its gates pass.
- When a fixture asset is eligible, resolve it in the same test scope and assert the receipt names the exact member/id/version. Feedback must link the receipt and exact asset reference; unrated feedback must not count as effect.

- [ ] **Step 1: Add temporary-store integration assertions**

  Add four tests: `eligibleKnowledgeAssetIsSelectedOnlyForMatchingProject`, `memoryCandidateDoesNotEnterReceiptBeforeLedgerPromotion`, `routeableExperienceIsSelectedWithVersionAndFeedbackRef`, and `unratedFeedbackDoesNotCountAsEffect`. Include a cross-project negative case. Assert exact receipt refs and feedback association; no test may use the user's data root.

- [ ] **Step 2: Run the focused tests and verify failures identify the unconnected stage**

  Run: `node --experimental-strip-types --test --test-concurrency=1 tests/context-self-evolution-usage.test.ts`

  Expected: no formal data is touched; each failure identifies an owner transition, scope filter or receipt/ref mismatch.

- [ ] **Step 3: Verify all expected lifecycle boundaries**

  Use existing component APIs and owner state. The tests must demonstrate that only an owner-approved asset can be selected; do not create a second candidate store, shared promotion state machine, or shortcut around a child capability's policy. If a test fails, add the smallest owner-local fix and an assertion in this same test file.

- [ ] **Step 4: Run the packaged self-evolution smoke and owner tests**

  Run: `pnpm run test:plugin` and the focused owner tests.

  Expected: packaged MCP and Hook pass against the smoke's temporary data root; synthetic success is labeled mechanism evidence only.

- [ ] **Step 5: Measure incremental coverage and commit the usage checks**

  If Task 3 changes production code, report changed executable lines and branches separately, add behavior assertions until both are 100%, then commit. If it adds tests only, report production-code coverage as not applicable and commit the tests.

### Task 4: Release and verify the active Codex Host

**Files:**
- Modify: `package.json` and `core/version.ts` (release bump from `0.21.8` to `0.21.9`)
- Generated/update: Craft release catalog and component build inputs via existing scripts
- Generated/sync: Marketplace-owned plugin payload, manifest, latest marker, ZIP and release provenance via existing scripts

**Interfaces:**
- Build from committed Craft/Capability source; marketplace payload must match the source bundle SHA and exact build-input commits.
- Host acceptance checks the newly installed version in a fresh Codex/MCP session; upgrading the package does not hot-reload existing sessions.

- [ ] **Step 1: Run focused tests and 100% incremental coverage checks before release packaging**

  Run: Task 1 and Task 2 gates, relevant Capability typecheck/test inventory, then `pnpm run test:plugin` in Craft.

  Expected: all changed executable lines and branches are 100%; source and test outputs are recorded separately from Host evidence.

- [ ] **Step 2: Synchronize release metadata and commit the source release**

  Run `pnpm run release:sync` and `pnpm run version:check`; review the generated manifest diff and commit the release source. This commit becomes the pinned Marketplace build input.

- [ ] **Step 3: Build and pack Craft Context `0.21.9`**

  Run the repository's existing `build`, `pack:plugin`, `release:check`, and `check-plugin-package` scripts in their documented order. Verify the packed bundle's embedded MCP version equals `0.21.9`.

- [ ] **Step 4: Sync and validate Marketplace payload**

  In `craft-marketplace`, run `node scripts/sync-from-craft.mjs ../craft/plugins --apply`, then `--check`; build the Marketplace package and verify ZIP integrity and bundle hashes.

- [ ] **Step 5: Commit and push the authorized Craft and Marketplace release changes**

  Keep commits scoped to this release, preserve unrelated work, push source before Marketplace, then compare remote commit/tree and release manifest against the local artifacts. Do not publish to npm.

- [ ] **Step 6: Upgrade and verify a fresh Codex Host session**

  Run `codex plugin marketplace upgrade craft-marketplace`; start a fresh Host/MCP session and call `craft_context_doctor`, `craft_capability_iteration_gaps` and `craft_context_usage_statusline`. Verify runtime version, canonical workspace scope, worker status, selected refs and feedback outcomes. If no eligible normal asset or independent real task exists, report the corresponding stage as pending; do not synthesize a production candidate.

## Validation commands

- Craft focused group: `pnpm run test:coverage-gates:one -- context-readiness-doctor`
- Craft evidence integration: `node --experimental-strip-types --test tests/component-integration.test.ts`
- Craft package/Hook/learning smoke: `pnpm run test:plugin`
- Capability inventory/typecheck: `pnpm test:coverage` and the affected leaf package typecheck/test scripts
- Final review: `ocr review --audience agent --background "Review the approved Craft Context self-evolution closure changes against the approved design and acceptance criteria." --from origin/main --to HEAD`

## Plan self-review

- Spec coverage: dynamic diagnostics and scope, Evidence inheritance, independent component owners, isolated data, real Host install, release provenance, and pending real-effect evidence each have a task.
- Review Focus inputs all map to tests in Task 1 or Task 2.
- Cross-owner validation uses the existing Eval verifier; the plan does not duplicate its signature/sample rules.
- Real user records are never used as fixtures; future independent-session evidence remains pending until naturally produced.
- No new dependency, vector store, autonomous publisher, data migration or npm publication is introduced.
