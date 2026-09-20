# Knowledge、Memory、Experience 的单点产品与评测

三个组件可以独立装给 Codex、Claude 或其他 MCP Host，但它们不是三套平行 Agent，也不复制 Craft Core 的事实账本。

```text
Knowledge Source → Knowledge Claim ┐
                                  ├→ Context Resolution Receipt → Host
Memory Candidate → Memory Ledger  ┘

Trace / Outcome → Experience Observation → Procedure Candidate
                         ├→ Workflow Draft
                         └→ Graph Draft
                         → Shadow → Held-out → Signoff → Canary → Routable
```

## 对外默认面

默认产品面优先服务日常动作，避免让模型面对几十个工具 Schema：

| 产品 | 默认动作 | 不做什么 | 高级面 |
| --- | --- | --- | --- |
| `craft-knowledge` | readiness、来源登记、索引、搜索、Claim 草拟/复核、受限 Context Receipt | 不把搜索结果变成事实或权限 | `component-knowledge` |
| `craft-memory` | readiness、候选、Evidence 复核、批准写入、单条读取、显式 scope 列表、冲突处置、维护 | 不存聊天全文、不跨 scope 读取 | `component-memory` |
| `craft-experience` | readiness、证据、观察、两条独立观察后的 Procedure 草案、Graph 读取/生命周期 | 不自动发布、改变默认 Workflow 或直接运行 Graph | `component-experience` |

三者都使用 `craft_component_readiness_get` 返回无正文的状态、数量与下一安全动作。它既避免空库时的盲目工具调用，也明确声明 `model_effect_proven: false`，直到有真实 Host 对照数据为止。

## Codex 生命周期闭环

三个 Codex 插件各自携带一个小型 Hook 配置，复用同一个 Hook Bridge，但不会覆盖用户已有的 DCC、PII 或项目 Hook。Hook 必须由用户在 Codex 中审阅并信任；未信任、超时或报错时，Codex 正常工作，组件只记录无正文的健康事件。

| 组件 | 事件 | 允许行为 | 明确禁止 |
| --- | --- | --- | --- |
| Knowledge | `UserPromptSubmit` | 当前 `cwd` 的 project scope 内解析 reviewed Claim，注入 bounded Context Receipt | 读取 transcript、candidate 入 Context、加载 Memory |
| Memory | `UserPromptSubmit` | 同 scope 解析 Memory；仅 `记住：…` / `/remember: …` 写入明确同意的 statement | 普通对话落库、自然语言猜 topic、跨项目回退 |
| Experience | `PostToolUse` / `Stop` | 记录编辑/验证的 digest、退出状态与终态 Evidence；两条独立 Turn 才建 request | 保存命令/输出正文、模型自述当验收、直接提交 Workflow |

Hook 的 `Stop` 不是后台 Agent，也不接管、续跑或唤醒 Codex。它只将本轮已有的“修改 + 可验证终态”交给 Observation Ledger；缺少验收命令、被取消或未知退出状态时不沉淀 Experience。

## 三条不同的学习链

### Knowledge：可复核的“知道什么”

来源必须有 scope、digest、信任与访问边界；Claim 必须有 Evidence、有效期、冲突/替代关系。日常路径由 `craft_evidence_record → Claim → Knowledge Support → 自动 Promotion Policy` 组成：默认两条不同 Evidence/Observation 才自动晋升，重复同一聊天或同一 Evidence 不计分。人工只可作为本机阈值调整或例外覆盖，不是默认审核队列；本机阈值也不随 Bundle 迁移。检索只产生 Context Receipt，不能扩大工具、文件或外部写入权限。评测首先检查引用覆盖、时效、冲突和跨项目隔离；之后才比较带/不带 Receipt 的同一代码 Case。

### Memory：受限的“这次应记住什么”

Memory 是 scope、敏感级别、有效期、撤销关系齐全的上下文条目，不是历史聊天。默认 `propose → review → approved Ledger`，Maintenance 只生成发现或候选而不自动覆盖/删除/发布。显式用户陈述可生成 bounded Evidence，但同 topic 的相反新条目必须经过 conflict → supersede → review → materialize，旧记录保留且停止召回。评测应至少含正例、另一项目、已过期、已撤销、相互冲突和“在决策点而非第 40 轮才取回”的六类 Case，并记录召回后 Outcome 是否改善。

### Experience：有证据的“这种事如何改进”

Experience 记录多个 Outcome/Trace 的脱敏模式和反例，执行 Host 不直接读取诊断性 Pattern。两条独立 Observation 只能生成 `Procedure Candidate`：稳定顺序用线性 `Workflow`；运行时分支、并行汇合、局部返工、人审恢复或补偿才选 `Graph`。Graph 的 `depends_on` 仍是可预测的 DAG，反馈边必须显式标为有上限的 `retry` 或需要外部批准的 `human_resume`；无界循环被拒绝。

Graph 是**资产格式**，不是第二个执行器。保存后的 Graph 固定为 `draft` 且 `automation_authority: false`；正式执行仍由 Core 的 Policy、State Snapshot、Receipt、Acceptance、Trace 与 VerifiedWorkLoop 承担。它同样必须经 Shadow、held-out、Signoff 与 Canary 才可能成为可路由程序。拒绝的候选及其回归 Case、原因和重新考虑条件必须保留，避免反复提出同一失败改动。

## 编码任务的最小验证套件

先以两类稳定 Case 建立基线：

1. **研发/代码修复**：固定小仓库、明确 failing test、受限可修改路径和验收命令。
2. **文件型交付**：固定输入文件、可检查的输出与元数据断言。

每个 Case 做三层验证：

| 层 | 目的 | 示例 |
| --- | --- | --- |
| Mechanism / Fixture | 验证组件自己的确定性边界 | 跨项目拒绝、撤销拒绝、两条独立 observation 才能提案 |
| Host integration | 验证 Codex/Claude 真的接收最小工具面与 Receipt | `initialize/tools/list`、取消、超时、Trace 完整性 |
| Quality / regression | 验证这项能力是否值得启用 | 基线 vs 一个候选变化，固定 Host/model/环境/预算，3–5 个配对 Trial |

Quality 层至少记录终态验收、首次成功率、无效重试、恢复率、工具/参数错误、成本、时延和回归。模型自述“完成”、一次成功、MCP 握手或单元测试都不能作为业务提升证据。未配置真实模型时应返回 `unavailable`/`inconclusive`，绝不伪造 pass。

## 从探索到 N 套 Workflow

同一 `scenario_key` 下，完成一次被验收的编码工作后，只记录无敏感正文的 Observation；两条独立来源才允许草拟一个最多改变两个 Harness 设计轴的 Procedure。先从最小单 Agent 基线开始，每次只比较一个明确增量（例如加入一个 Knowledge Receipt，或加入独立检查步骤）；只有明确出现运行时分支、并行汇合、人审恢复或局部返工时才比较 Graph 候选。随后以 Shadow、held-out、Signoff、Canary 逐层淘汰。这样最终得到的 N 套 Workflow/Graph 是“在哪些 Case 上、以何种成本、为什么可用”的版本化资产，而不是把偶然成功的聊天轨迹复制成模板。

每次修复一个重复错误，应绑定三件套：带适用/触发条件的规则或 Candidate、可重复运行的回归 Case、只检查真实终态的独立 Acceptance。运行侧再以老错误复发率、首错位置、无效重试与恢复率衡量改进，不能用“记忆条数增长”或模型自述代替。

## 长任务不是“让模型多跑几轮”

长任务的完成权属于 Acceptance，不属于模型的 finish reason。运行时必须把以下事件归一化进同一条 Run/Trace：`turn.started`、`tool.intent`、`tool.authorized`、`tool.settled`、`progress.observed`、`heartbeat`、`compaction.applied` 与 `operation.terminal`。每个高杠杆决策点先解析受限 Context；每个 Step 后写 Checkpoint 并重新观察真实状态。

当前内核已经能在连续无状态变化时转为 `needs_replan`，也能拒绝 Host 自述完成。但“不会阻塞、不会误停、不会重复副作用”还必须由真实 Host 证明：需要稳定 invocation fingerprint、heartbeat/lease epoch、按错误类型划分的重试预算、`effect_pending/unknown` 对账、里程碑 progress predicate、watchdog/orphan scan，以及进程崩溃、网络断开、写成功但 Receipt 丢失的故障注入。未通过这些测试前，只能称协议和 Fixture 已实现，不能声称真实长任务效果已证明。

关联：[上下文、记忆与后台整理](context-memory.md) · [Experience / Eval](experience-eval.md) · [当前能力矩阵](../current-capability-matrix.md)
