# Knowledge、Memory、Experience 的单点产品与评测

三个组件可以独立装给 Codex、Claude 或其他 MCP Host，但它们不是三套平行 Agent，也不复制 Craft Core 的事实账本。

```text
Knowledge Source → Knowledge Claim ┐
                                  ├→ Context Resolution Receipt → Host
Memory Candidate → Memory Ledger  ┘

Trace / Outcome → Experience Observation → Scenario Signature → Pattern
                         → Procedure Candidate (Workflow / Graph / Prompt Markdown)
                         → Shadow → Held-out → Signoff → Canary → Routable / Rollback
```

## 对外默认面

默认产品面优先服务日常动作，避免让模型面对几十个工具 Schema：

| 产品 | 默认动作 | 不做什么 | 高级面 |
| --- | --- | --- | --- |
| `craft-knowledge` | readiness、来源登记、索引、搜索、Claim 草拟/复核、受限 Context Receipt | 不把搜索结果变成事实或权限 | `component-knowledge` |
| `craft-memory` | readiness、候选、Evidence 复核、批准写入、单条读取、显式 scope 列表、冲突处置、维护 | 不存聊天全文、不跨 scope 读取 | `component-memory` |
| `craft-experience` | readiness、证据、观察、模式查看、两条独立观察后的 Procedure 草案 | 不自动发布、改变默认 Workflow 或直接运行 Graph | `component-experience` |

三者都使用 `craft_component_readiness_get` 返回无正文的状态、数量与下一安全动作。它既避免空库时的盲目工具调用，也明确声明 `model_effect_proven: false`，直到有真实 Host 对照数据为止。

“Skill 已读取”或 marketplace 中 `enabled = true` 都不是 MCP 已挂载的证明。只有当前会话对该组件完成 `initialize → tools/list → craft_component_diagnose`，才能分别证明包已加载、日常工具面匹配、以及这个 MCP 进程确实可达。Hook 是独立的可选自动化层：Hook 解析或信任失败不得被描述成“组件数据为空”。

## Codex 与 Claude Code 生命周期闭环

三个组件在 Codex 和 Claude Code 都显式注册同一份只含 `command` 的 Hook 配置，复用同一个 Hook Bridge，但不会覆盖用户已有的 DCC、PII 或项目 Hook。命令使用 `${CLAUDE_PLUGIN_ROOT}`：Codex 同时提供该兼容变量，Claude Code 使用其原生变量。两端都必须由用户审阅并信任；未信任、超时或报错时，Host 正常工作，组件只记录无正文的健康事件。

不使用 `mcp_tool` Hook：已有 command Bridge 已负责受限 Context Resolution，额外 MCP Hook 会重复解析；同时不同 Codex 版本的 Hook parser 对 `mcp_tool` 的支持并不一致。发布门禁要求三个组件的 Codex/Claude manifest 都指向 `./hooks/hooks.json`，且每个 handler 都是可审计的 `command`。

| 组件 | 事件 | 允许行为 | 明确禁止 |
| --- | --- | --- | --- |
| Knowledge | `UserPromptSubmit` | 当前 `cwd` 的 project scope 内解析 reviewed Claim，注入 bounded Context Receipt | 读取 transcript、candidate 入 Context、加载 Memory |
| Memory | `UserPromptSubmit` | 同 scope 解析 Memory；仅 `记住：…` / `/remember: …` 写入明确同意的 statement | 普通对话落库、自然语言猜 topic、跨项目回退 |
| Experience | `UserPromptSubmit` / `PostToolUse` / `Stop` | 开始时装载已路由 Procedure；结束时记录编辑/验证的 digest、退出状态与终态 Evidence；两条独立 Turn 才建 request | 保存命令/输出正文、模型自述当验收、直接提交 Workflow |

Hook 的 `Stop` 不是后台 Agent，也不接管、续跑或唤醒 Codex。它只将本轮已有的“修改 + 可验证终态”交给 Observation Ledger；缺少验收命令、被取消或未知退出状态时不沉淀 Experience。

## 三条不同的学习链

### Knowledge：可复核、可保鲜的“知道什么”

来源按 `discover → read → normalize → fragment → Evidence → Claim Candidate` 保存不可变 revision；Source 更新不会覆盖旧 revision，而会让受影响 Claim 进入 `stale/revalidation_required`。日常 MCP 同时提供 Evidence 记录、Source 导入、Candidate 查询、语义复核与撤回。`craft_knowledge_semantic_review_packet` 将 Claim、精确 Evidence fragment、scope、风险等级与 rubric 交给当前 Codex/Claude；Host 回传 packet digest 后才算可审计的自动复核。配置独立 Provider 时也可无人值守复核；两者都不可用则明确 `unavailable`，不伪造 reviewed。结构复核和语义复核均通过的低风险只读 Claim 可自动晋升；权限、Capability、外部 effect 与路由 Claim 仍只能进入独立 Eval。检索只产生 Context Receipt，不能扩大工具、文件或外部写入权限。评测首先检查引用覆盖、时效、冲突、越界读取和跨项目隔离；之后才比较带/不带 Receipt 的同一代码 Case。

### Memory：受限的“这次应记住什么”

Memory 是 scope、敏感级别、有效期、撤销关系齐全的上下文条目，不是历史聊天。新写入明确区分 Run/Session State、带 TTL 的 `working_note:true` Working Notes 与长期 episodic/preference/procedural Ledger；历史 `kind: working` 仅以兼容标记读取，迁移后不自动作为新工作记忆。`Scope Envelope` 使适用范围与归属、受众、用途、留存、tenant 分离：工作通道按 `task → session → project → explicit team → explicit organization` 解析，个人通道只读取明确指定的 user，global 也必须显式请求。更具体 scope 的同 topic 会遮蔽父 scope，绝不扫描所有 scope。显式用户陈述可生成 bounded Evidence，但同 topic 的相反新条目必须经过 conflict → supersede → review → materialize，未解决冲突明确 abstain；旧记录保留且停止默认召回。Light Maintenance 只做 TTL、去重、敏感检查和引用健康；Review/Deep 受空闲、预算、租约和模型可用条件约束，最多产生 Candidate。召回次数只影响排序与评测，绝不单独提高可信度。评测应至少含正例、另一项目、已过期、已撤销、相互冲突和“在决策点而非第 40 轮才取回”的六类 Case，并记录召回后 Outcome 是否改善。

检索不是事实层：Keyword/BM25 可离线运行；Vector/Hybrid 必须有实际 Provider、通过召回/泄漏/成本/时延评测，才可以被选择。Provider 不可用时 Receipt 明确记录请求的策略、实际使用的 keyword 和 `embedding_provider_unavailable`，不能把配置或评测状态伪装成一次真实向量调用。Eligible Provider 连续三次瞬态失败会熔断五分钟；成功探测后恢复。Embedding 以 `contentDigest + modelRevision` 缓存，Hybrid 用 RRF 融合排序而不直接相加异构分数。

### Experience：有证据的“这种事如何改进”

Experience 记录多个 Outcome/Trace 的脱敏模式和反例，并以**已路由 Procedure** 参与 Context；诊断性 Observation、Pattern 和 Candidate 永不注入。唯一可执行投影链是 `Observation → Scenario Signature → Pattern → Procedure Candidate → Shadow → Held-out → Signoff → Canary → Routeable / Rollback`；两条带独立 Evidence、同一结构化 Scenario Signature 的 Observation 才能生成 Candidate。Workflow 与 Graph 的权威定义是受管 JSON，分别写入 `~/.craft_data/experience/procedures/workflows/` 和 `procedures/graphs/`；对应 Markdown 只作为审阅视图，写入 `md/workflows/`、`md/graphs/`。短小 Skill 风格 Prompt Procedure 的权威正文才是 `md/prompts/` 中的 Markdown；索引在 `~/.craft_data/experience/experience.db`。显式导出的禁用 `SKILL.md` 位于 `~/.craft_data/experience/skills/`；结构化 Procedure 同时导出 `PROCEDURE.json`，两者都不会自动安装。它们是 Craft 学习资产，与 Capability Registry 中已安装/激活的 Skill、MCP、插件或 Workflow 分账；低风险建议可同时呈现给模型，高风险 effect 冲突仍由 Policy/Decision Gate 裁定。旧 `craft_workflow_evolution_*` 与 `craft_workflow_dag_*` 已从 MCP 工具面下线，仅保留一次性迁移读取兼容；新的日常 Procedure 工具使用简短的 `craft_procedure_*` 名称。

Graph 是**资产格式**，不是第二个执行器。只有 routeable Procedure 才能由 Decision Context Gate 按 Scenario Signature 注入；原始 Trace、Pattern、模型复盘和 rejected proposal 永不进入执行上下文。正式执行仍由 Core 的 Policy、State Snapshot、Receipt、Acceptance、Trace 与 VerifiedWorkLoop 承担。被拒绝 Candidate 的失败触发条件、回归 Case、原因和重新考虑条件进入 Reconsideration Index，缺少新 Evidence 或条件变化时禁止重复提案。routeable Procedure 可以显式导出为 `enabled: false` 的 `SKILL.md` 草案；导出不会安装、启用或覆盖任何现有 Skill。

## 已路由 Workflow 的本地自动化

`Automation Job` 把一个**已 routeable 的线性 Workflow Procedure**绑定到工作区、显式输入、验证 Step、`manual` 或固定间隔触发、有限重试和记录型通知。它不从 Experience Candidate 或 Skill 草案直接执行；`Graph` 与 `Prompt Procedure` 仍需要能理解分支或自然语言的 Host Adapter，外部写入和破坏性 effect 一律失败关闭。

Host cron、CI、托盘或系统服务只需要显式调用 `craft_automation_job_tick`，或通过 `craft_local_service_tick` 一并推进到期 Job；Craft 不修改操作系统的 cron/service 配置，也不保存通知凭据。每次运行按 Step 建立 Checkpoint，并保存去除原始输出的 Receipt 与由指定 assertion/coverage verifier 得出的 Outcome。失败只按有限预算重试；预算耗尽时写入 Handoff 与待投递 Notice，绝不无界重跑或宣称已完成。

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

## 跨机器迁移

`craft_knowledge_memory_bundle` 导出的 schema 3 是可重放的增量事实包：canonical scope、alias、Source revision、fragment、Evidence、Memory、Observation、Procedure Markdown 审阅视图、Workflow/Graph JSON 定义、Candidate 与撤销 tombstone 都以 digest、device/export ID 和 cursor 绑定。导入在接收端重建本地 JSON 定义引用；只有旧包缺失该定义时才降为待复核。导入先得到 `add / duplicate / conflict` 计划；冲突只生成 Conflict Set/Candidate，绝不 last-write-wins。

本地目录和 Git 工作树 Transport 只搬运经过校验的 JSON 包，不复制 SQLite、API key、绝对路径 alias、完整 transcript 或原始工具输出。写入需要显式 `allow_local_write: true`；Git 工作树仅写入 `.craft/craft-bundles/`，提交和推送仍必须由用户显式执行。加密、签名与对象存储是后续可插拔 Transport，不应把密钥写入 Ledger、Trace 或 Bundle。

## 从探索到 N 套 Workflow

同一 `scenario_key` 下，完成一次被验收的编码工作后，只记录无敏感正文的 Observation；两条独立来源才允许草拟一个最多改变两个 Harness 设计轴的 Procedure。先从最小单 Agent 基线开始，每次只比较一个明确增量（例如加入一个 Knowledge Receipt，或加入独立检查步骤）；只有明确出现运行时分支、并行汇合、人审恢复或局部返工时才比较 Graph 候选。随后以 Shadow、held-out、Signoff、Canary 逐层淘汰。这样最终得到的 N 套 Workflow/Graph 是“在哪些 Case 上、以何种成本、为什么可用”的版本化资产，而不是把偶然成功的聊天轨迹复制成模板。

每次修复一个重复错误，应绑定三件套：带适用/触发条件的规则或 Candidate、可重复运行的回归 Case、只检查真实终态的独立 Acceptance。运行侧再以老错误复发率、首错位置、无效重试与恢复率衡量改进，不能用“记忆条数增长”或模型自述代替。

## 长任务不是“让模型多跑几轮”

长任务的完成权属于 Acceptance，不属于模型的 finish reason。运行时必须把以下事件归一化进同一条 Run/Trace：`turn.started`、`tool.intent`、`tool.authorized`、`tool.settled`、`progress.observed`、`heartbeat`、`compaction.applied` 与 `operation.terminal`。每个高杠杆决策点先解析受限 Context；每个 Step 后写 Checkpoint 并重新观察真实状态。

当前内核已经能在连续无状态变化时转为 `needs_replan`，也能拒绝 Host 自述完成。但“不会阻塞、不会误停、不会重复副作用”还必须由真实 Host 证明：需要稳定 invocation fingerprint、heartbeat/lease epoch、按错误类型划分的重试预算、`effect_pending/unknown` 对账、里程碑 progress predicate、watchdog/orphan scan，以及进程崩溃、网络断开、写成功但 Receipt 丢失的故障注入。未通过这些测试前，只能称协议和 Fixture 已实现，不能声称真实长任务效果已证明。

关联：[上下文、记忆与后台整理](context-memory.md) · [Experience / Eval](experience-eval.md) · [当前能力矩阵](../current-capability-matrix.md)
