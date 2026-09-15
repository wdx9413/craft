# 自进化、记忆与插件架构取舍：WikiSkill、Möbius、DSH 与企业 Ontology

日期：2026-09-15。本文将用户提供的五类观点与 Craft v0.12.30 对照。它们多数是
开源项目/论文或项目自述，而非协议标准；因此“项目事实”和“对 Craft 的推论”严格分开。

## 总结

Craft 不需要把自己变成 WikiSkill、Möbius 或 DSH 的复刻品。最正确的组合是：

```text
Raw run / feedback → Evidence + Trace
                         ↓
            受治理的 Knowledge / Memory Ledger
                         ↓
          Context Receipt / Candidate Skill or Workflow
                         ↓
        Eval → Signoff → Canary → 可撤销的 verified version
```

Craft 已拥有该闭环的大部分控制面。应采纳的是这些项目对“**经验、知识、记忆、能力
资产必须分层且有生命周期**”的强化；应补的是可验证的 Knowledge→Skill 编译、可选
Memory 验证锚、组件生命周期 conformance 与真实纵切评测。不能采纳的是自动改写默认
Prompt/Skill/系统本身、把全部聊天存成 Memory、默认多 Agent，或把企业 Ontology 变成
全局强制分类树。

## 对照总表

| 主题 | 可采纳 | Craft 已有 | 仍有缺口 | 不应采纳 |
|---|---|---|---|---|
| WikiSkill | Experience → Wiki → Candidate Skill 的三层分离；失败经验保留 | Trace/Evidence、Evidence Wiki、Workflow/Skill Candidate、Eval/Signoff/Canary | 可审计 Wiki Maintainer / Skill Compiler 的统一纵切与真实 Case 验证 | 一次反思直接覆盖 Skill 或 Prompt |
| Möbius | 长任务、反思、可见工作历史、用户可控自托管工作区 | Project/Work Session、Checkpoint、Runtime/Trace、受限 Continual Harness | 真实持久 Worker/通知/工作台纵切和可部署 Host | Agent 静默自改系统、UI 或社区资产 |
| DSH 插件/记忆 | workspace-scoped memory、显式读写、按生命周期挂载 MCP | Memory scope/revoke、Context Receipt、Kit/Activation/Ticket | 组件安装/启停/卸载的 Host 资源清理 conformance | 每个内部模块都独立 Server 或任意 Hook 执行 |
| 企业 Ontology | 高价值领域可用 schema 约束实体/关系/查询 | Claim、Relation、Evidence、scope、digest | 可选 Typed Ontology Adapter 与来源/推理/失效评测 | 全局行业树、强制图谱或把推理结果写成事实 |
| 记忆治理 | 状态类 Memory 需时间、来源、验证锚与失效处理 | Evidence、expiry、revoke、Context Receipt、再观察 | 可选 `verify_anchor` 和调度式 revalidation，真实语料评测 | 把 Memory 当实时世界状态或自动跨项目泛化 |

## 1. WikiSkill：采纳“知识编译”，不采纳无门禁技能自改

### 项目事实

WikiSkill 将原始执行经验、可复用 Wiki 和可执行 Skill 分开；Wiki Maintainer 提炼经验，
Skill Proposer 产生候选，候选必须在验证任务上优于旧版本才保留。其论文/实现明确将
失败经验留在 Wiki，而不是只保存通过的轨迹。

来源：[WikiSkill paper](https://arxiv.org/abs/2608.27454)、
[WikiSkill reference implementation](https://github.com/Stahl-G/wikiskill)。

### Craft 已有

- `Trace/Evidence/Outcome` 已是原始运行与观察的可信事实层；
- Evidence Wiki 的 Claim/Relation 有来源、证据、状态与版本；
- Workflow/Skill Candidate 有最多两个设计轴约束，并经过 Evaluation、Signoff、Canary；
- 失败不能被“成功经验”覆盖，候选不直接发布。

### 可采纳的缺口

新增的是 **Wiki-to-Capability Compiler**，而非第二个知识库：仅从多个 confirmed/bounded
运行中提取“失败模式、反例、适用条件、证据引用、候选差异”，输出当前 `draft` Skill/
Workflow Candidate；同时留下“为何 rejected”的 Wiki Claim。它应直接复用 Craft Quality，
不新建 Gate。

首个验收应是一个真实、脱敏的重复场景：基线与候选在固定 Case/Host/预算下多次比较，
候选只有通过既有 Signoff/Canary 才成为 `verified` Capability。

### 不能采纳

不能让 Maintainer/Proposer 自动覆盖 `SKILL.md`、默认 Harness 或系统 Prompt；不能把单
次失败归因写成全局规律；不能把原始业务轨迹全部复制到 Craft Wiki。

## 2. Möbius：采纳“可见的长期工作台”，不采纳自改平台叙事

### 项目事实

Möbius 将 Agent、应用、文件、记忆、技能、计划任务和工作历史放在用户控制的工作区，
强调后台反思、可见子任务与可逆的用户反馈积累；其项目也宣称能自我修改 UI/流程。

来源：[Möbius OS](https://github.com/mobius-os/mobius)、
[Mobius self-evolving Agent OS](https://github.com/mobius-system/mobius)。

### Craft 已有

Project Brain/Work Session、Durable Wait/Checkpoint、Trace、Attention/Workbench 投影、
Memory/Knowledge、Capability 和受限 Continual Harness 已经提供了比“聊天记录”更合适的
状态事实模型。

### 可采纳的缺口

应完成一个 **真实 Long-running Work vertical slice**：用户目标 → Work Session → 实际
Host dispatch → Session Event → 独立 Outcome Observer → pause/resume/notification →
acceptance。它应复用现有数据结构，并按用户策略决定何时自动继续、何时升级求证、何时
停止，不需要先做复杂 UI。

### 不能采纳

Möbius 式“平台自行重写”不应进入 Craft 默认模式。Craft 的自进化是版本化 Candidate
的受控晋级，不是 Agent 改 Runtime 代码、UI、权限或他人资产；即使长期可无人工介入，
也必须由客观 Outcome、预算、安全和回滚门约束。

## 3. DSH：采纳 Plugin 生命周期与项目边界，不复制 Host 框架

### 项目事实

DSH Autopilot 将 project-keyed revisioned Memory、显式 memory CRUD/交接、路径匹配的
Prompt Rules 与受 allowlist 约束、仅在 Agent 生命周期内挂载的 Skill MCP 分为独立
组件；其 bundle disposal 会撤回注册并释放其拥有的资源。

来源：[oh-my-dsh architecture](https://github.com/LiuMengxuan04/oh-my-dsh/blob/main/docs/architecture.md)。

### Craft 已有

Craft 的 Memory 有 scope/expiry/revoke；Context 以 Receipt 固定；Capability Kit/Connector/
Activation/Ticket 将发现、激活、授权、调用分开；Plugin 只是 MCP Runtime 的薄分发层。

### 可采纳的缺口

为 Component Contract 增加 **Host Lifecycle Conformance**：安装、启用、停用、升级、
撤销、进程崩溃、重连时，验证 MCP Server/订阅/缓存/临时上下文是否被精确创建与清理；
数据空间、Effect、依赖、健康和 deprecation 必须可查询。这个能力应服务
`craft-context/capability/quality` 等正式产品面，而不是创建更多孤立插件。

### 不能采纳

不将 DSH 的 Host 运行时或任意事件 Hook 移入 Craft Core；“dispose”不是隔离边界，
任意第三方代码仍需要 Sandbox、Permission 和 Supply-chain 验证。

## 4. 记忆：采纳分层、验证与按需读取，避免把日志当真相

### 外部事实

Anthropic 将上下文视为有限注意力预算，主张每轮从不断增长的信息空间挑选最相关内容；
结构化笔记存放在 Context Window 外，再按需回填。OpenAI Sandbox Memory 也将会话历史
和经提炼的跨运行 Memory 分开，并允许只读 Memory 的子 Agent。

来源：[Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)、
[OpenAI Agent memory](https://openai.github.io/openai-agents-python/sandbox/memory/)。

memgov 提供了额外的工程提醒：状态型记忆是某时刻快照，应带日期与可执行的验证锚，
避免被其他人/Agent 的环境改动悄然弄过期。

来源：[memgov](https://github.com/mobius-style/memgov)。

### Craft 已有

KnowledgeSource、MemoryLedger、Context Receipt 已按 source/scope/sensitivity/evidence/
expiry/revoke 分层；Serena/Markdown 保持来源所有权；向量检索只能在泄漏/召回/成本评测
通过后启用。

### 可采纳的缺口

给“状态型 Memory/Claim”增加可选 `verify_anchor`：一个只读、受 effect/权限/频率/预算
限制的查询、路径或测试引用。Context Resolver 只将 `verified_at` 尚有效的状态事实提升
为强上下文；过期后降为 bounded/stale 或触发最小 re-observation。该能力应先在本地文件/
CI 状态等可观察事实试点，且必须有跨项目泄漏、错误锚、锚失效、成本和 Outcome 影响的
评测。

### 不能采纳

不自动把每轮对话写为长期 Memory；不让一个 Agent 的推测跨用户/项目成为公共知识；不把
向量相似度或 Ontology 推理结果当作 confirmed Evidence。

## 5. 企业 Ontology：作为可选、受证据约束的领域 Adapter

### 项目事实

`dsh-ontology` 将概念/关系定义（TBox）和实体断言（ABox）分开，并按 schema 对 Agent
写入和查询施加类型约束；这适合依赖/权限/资产等关系错误代价高的领域。

来源：[dsh-ontology](https://github.com/tancheng33/dsh-ontology)。

### Craft 已有

Evidence Wiki 的 `knowledge_claim`/`knowledge_relation` 已能表示事实、支持/矛盾/替代/
依赖关系，且有 scope、digest、Evidence 和失效边界。它已经是通用工作 Runtime 所需的
最小关系层。

### 可采纳的缺口

增加可插拔 **Typed Ontology Adapter**，只供明确选择的企业/项目 Domain 使用：

- schema 版本、实体/关系类型、可允许的推理规则均为 Capability Kit 资产；
- assertion 必须指向 Evidence/Source，inference 单独标为 derived/bounded；
- schema、来源或事实漂移使结果失效，并进入 Context/Quality Receipt；
- 通过一个高价值领域的 conformance Case 证明错误关系减少、查询/上下文成本可接受。

### 不能采纳

不建立全局行业标签树或强制知识图谱；不让 Ontology 根据语义猜测自动扩大权限、路由或
执行范围；不将企业内部本体正文复制到公共 Craft 数据空间。

## 推荐落地顺序

1. **先做真实纵切**：双 Host + 双 Case 的 Runtime Acceptance Campaign，并从中验证
   Wiki-to-Capability Candidate 与 verify-anchor 是否真的改善 Outcome。
2. **其次做 Component Host Lifecycle Conformance 与供应链治理**：保证插件/MCP 的
   安装、缩面、撤销与崩溃恢复不会形成资源泄漏或工具爆炸。
3. **最后按真实领域选择 Typed Ontology Adapter**：它应是企业知识/关系场景的增强，
   不是通用 Runtime 的默认依赖。

一句话：**Craft 的进化应是“经验经证据编译为候选能力，再由真实结果选择保留”，而不是
“Agent 自动改自己”；其记忆应是可见、可撤销、可验证的工作事实，而不是无限聊天存档。**
