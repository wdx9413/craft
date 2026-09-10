# 自进化、自适应 Harness 与 Agent 评测：一手资料调研

> as_of: 2026-09-08
> 范围：自进化、自适应 Harness、Agent/多 Agent/子 Agent、Agent 评测；结合 Craft v0.9.8 与已确认的 v0.9.9 规划。
> 证据规则：**事实**只来自官方文档、官方规范或原始公开研究；**推论/建议**明确标注，不把预印本或厂商产品说明写成已被普遍证明的行业结论。
>
> **时效警示**：本文撰写于 v0.9.8/v0.9.9 时期，文中"缺口/规划"多数已在后续版本实现或调整。阅读时请把它当作历史调研基线，实施状态以 [技术模块文档](../technical/overview.zh-CN.md) 和 [产品路线](../product/roadmap.zh-CN.md) 为准。

## 2026-09-10 当前阅读说明（v0.11.37）

本文不再作为当前缺口清单。自该基线之后，Capability Asset/Activation Profile、受控 Host Dispatch/Run、Docker Conformance、可恢复 Worker、供应链认证、Evidence Wiki、Context Compiler、Wiki 候选与知识评测均已形成代码接口和测试；真实跨宿主链路、业务质量与生产安全仍需分别验收。当前决策是：短期以跨宿主治理插件层积累证据与评测数据，长期再把可替换的模型循环、Planner 与 Driver 做成自主 Agent 平台。

默认 Harness 保持最小；只有任务类、模型、预算和 held-out 证据支持时才增加 Skill、检索、Expert 或多 Agent 拓扑。策略是可替换 Capability，而不是永久写死在核心。新来源、Registry 与 A2A 接入边界见[可插拔能力源](../technical/modules/pluggable-capability-sources.md)。

## 简要结论

Craft v0.9.8 已经具备“受控闭环的内核”：版本化 Task/Trial/Trace/Outcome、确定性 Eval Runner、Promotion Assessment、只读 held-out Shadow、Signoff 准备态、运行策略与可恢复 Operation。v0.9.9 规划把最小能力集、Expert Profile 和只读 Sub-agent 纳入同一证据链，是合理的下一步。

但它们尚未构成“自动自进化的完整闭环”。缺的不是再加一个 Planner 或更多 Sub-agent，而是四项硬能力：

1. **可校准的比较**：重复 Trial、置信区间/显著性、等预算基线，以及经人工校准的模型 Judge；
2. **候选变更的受控产生**：从失败簇生成可审计的候选 diff，而不是把 Trace 摘要直接写回 Skill；
3. **真实隔离的执行控制**：容器/网络/凭据/补偿事务与工具信任链，不能由 Policy 文本替代；
4. **受审核的线上回流与渐进发布**：脱敏线上信号只能报警；要形成学习数据，仍需采样、人工审核、分区入集、影子/灰度和精确回滚。

因此，理想态应定义为“**以证据驱动、可拒绝、可回滚的受限自适应**”，而不是让模型自行改 Prompt、Skill 或拓扑。

## 一、可验证闭环应该如何组成

```text
版本化目标/约束
  → 最小能力集与受控 Run
  → Trial + Trace + 环境/Policy 指纹 + Outcome
  → 失败分类与候选假设
  → 候选配置/Skill/拓扑的可审计 diff
  → development / held-out 的独立评测
  → baseline 配对比较 + 统计/成本/安全门
  → Signoff + 渐进发布
  → 脱敏线上监测、人工审核后回灌 Case
  └──────────────────────────────────────→ 下一轮候选
```

### 闭环中的不可省略边界

| 环节 | 必须保存的事实 | 必须拒绝的捷径 |
| --- | --- | --- |
| 执行 | 精确 Subject/Harness/Policy/环境版本、真实工具回执、最终环境状态 | 模型说“已完成”即视为 Outcome 成功 |
| 候选 | 来源 Trial/Evidence、假设、适用范围、与基线的 diff | 从单条成功 Trace 自动发布 Skill |
| 评测 | 固定 Case 分区、重复 Trial、Grader 版本、成本/时延/人工介入 | 用不同 Case 集或不同环境的分数直接比较 |
| 晋级 | held-out 比较、阈值/置信规则、独立 Signoff、回滚目标 | 只因 development 通过或 Judge 自评高分就替换默认版本 |
| 线上回流 | 脱敏运行信号、采样理由、人工标注与分区变更记录 | 将生产原始对话或未验证结论直接写进经验库 |

**事实依据。** Anthropic 将 Task、Trial、Trace、Outcome、Evaluation Harness 和 Suite 明确区分，并指出 Outcome 应检查最终环境状态而非 agent 的文本自述；因输出存在随机性，Trial 应多次运行。[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

**推论。** Craft 的既有对象模型已经覆盖其中大半；后续重点应是将“候选生成、比较可信度、发布后反馈”接成受控状态机，而不是重建第二套 Trace 或 Gate。

## 二、业界已较成熟的做法

| 能力 | 一手事实 | 对 Craft 的推论 |
| --- | --- | --- |
| 持久运行与人工审批 | OpenAI Agents SDK 将敏感工具调用建模为 interruption；状态可序列化，批准/拒绝后恢复同一运行。其文档也列出 Dapr、Temporal、Restate、DBOS 等持久编排接入，用于失败恢复和 HITL。[Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)；[Running agents](https://openai.github.io/openai-agents-python/running_agents/) | Craft 的 `Runtime Run → Operation → Lease/Approval/Receipt` 方向正确。v0.9.9 应让 Sub-agent 也完全进入同一 RunState/预算/审批链，而非仅有 Orchestration 记录。 |
| 多层评测 | Anthropic 将 code、model、human grader 视为互补：代码检查可复现但脆弱；模型 Judge 灵活但需人工校准；人工是高质量基准。[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | 继续以确定性 Grader 为 Promotion 基础；模型/业务 Grader 只能作为带版本和校准证据的附加 Gate，不能替代测试、状态检查和人工 Signoff。 |
| 离线比较 + 线上监测 | LangSmith 文档区分离线 benchmark/unit/regression/backtest 与线上 monitoring/anomaly detection；线上问题可转为新的离线测试。它也提供以专家标注反复校准 LLM Judge 的流程。[Evaluation types](https://docs.langchain.com/langsmith/evaluation-types)；[Improve LLM-as-a-judge using human feedback](https://docs.langchain.com/langsmith/improve-judge-evaluator-feedback) | Craft 已有脱敏 Operational Signal/漂移告警，下一步应补“审核后的线上 Case 入 development/held-out”的数据治理，而不是让 Operational Signal 直接触发发布。 |
| Eval-fix/优化工具链 | Google Agents CLI 提供 generate、grade、compare、failure analyze、合成多轮数据集和 `eval optimize`；其文档明确建议先完成 eval，再进行自动 Prompt 优化，且一次优化可能耗时数小时。[Evaluation Guide](https://google.github.io/agents-cli/guide/evaluation/) | Craft 的 Proposal/Shadow/Signoff 应保留“先建评测、再优化”的顺序。可借鉴失败聚类和受控优化，但优化输出只能作为 draft Candidate。 |
| 长程 Harness 的独立评估 | Anthropic 的长程开发 Harness 将 Planner、Generator、Evaluator 分工；Evaluator 在每个 sprint 依据合同运行实际应用并给出可行动反馈。文章同时强调不要把机制固定化：模型能力提高后，额外 Harness 可能变成开销。[Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) | v0.9.9 的只读 `diagnostic_research` Expert 是合适的最小切入。高风险任务才应启用独立 Evaluator；不能把多 Agent 作为默认质量保证。 |
| 工具与数据授权 | MCP 规范要求用户理解并同意数据访问和工具调用，且把工具视为任意代码执行；工具注解除非来自可信 Server，否则不可当作可信安全描述。[MCP Specification](https://modelcontextprotocol.io/specification/2025-03-26/index) | v0.9.9 Capability Asset/Activation Profile 必须携带来源、信任状态、Effect、授权和健康证据。`Skill/MCP 被发现`、`被激活`、`获授权执行` 必须是三种不同状态。 |

## 三、新兴做法及其边界

| 新兴方向 | 原始研究事实 | 采用边界 |
| --- | --- | --- |
| 自动 Harness 演进 | HarnessDev 直接评估“创建/演进可运行 Harness”；其结果显示演进会有部分提升，但不稳定、向 held-out 的迁移有限，且生成 Harness 在代码、搜索/研究领域仍明显弱于成熟人工 Harness。[HarnessDev, 2026-09-01 预印本](https://arxiv.org/abs/2609.01437) | 不应让 Craft 自动替换默认 Harness。只允许生成 `proposal_only`，并要求隔离 held-out、成本上限、独立 Signoff 和 exact rollback。 |
| 多日迭代式改进 | Harness-of-Harness 报告将开发拆成小而可验证的增量、分离实现期测试与独立评估、保留版本历史，并逐步暴露角色工具和 Skill。[Harness-of-Harness, 2026-09-01 预印本](https://arxiv.org/abs/2609.01481) | 与 Craft 的安全增量 Kit、Shadow 和版本化对象一致；但这是单篇预印本的报告，不足以支持自动化发布，应只作为架构灵感。 |
| 自适应多 Agent 拓扑 | Codebook Agent 报告：以实测 token 成本和效用选择少量拓扑，在其六个基准上减少 token；其消融也显示仅减少通信边并不是可靠成本代理。[Codebook Agent, 2026-09-02 预印本](https://arxiv.org/abs/2609.02264) | v0.9.9 应先记录并评测“任务特征 → Profile/Expert/拓扑 → 实测质量/成本”，形成数据后才做自适应选择器；不能依据 Agent 数、边数或向量相似度直接决定拓扑。 |
| 受控比较 Harness 设计轴 | RefactorPlatform 固定环境、改变模型/检索/多 Agent/提示等设计轴，并记录 token、diff、transcript，以 AST 验证实现可复现对比。[RefactorPlatform, 2026-09-04 预印本](https://arxiv.org/abs/2609.04898) | Craft 的 Shadow 应扩展成“同环境、同 Case、同预算”的设计轴实验；把单 Agent、带检索、带 Expert/Sub-agent 当作可比较 Candidate，而非默认叠加。 |
| Agent 间互操作 | A2A 以状态化 Task、Artifact、Agent Card、异步更新和 HITL 为模型，允许不暴露内部推理/工具的协作。[A2A Specification](https://a2a-protocol.org/v0.3.0/specification/) | Agent IR/Capability Asset 可为未来 A2A Adapter 预留 `task_id`、能力声明、Artifact 和状态映射；但 A2A 解决互操作，不提供 Craft 所需的质量 Gate、授权或自进化证明。 |

## 四、Craft v0.9.8 与计划 v0.9.9 的核心缺口

### 已有基础（事实）

- v0.9.8 已将重复成功/失败的脱敏经验候选限制为 `proposal_only`，再送入只读 held-out Shadow；Promotion 只形成指定 Signoff 的准备态，不能直接发布。
- v0.9.9 规划已定义 Capability Asset、Activation Profile、Tool Selection Receipt、`diagnostic_research` Expert、只读 Sub-agent Run，以及 Profile/Expert/拓扑进入同一评测对象。
- 当前文档仍明确未实现：通用模型循环、真实容器/网络沙箱、短期凭据代理、模型/业务 Grader 自动执行、统计显著性、Kit Registry、远程 Hub、预算预估和补偿事务。

以上来自 [架构文档](../architecture.zh-CN.md)、[Experience/Eval 模块](../technical/modules/experience-eval.md)、[Runtime 模块](../technical/modules/closed-loop-runtime.md) 和 [v0.9.9 规划](../product/capability-expert-subagent-plan.zh-CN.md)。

### 仍缺的核心能力（推论与推荐）

| 优先级 | 缺口 | 为什么 v0.9.9 后仍需要它 | 最小充分实现 |
| --- | --- | --- | --- |
| P0 | 评测可信度层 | 现有 Comparison 是描述统计；同一 Candidate 的一次或少量成功无法区分噪声、模型波动和真实提升。 | 成对 Case 的重复 Trial；预先定义的 bootstrap/置信区间或序贯检验；等预算比较；检验条件不满足时输出 `inconclusive`，不晋级。 |
| P0 | Judge 校准与执行 | 模型/业务 Grader 仍靠 Host 回填；没有校准就不能安全地让 Judge 决定 Promotion。 | 版本化 Judge Adapter；盲评/对照评测；人工金标抽样、judge-human 一致性阈值和漂移复测；校准失败时降级为 advisory。 |
| P0 | 实际执行隔离 | Runtime 的 allowlist 不是网络/文件/凭据隔离；写入型 Agent 和远程 MCP 的风险不能由提示词补足。 | 受信任 Adapter 的容器/工作区隔离、网络 egress policy、短期 scoped credential、审计日志；不可补偿 Effect 默认不自动执行。 |
| P0 | 线上到离线的受审核回流 | 漂移告警只能发现问题，不能生产代表性、无污染的训练/评测数据。 | Trace 脱敏采样 → 人工标注/去重/敏感检查 → immutable Case 版本 → development 或 held-out 分区；保留来源及批准记录。 |
| P1 | 自动候选生成与归因 | v0.9.8 只能生成候选摘要，尚不能确定“哪一项 Harness 改动导致改善”。 | Trace failure taxonomy + 聚类；每次 Candidate 只改一到两个明确轴（Profile、工具集、上下文、拓扑等）；记录 diff 和反事实 baseline；先生产 Draft。 |
| P1 | 自适应选择器 | v0.9.9 可评测 Profile/Expert/拓扑，但尚无基于历史证据选择它们的机制。 | 先用规则/阈值选择最小 Harness；积累充分可比 Case 后再训练或配置 contextual policy；探索流量只走 shadow/canary，不能直接扩大权限。 |
| P1 | 渐进发布与回滚运营 | Signoff 证明离线可接受，不证明在线分布或成本稳定。 | 精确版本 canary、固定回滚阈值、监测窗口、自动暂停新流量、保留已批准 baseline；线上变化不能自动修改 held-out 集。 |
| P2 | Capability Kit Registry / 供应链 | Asset Catalog 解决登记，但不解决依赖解析、来源签名、漏洞/健康更新和跨 Host 发布。 | 先做本地 Registry：digest、签名/来源、依赖锁定、健康检查、弃用状态；远程 Hub/A2A 在该基础后接入。 |

## 五、推荐路线

### v0.9.9：按既有计划收敛“最小能力集 + 只读 Expert”

1. 完成 Asset Catalog、Activation Profile、Tool Selection Receipt 的可复现评测；先测正确资产 Top-K、错误/无效调用、首个有效动作时延、token 与权限拒绝率。
2. 只上线 `diagnostic_research`，并强制 Context Capsule、只读 Effect、父任务裁决和根 Run 资源账本。
3. 将单 Agent、带检索、带 Expert/Sub-agent 作为并列 Candidate，用同 Case/环境/预算做比较；没有证据不默认走多 Agent。

### v0.9.10：先补“比较是否可信”

1. 引入可比性预检查、重复 Trial、等预算基线和 `inconclusive` 状态。
2. 引入模型/业务 Grader Adapter 与人工校准队列；未校准的 Judge 只能作诊断，不得阻断或晋级。
3. 增加线上 Trace 的审核入集流程，development 与 held-out 由不可变版本和独立权限隔离。

### v0.9.11：再补“受限自进化”

1. Experience Miner 只产生带来源、假设、配置 diff、适用范围和风险的 Draft。
2. Shadow 运行 held-out paired evaluation；达标后仍经过 Signoff 与 canary，不允许候选自行发布。
3. 每次演进只允许改变声明的 Harness 设计轴；无法归因或出现质量/成本/安全冲突时回到 baseline。

### v0.9.12：最后补“自适应与写入型子任务”

1. 基于已有可比记录选择最小 Harness，并以 shadow/canary 做受限探索。
2. 在真实沙箱、网络/凭据隔离、文件所有权、合并测试/Diff Gate、补偿/人工审批都可用后，才开放写入型 Sub-agent。
3. 再评估远程 Hub、A2A 和自动激活；它们是分发/互操作层，不能抢在执行控制和评测可信度之前。

## 非结论

- 向量检索提高候选召回，不证明选择正确，更不等于允许执行。
- 多 Agent、更多工具、更多评审轮次都不是质量保证；必须在固定环境和等预算下与更简单基线比较。
- 自动优化或自动生成 Harness 的预印本结果不是生产准入证据。
- LLM-as-Judge 不是程序证明；没有版本、金标校准、漂移复测和人工升级路径时，不应作为唯一 Gate。
