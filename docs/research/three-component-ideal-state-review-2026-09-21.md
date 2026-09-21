# Craft Knowledge、Memory、Experience 三组件：理想态缺口与验证路线（2026-09-21）

## 范围与结论

本文只审查可独立安装的 `craft-knowledge`、`craft-memory`、`craft-experience`，不评价 Craft 主运行时、多 Agent 或通用 Capability 市场。结论基于当前工作树（基线提交 `26db618`，另有未提交的 Hook 兼容修复）、组件代码和一手资料；“行业事实”与“对 Craft 的推断”明确分开。

三个组件的方向是正确的：

```text
Knowledge  = 可复核、可撤销的外部主张
Memory     = 有 scope 和时效的长期上下文
Experience = 从多次真实终态归纳出的受限改进候选
Context    = 三者的预算化、可复现投影，不是新的事实源
```

但它们尚未构成“单独装进 Codex 后会可靠积累、在正确决策点想起、再以可测方式长出 N 套工作流”的完整产品闭环。最重要的不是继续增加记录类型，而是先补齐 **真实召回、来源保鲜、经验编译、单点评测** 四条链。

## 一手资料的可核验结论

1. Anthropic 将 context 视为有限的注意力预算，建议只保留最小高信号信息，并通过 just-in-time retrieval、progressive disclosure、结构化笔记和 compaction 处理长任务；不建议把所有历史一次性注入。[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
2. OpenAI 将会话历史 (`Session`) 与从过往运行提炼出的 Sandbox Memory 明确分开；前者是可恢复的对话状态，后者是写入工作区、供后续运行检索的提炼经验。二者不应混为一个“长期记忆库”。[Sessions](https://openai.github.io/openai-agents-js/guides/sessions/) · [Sandbox agent memory](https://openai.github.io/openai-agents-python/sandbox/memory/)
3. Mem0 的官方 benchmark 使用 `Ingest → Search → Evaluate` 三阶段，覆盖知识更新、时间推理、多会话、矛盾消解和 abstention；其公开结果中 `contradiction_resolution` 与 `abstention` 是相对薄弱项。混合检索（语义、关键词、实体）并不免除 scope 与冲突治理。[memory-benchmarks](https://github.com/mem0ai/memory-benchmarks)
4. WikiSkill 论文将不可变 raw trace、持久 Wiki、当前可执行 Skill 分开；候选改动在验证集上接收或回滚，拒绝理由保留。论文是研究证据，不是生产准入证据。[WikiSkill](https://arxiv.org/abs/2608.27454)
5. Anthropic 的 Agent Eval 指南要求以环境真实终态作为 Outcome，使用多 Trial、隔离环境和确定性验证器；模型自述和单次成功不足以证明改进。[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
6. OpenAI Agents SDK 的 Trace 可记录 Task→Agent→Turn→模型/工具/Guardrail 的层级，并允许关闭敏感输入输出采集；这支持从 Trace 指针和真实 Outcome 形成 Experience，而非复制完整 transcript。[Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)

## 当前实现中已经正确的部分

### Knowledge

- `KnowledgeSource`、Evidence、Claim、Relation、有效期、冲突和 `Context Resolution Receipt` 已形成可审计基础。
- `KnowledgeContribution` 仅把 `reviewed`、未过期、来源未撤销的 Claim 投影进 Context；候选不会直接成为执行说明。
- 已有自动晋升策略、独立 Evidence support 和来源 digest 绑定；`hostReview` 可以记录 Codex/Claude 作为审阅方，而不要求 Craft 保存模型密钥。
- 有可迁移的 Markdown 正文 + SQLite 索引和 bundle 导入计划，且导入不覆盖本地记录。

### Memory

- `MemoryLedger` 保存 source/version、scope、sensitivity、Evidence、TTL、内容 digest 与 supersede/revoke/expire 历史。
- 显式用户陈述可形成 Evidence，再作为受治理候选进入 Ledger；同 scope、同 topic 的不同内容会进入冲突，而不是覆盖旧条目。
- 当前实现能正确表达“喜欢咖啡”和“戒糖”是不同 topic；同一 `preference:diet:sugar` 的新陈述可 supersede 旧条目。

### Experience

- Observation 要求 Evidence，并要求至少两个独立 source record 才能 compile Pattern；干预最多改两个设计轴。
- Pattern 默认 `diagnostic_only`、`execution_visible: false`；未经过评测、Signoff 和进一步路由，不能修改现有 Skill、Workflow 或默认拓扑。
- Workflow Evolution 对 graph 有明确入口，并要求候选在进入模型生成前先有两个独立观察。

这些边界应保留。尤其不能为了“自进化”倒退到“模型每次总结都自动改 SKILL.md / Workflow”。

## P0：已实现机制必须补真实证明的缺口

### P0-1：检索与时间冲突机制已落地，但没有真实 Provider / Host 收益证据

当前未提交工作树已经有 `RetrievalPort`、OpenAI-compatible embedding Adapter、keyword fallback、hybrid 合并和 `TemporalConflictResolver`；回归也验证了 Provider 凭据缺失时 Receipt 如实写为 keyword fallback，而不是伪造 vector。`topic + effective_from + supersede/revoke + expiry` 的冲突拒答也已有确定性覆盖。

还没有证明的是它们在真实数据上比 keyword-only 更好：目前没有配置真实 embedding Provider 的受控 Case，也没有把 entity、usage/纠正信号、recency 作为经评测的独立 ranker。这个差别必须写清：**机制存在，不等于 vector/hybrid 已获路由资格。**

建议：

1. 用同一 held-out 集跑 keyword-only、vector、hybrid，逐项记录 recall、跨 scope 泄漏、冲突误注入、时延与成本；没有净收益就保持 keyword。
2. Receipt 继续写实际 `used`、Provider/模型 revision、得分和过滤理由；新增 entity/usage/recency 前先定义可复现融合公式与消融实验。
3. 固定最低回归集：旧偏好被新偏好替代、并存不冲突的偏好、过期事实、跨项目泄漏、应拒答的冲突、历史时点问答。

### P0-2：Knowledge ingest/revision 已实现，仍缺“语义提取—保鲜—再评测”的完整闭环

当前 `KnowledgeSourceRegistry.sourceIngest` 已能对受限本地 Markdown/README 生成不可变 Source Revision、fragment、Evidence 和 Candidate；来源变化会将旧 reviewed Claim 标为 `stale`。这解决了“Source 只是描述符”的第一步。

尚未完成的是高质量知识生命周期：现有 ingest 按字符切分并将 fragment 原样当作 Candidate Claim，尚未做可验证的 claim extraction、语义去重/关系提取、增量 chunk 重用、Context Receipt 失效重算与大库保鲜评测。因此它现在适合作为**保守的来源导入器**，不能宣称为成熟的 LLM Wiki 编译器。

下一步应保持 `KnowledgeIngestPort` 独立，沿用：

```text
discover → fetch/read → normalize/chunk → Evidence fragment
→ Claim candidate → review/promotion → source revision
→ invalidate affected Context Receipt → eval
```

每条 Claim 应链接精确 fragment/digest/offset；Source drift 必须触发 `stale` / `revalidation_required`。后续以只读 Markdown/README/Serena 的增量 refresh 与 fragment-level re-eval 为先，不急于接图数据库或远程爬虫。

### P0-3：当前“自动 Knowledge Review”是结构完整性审查，不是 AI/语义复核

`KnowledgeAutoReviewKernel` 的注释已准确说明它不是 LLM fact checker：它检查 active Source、Evidence、正文可读性、scope、有效期、冲突及独立 support。它很重要，但不能证明 Claim 的语义是否被原始 Evidence 支持；`hostReview` 也只是将 Host 给出的 decision 记为 attest，并不触发 Codex/Claude 自己阅读证据做审阅。

应把两件事明确拆开：

- **结构晋升（可自动）**：来源、Evidence、时效、独立支持、无冲突均满足阈值，可自动进入 `reviewed_structural`；
- **语义复核（可自动执行但可追溯）**：由当前 Host 或配置模型读 Claim、Evidence fragment 与 rubric，输出 `supported / contradicted / insufficient / out_of_scope`，附模型、prompt digest、source revision、引用片段和置信度。

在低风险、只读 Context 中，可以配置“结构 + 语义均通过则自动晋升”；一旦 Claim 会影响写入策略、权限或工作流路由，仍需独立 Eval 后才可作为 route input。这样不要求人工逐条审核，也不会把“自动检查”误称为事实验证。

### P0-4：Experience 有两条并行账本，且其 Context 贡献不能改变后续决策

当前存在两条相似但未统一的链：

```text
ExperienceObservation → ExperiencePattern → ExperienceIntervention
WorkflowEvolutionObservation → Request → WorkflowEvolutionProposal
```

两者均可表示“由观察产生候选”，但 Evidence、scenario、生命周期和评测引用不完全一致。与此同时 `ExperienceContribution` 为安全而只返回 digest/reference；其 Pattern 不保存 hypothesis/applicability/counterexample 正文，`execution_visible` 恒为 false。该设计避免把未验证经验泄漏给执行 Host，但也意味着单独安装的 `craft-experience` 不能把“已验证的做法”在决策点交给 Codex。

建议统一为一个 Experience 数据模型：

```text
Raw Observation (Trace / Receipt / Outcome pointer)
→ Pattern (trigger, applicability, counterexample, evidence)
→ Candidate (immutable diff, purpose, verifier, regression cases)
→ Evaluation result
→ Routeable Asset pointer | Rollback
```

其中 Pattern 正文可保存在受管 Markdown/Wiki，默认只让 maintainer/read-only reviewer 读取；只有 Candidate 已经通过 `Shadow → repeated held-out → calibrated signoff → canary` 后，才生成给执行 Host 的短小、版本固定、可撤销的 Procedure Projection。这个 projection 不是直接注入原始复盘，更不能替代 Tool/Permission Policy。

### P0-5：三个组件都缺“可证明对 Codex 有收益”的独立评测闭环

Capability descriptor 只声明 fixture id 和 Host compatibility；现有 fixture 能证明数据结构、边界和 MCP 工具面，但不能证明 Codex 更会做事。应为三个组件各建独立 Case × baseline/candidate × N-trial 评测：

| 组件 | 最小终态指标 | 必须的反例 |
|---|---|---|
| Knowledge | Evidence coverage、事实准确率、source freshness、正确 abstention | 过期来源、无证据 Claim、跨项目来源 |
| Memory | 当前偏好/历史问答准确率、冲突不误注入、跨 scope 泄漏率、token/latency | 新旧偏好、同名不同项目、应不记住的聊天 |
| Experience | 老错误复发率、真实 Outcome、无效重试率、成本/时延 | 单次偶然成功、失败 Candidate、held-out 回归 |

固定 Host、模型、环境、预算、Case/Verifier 版本；每个候选至少 3–5 次配对 Trial。没有校准的 LLM Judge 只能做诊断，不可推动路由。这个要求来自 Outcome-first eval 的工程原则，不是人为增加审批成本。

## P1：使三个组件能持续积累而不失控

### P1-1：明确三类状态，并避免 Working Memory 污染长期 Memory

当前 `working` 仍写入 Memory Ledger，只是默认 24 小时 TTL；Context Resolver 又不按 kind 排序。建议正式分为：

- `Run/Session State`：当前目标、Plan、Step、未完成 action、checkpoint；可恢复但不做跨任务知识检索；
- `Working Notes`：短时、可压缩、task/session scope；任务结束后过期或降级；
- `Long-term Memory`：episodic/preference/procedural，仅以 scope、Evidence、topic、TTL、supersede/revoke 进入检索。

短时状态和长期偏好有不同的读写模式，不能只用不同 `kind` 共用一个 keyword search 来解决。

### P1-2：补齐明确的 scope 组合与遮蔽契约

当前实现已引入 Git-first canonical project identity、路径/legacy alias，并在 Context Receipt 记录已尝试 scope；但 stack 仍主要覆盖 `task → project`，`user` 继承、同 topic 的遮蔽优先级和跨 Host 用户身份绑定尚未形成统一契约。理想态不是无条件“全局回退”，而是可配置的 scope stack，例如：

```text
task → project → user
```

每一层声明是否可继承、可覆盖和可共享；同 topic 先在更具体 scope 解析，再考虑父 scope。Receipt 应记录尝试过哪些 scope、为何未选/被遮蔽，防止“用户偏好”悄然扩散为“项目规则”。

### P1-3：从自由文本 `scenario_key` 升级为可比较的 Scenario Signature

Experience 目前以任意 `scenario_key` 聚合，容易把同类事故拆散或把不同任务误合并。建议由可脱敏的字段构成：`target_class`、`environment_fingerprint`、`effect_class`、`verifier_id`、`failure_signature`、`capability/version`。自然语言描述仍保留在 Evidence/Wiki，但重复观察和回归集必须以稳定 signature 对齐。

### P1-4：被拒绝 Candidate 的再试条件需要是一等索引

现有 Candidate 有 retry condition/digest，但尚未形成跨两条 Experience 链统一的“拒绝方案去重 + 新证据判定”。应建立 `ReconsiderationIndex`，以 candidate diff digest、scenario signature、受影响 Case、拒绝原因、重新考虑条件为键。没有新 Evidence 或环境/模型/Verifier 变化时，禁止反复提同一方案。

### P1-5：跨机器 Bundle 需增加增量同步语义与密钥边界

现有 bundle 的“add / duplicate / conflict，不覆盖”是安全的第一步。后续应增加：导出 cursor/revision、来源/设备标识、可重放 merge receipt、按 scope 的签名/加密 Adapter，以及“导入只产生 candidate”选项。不得同步 API key、完整 transcript、未脱敏工具输出或本机自动晋升阈值。

## P2：在 P0/P1 有真实数据后再做

1. **实际向量/混合 Retrieval Adapter**：先在 Knowledge/Memory held-out 集证明 recall、leakage、时延和成本比 keyword-only 有净收益，再启用；不要先上图数据库。
2. **Maintenance / Dreaming Worker**：Light 做 TTL、去重、健康检查；Review 做冲突/来源/使用信号；Deep 只创建 Pattern/Candidate。触发应受空闲窗口、预算、工作区隔离和最大批次约束。
3. **Graph Procedure**：仅当存在分支、并行汇合、审批或恢复关系时生成；节点必须声明读写 State、effect、precondition、验收和失败路径。顺序稳定任务仍是线性 Workflow。
4. **跨 Host 组件 Conformance**：将 Codex、Claude、CLI/Fixture 分开记录为 `mechanism_passed / host_verified / business_eligible`，不因 MCP handshake 成功就宣称跨 Host 效果一致。

## 建议的最小落地顺序

1. 修正 Retrieval Receipt 的真实性：关闭伪向量标记，接入真实 ranker 或明确 unavailable；补 Memory 的时间/冲突/拒答回归集。
2. 建立 Knowledge ingest/revision/fragment/evidence 链和真正可自动执行的语义 review worker；保留结构晋升与语义复核的不同状态。
3. 合并 Experience 两条候选链，以 Scenario Signature 和同一 Evaluation Gate 管理；把已 routeable Procedure 投影与 diagnostic Pattern 严格分开。
4. 先固定 2–3 个 Coding Case，跑三个单点的 baseline/candidate 3–5 次对照；只把真实降低错误复发率、提高终态达成率的候选进入灰度。

衡量“持续进化”时，首要看 **同类已知失败的复发率是否下降且未伤害保留集**，而不是 Knowledge/Memory 条数、Workflow 数量或模型自评得分。

## 非建议

- 不把完整聊天记录自动写入 Memory；
- 不把 Candidate Knowledge、Pattern 或模型复盘直接当执行规则；
- 不用全局行业标签或图数据库替代 scope、Evidence、时效和 Context Receipt；
- 不以单次成功、未校准 Judge 或 Agent 自述发布 Workflow；
- 不让“自动 AI 审核”绕过来源、独立 Evidence、回归集和 effect Policy。
