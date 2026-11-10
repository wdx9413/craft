# 生命周期、弱参考与领域隔离

> 决策依据见 [ADR 0027](../../adr/0027-expiry-advisory-revival-domain-boundary.md)。本文只记录**已落地的实现**与可复现的验收，不描述未实现的设想。

## 1. 要解决的问题

自进化产物（知识、记忆、经验）会随时间变旧，也会与其它事实冲突。两件事必须同时成立：旧材料不能冒充可信上下文（否则编程/量化这类错一步就报错的场景会被带偏），但也不能被删除（否则失去审计轨迹、也无法作为弱参考）。此外，一条在编程任务里学到的经验，不该被路由到量化或写作任务——领域不隔离会让"越用越好"变成"越用越偏"。

## 2. 统一行为约定

| 状态 | 默认（强上下文） | 显式 `include_stale` |
| --- | --- | --- |
| `reviewed` / `active` / routeable | 正常召回 | 正常召回 |
| `expired` / `stale` / `disputed` | 硬排除 | `advisory: true` + `freshness_score` + 权重折损 |
| `conflict_pending` / `disputed` | 硬排除，必须裁决 | 只读弱参考，不单方采信 |

`include_stale` 定义在 `common/craft-common-base/src/capability-protocol.ts` 的 `ContextRequest` 上，经 `core/context-resolution.ts` 透传给各贡献者。默认缺省即"关闭"，保持既有 fail-closed 语义。

## 3. 三条线的生命周期落点

### Knowledge
- **时间驱动退出**：`KnowledgeClaimGovernance.synchronize()`（`capability/craft-knowledge/claim-governance.ts`），由 `craft-service.knowledgeExpirySweep` 委托 `cognitiveWrites.sweepExpiredClaims` 调用。`valid_until` 过期 → `expired`；源失效/文档变更 → `stale`；有 `contradicts` 关系 → `disputed`。全部标 `revalidation_required: true`。
- **弱参考**：`KnowledgeContribution`（`capability/craft-knowledge/contribution.ts`）的 `advisoryFreshness()`：`expired` 按超期天数从 `0.5` 衰减到 `0.1`，`stale`/`disputed` 固定 `0.3`；评分时乘入 `freshness`，item 带 `advisory`、`freshness_score`、`reason: "stale_advisory"`。
- **复活**：`knowledgeClaimReopen()` 只把退出态改回 `candidate`，把原状态存进 `reopened_from`，随后必须重走 `core/knowledge-auto-review.ts` 的 auto-review + 独立有效性门槛才能再成 `reviewed`。已注册 `craft_knowledge_claim_reopen`。
- **血缘衰减**：`knowledge-lineage-impact.ts` 沿 `derives_from` 按 hop 衰减（confirmed=1、bounded=0.8、其它=0.5），根被挑战则派生 claim 标记需重评。

### Memory
- **时间驱动退出**：已存在的 `craft-service.memoryExpirySweep`（委托 `capability/craft-memory/memory-governance.ts` 的 `expirySweep`），同时过期 `memory_candidate` 与 `memory_ledger`，带 `limit` 预算。**本轮没有新增重复 sweep**。
- **弱参考**：`temporalMemorySelect()`（`common/craft-common-base/src/memory-temporal-policy.ts`）新增 `includeStale` 参数；`MemoryContribution` 对 `expired` 返回 `advisory`、`freshness_score: 0.3`、权重 ×0.3。
- **冲突/复活**：复用既有 `conflict_pending` 检测 + `resolveConflict(keep/supersede/dismiss)` + `supersedes_memory_ids`；复活走新 candidate → review → supersede，不原地翻状态。

### Experience
- **老化**：`activeProcedure()`（`capability/craft-experience/procedure-release.ts`）校验 release 上的 `valid_until`，过期返回 `null`（不路由），记录保留。`preserveProcedureRelease()` 把 `valid_until` 写入 release。
- **复活**：产生新 release，旧记录留痕。

## 4. judge 校准门（自进化闭环）

`craft-service.requireJudgeGate()` 是"gate 必须 eligible"的单一事实源，`adaptationCandidateAuthorizeCanary` 与 `experienceShadowExperimentEvaluate`（signoff 路径）共用。`evaluationPromotionAssess`（`core/application/coordinators/evaluation-runs.ts`）接受可选 `judge_gate_id`，提供时把 `judge_gate` 检查加入 promotion `checks`。signoff policy 的 `requirements` 含 `model`/`human` grader 时，若未提供 `judge_gate_id` 直接拒绝；纯 `program`/`operational` 确定性评测不要求 gate。

## 5. held_out 防污染与领域隔离

- `scenario-evaluation.ts`：held_out 阶段必须 `independent_of_training === true` 且提供 `training_set_digest`（`sha256:` 形状、≠ 自身 `case_set_ref`）。`ScenarioEvaluation.domain` 可选（`EVAL_DOMAINS = coding/quant/writing`），非法域拒绝；held_out 用例若带 `domain` 必须与场景域一致。domain 可选是为了不破坏存量配置，新配置显式声明才启用域隔离。
- `ExperienceContribution.readContribution()`：按 `scenario_signature.domain` 过滤——请求带域只召回同域，不带域只召回未标注。`ContextRequest.domain` 经 `context-resolution` 白名单校验后透传。

## 6. 评测（可复现验收）

`craft-eval` 的 held-out 套件（`core/eval-cases.ts` + `capability/craft-eval/suite.ts`）新增两条确定性 kernel 轴：

| 轴 | case | 判据 |
| --- | --- | --- |
| `lifecycle` | 过期知识硬排除 / 仅 advisory / advisory 降权 / Memory 时间门禁 / 过期 Procedure 停路由 | 字节级 `equals` |
| `domain_isolation` | coding 经验不被 quant 召回 / 同域召回 | 字节级 `equals` |

运行：`node --experimental-strip-types capability/craft-eval/suite.ts lifecycle` 与 `... domain_isolation`（实测 5/5 与 2/2 PASS）。单元级回归见 `tests/lifecycle-staleness.test.ts`、`tests/experience-contribution.test.ts`、`tests/scenario-evaluation.test.ts`、`tests/self-evolution-closed-loop.test.ts`（Experience→shadow→judge gate→signoff→canary 全链路）。

## 7. 领域 held-out 效果验证

三条领域各有一套冻结的确定性 held-out suite，放在独立 `craft-eval` 仓库的
`examples/domain-heldout/{coding,quant,writing}/`：每套 `runner.mjs` 产出
`outputs/result.json`，`grade.mjs` 用 `script` check 施加领域判据（coding：
测试全过 + 行覆盖率 ≥ 0.9 + 零回归；quant：正样本外收益 + 回撤 ≤ 0.2 +
样本外分区 + 最少交易数；writing：rubric 三维 ≥ 0.8 + 零禁用断言 + 受众匹配）。
`verify-graders.mjs` 对每个领域喂劣化记录并断言判据退出 1，证明判据**不是恒真**；
`run-all.mjs` 通过 `craft-eval run --fail-on-failed` 跑三套正例（实测均为
`complete / passed=1 / failed=0`）。

**诚实边界**：这验证的是"领域门禁机制能区分达标与劣化"，不是"模型在三个领域
已达标"。真实领域效果仍需把 `runner.mjs` 换成各自真实的测试套件 / 样本外行情
面板 / 已校准 judge；未校准 judge 不得用于晋级。

## 8. 未覆盖风险与后续

- `coverage-gates`（100% 行/函数/分支）已在主仓库 `.github/workflows/test.yml` 的 "Unit tests and 100% coverage" 步骤中运行（`audit:coverage-inventory --check && test:ts && test:coverage-gates`）；独立 `craft-eval` 仓库另有 `.github/workflows/test.yml` 跑 `npm test` 的两项覆盖率门禁与领域 held-out 套件。本机 node 覆盖率工具会挂起，属环境限制，不是 CI 缺口。
- `lifecycle` / `domain_isolation` 是**机制级**验证，三套领域 held-out 是**判据级**验证；二者都不等价于真实业务效果，接入真实领域数据时须同时版本化 `grade.mjs` 与 `suite.json`（改动 grader 而沿用同一 suite id 会让 held-out digest 失效，比较门禁会拒绝）。
- 领域集合是固定三值；新增领域须同时扩 `EVAL_DOMAINS` 并配对应 held_out 集，这是"不能凭空造域"的有意约束。
- `disputed` 冲突已在 `include_stale` 下**成对呈现**（`conflicting_pair` + `conflict_with` 带对端正文，双方均为 advisory），默认仍硬排除；裁决仍走 `resolveConflict(keep/supersede/dismiss)`，权重稀释不替代裁决。
