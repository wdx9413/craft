# Craft Knowledge / Memory / Experience：分层、Scope 与生命周期研究（2026-09-21）

## 范围与结论

本文只研究 `craft-knowledge`、`craft-memory`、`craft-experience` 以及它们进入 Context 的边界；不把 Runtime、Capability 市场或企业身份平台假定为已经完成。

结论不是再增加一批“记忆类型”，而是把三个容易混淆的问题拆开：

```text
谁拥有、谁可读       → Custody / visibility
这条内容适用于哪里   → Applicability scope
何时形成、何时失效   → Lifecycle / retention
```

`个人 → 项目 → 团队 → 组织` 不是一条可以直接继承的 Scope 树。个人偏好可属于某个人、在一个项目里被使用，却绝不能因为项目成员多就变成团队规则；项目文件中的编码规范可能可被团队读取，但其有效性来自来源和项目权限，而不是“被记住很多次”。

理想模型应是：

```text
Host Session / Run State              （当前工作，不是长期记忆）
          ↓ 受限、短期、可恢复
Working Notes                         （任务/会话便签，TTL、可压缩）
          ↓ 明确 capture / evidence
Knowledge | Memory | Experience       （三条不同的长期生命周期）
          ↓ Context Resolver（按任务与决策点做最小投影）
Host Context
```

其中，Knowledge、Memory、Experience 都能成为 Context 成员；区别不在于“谁可以被注入”，而在于写入依据、更新方式、默认可见性和进入 Context 的资格不同。

## 一手资料的共同启发

### Context / session 不是长期记忆

OpenAI Agents SDK 将 `Session` 定义为特定会话的消息历史；Sandbox Memory 则明确与 Session 分离，把过往 run 的经验蒸馏成工作区文件。前者可恢复对话，后者是 retained data，必须按工作区同等执行敏感性和保留治理。[OpenAI Sessions](https://openai.github.io/openai-agents-python/ref/memory/session/) · [OpenAI Sandbox Agent Memory](https://openai.github.io/openai-agents-js/guides/sandbox-agents/memory/)

Anthropic 同样把 Context 视为有限的注意力预算，建议最小高信号集合、渐进披露与即时检索；长任务应使用压缩与结构化笔记，而不是把完整历史、工具输出和所有“记忆”预先塞入模型。[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

因此，Craft 应保持“Context 是投影、State 是事实源”的定义。Session History、Run State、Checkpoint 与 Working Notes 不能被包装成同一种 Long-term Memory。

### Scope 同时是组织、检索和访问控制问题

Amazon Bedrock AgentCore 将短期 event 按 `actorId + sessionId` 隔离；长期记录通过 namespace 模板分组，并允许把 tenant、team、environment 作为自定义变量。它还将 namespace 作为 IAM 读取限制的上下文键。这说明 scope 既要参与检索，也必须有独立的访问控制含义。[Memory terminology](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-terminology.html) · [Memory organization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-organization.html) · [Namespace organization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/specify-long-term-memory-organization.html)

Letta 的 Core Memory Block 可持久化、可更新，并能显式 attach 给多个 agent；它的 API 将“块本身”“创建者/最后更新者”和“attach/detach”都作为对象属性，而不是通过文本相似度推断共享关系。[Letta Blocks API](https://docs.letta.com/api/typescript/resources/agents/subresources/blocks)

这两套一手实现共同支持一项工程结论：**scope label 不能替代 principal、membership、read/write policy 与审计。**

### “经验”必须与原始 episode 和可执行程序分层

AgentCore 的 episodic strategy 不是保存所有 event：它将有意义的 interaction 形成 episode，再从多个 episode 形成 reflection；同时警告 reflection 跨 actor 时有隐私含义。其默认 namespace 也区分 strategy、actor 与 session。[Episodic memory strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/episodic-memory-strategy.html)

OpenAI Sandbox Memory 的读取采用 progressive disclosure：先注入小摘要，再检索索引，最后按需打开对应 run summary；并支持“只读不生成”或“只生成、不受既有 memory 影响”的运行模式。[OpenAI Sandbox Agent Memory](https://openai.github.io/openai-agents-js/guides/sandbox-agents/memory/)

可借鉴的不是把所有 episode 自动转成 Skill，而是分开：原始观察、跨样本模式、经验证的可执行投影。执行时只需要最后一层的短小、版本固定投影。

## 建议的唯一分层模型

### 0. State：当前事实，不归三个认知组件

| 层 | 负责什么 | 留存 | 可进入 Context | 不能当成 |
| --- | --- | --- | --- | --- |
| Session history | 本次 Host 对话与消息连续性 | Host/session 生命周期 | 由 Host 自己管理 | 长期事实库 |
| Run / task state | Goal、Target、Plan、Step、Checkpoint、lease、验收状态 | 到任务关闭及审计期 | 以状态摘要在必要时出现 | 用户偏好、知识 |
| Working Notes | 未完成假设、待办、文件定位、下一步 | task/session TTL，可压缩 | 当前任务或恢复时 | 可跨项目的长期记忆 |

这里的关键界线：Working Notes 服务“把这件事做完”；Memory 服务“以后遇到相关任务应记得什么”。二者的写入频率、压缩策略、失效和读取权限完全不同。

### 1. Knowledge：可复核的外部/共享主张

Knowledge 回答“**什么可以作为带来源的、可检查主张**”。它可以是 README 中的构建要求、团队批准的术语定义或受版控文档中的接口约束；它不是某人一次随口的偏好，也不是一次执行的未经验证总结。

推荐的 Knowledge record 至少有：

```text
claim + source revision + exact evidence fragment + authority/trust
+ applicability scope + audience/read policy + observed/effective/expiry
+ review status + contradiction/supersession lineage
```

生命周期应保持：

```text
Source revision → fragment/evidence → claim candidate
→ structural review → semantic review → reviewed
→ stale / revalidation_required / revoked
```

`reviewed` 的含义只能是“在声明的来源 revision 与 scope 内可作为受限 Context”，不是“当前生产事实永远为真”。Source drift 必须使引用它的 Claim 失效或重验；与权限、外部写入、Capability activation、路由有关的 Claim 即使语义支持也仍需独立 Eval。

### 2. Memory：有归属与时间语义的连续性信息

Memory 回答“**对这个 actor / task / project，什么过去信息仍值得当前任务考虑**”。它可保存偏好、经确认的用户事实、对一次任务的 episode、或个人层的做法提示。它不是权威知识库，也不因被频繁检索就成为团队规范。

建议将现有 `working` 兼容记录最终收敛成三种真实语义：

| Memory 类 | 典型例子 | 默认 scope / TTL | 冲突策略 |
| --- | --- | --- | --- |
| episodic | “在项目 X 的上次发布中，测试 Y 因环境 Z 失败” | project/task，有限 TTL | 并存并按时间、状态、证据选择 |
| preference | “此用户回复先给结论”“该用户目前戒糖” | person/user，直到撤销或复核 | 同 topic 新事实走 conflict → supersede / abstain |
| procedural-memory | “该用户在本机处理日志时偏好先运行固定检查” | person/project，有限或明确复核 | 不能自动升级为团队 Procedure |

长期 Memory 的最小写入链：

```text
explicit consent or trusted event → candidate → scope/classification gate
→ evidence / conflict check → active memory
→ supersede / revoke / expire / archive
```

“喜欢咖啡”与“戒糖”可同时存在，因为 topic 不同；同一 `preference:diet:sugar` 的相反事实必须产生冲突候选，选择当前版本或可解释弃权。压缩只能形成派生摘要，不能覆盖原事件、Evidence 或撤销链。

### 3. Experience：被结果证明或反驳的做法

Experience 回答“**在什么可比较场景下，哪种做法提高或损害了真实结果**”。它的原始输入是 Trace、Receipt、State Snapshot、Acceptance、Outcome；不是聊天总结。

```text
Observation → Scenario Signature → Pattern → Procedure Candidate
→ Shadow → Held-out → Signoff → Canary → Routeable Procedure / Rollback
```

三层分别回答：

| Experience 层 | 可见性 | 作用 |
| --- | --- | --- |
| Observation / raw evidence | 维护、诊断、评测 | 保存“发生了什么”及终态指针 |
| Pattern | 维护、评测 | 保存触发条件、反例、失败机理、受影响 Case |
| Procedure | Decision Context Gate | 保存短小的触发条件、前置条件、允许 effect、验收器和失败处置 |

Procedure 有三种格式：线性 Workflow、Graph、Prompt Procedure。它们是同一 `Procedure` 资产的不同表示，而不是第二套 Memory；Workflow/Graph 以结构化 JSON 为权威，Prompt Procedure 以 Markdown 为权威。等到它通过 routeable gate 后，才可作为 Capability 的受控、版本化投影被激活。**Experience 仍可以参与 Context，但只有 routeable Procedure，而不是 raw trace 或 Pattern。**

这解决 `procedural memory` 与 Experience 的重叠：前者是 actor/project 相关、可撤销的“个人或局部提示”；后者是跨独立 Outcome 后才有资格成为受评测 Procedure 的“操作知识”。命名上建议把前者逐步更名为 `practice` 或 `local procedure hint`，避免和 `Procedure` 混称。

## Scope 不应是一维枚举

Craft 当前的 `task → project → user → explicit-global` Context stack、Git remote 优先的 canonical project identity、path/legacy alias、TTL、Evidence 和 receipt 都是正确基础。尤其 Git identity 解决了同一项目在不同机器目录不同的问题；缺少 scope 时 `skipped` 而非扫描全库也是正确的默认。

但它目前仍主要把 scope 当作一组 `kind/id` 检索标签。对“个人 / 项目 / 团队 / 组织”真正需要的模型应至少有四条正交轴：

| 轴 | 问题 | 推荐字段/规则 | 当前缺口 |
| --- | --- | --- | --- |
| custody | 记录归谁、在哪个 tenant | `tenant_id`、`owner_principal_id`、device/export provenance | 组件读写没有统一 principal/tenant 绑定 |
| audience | 谁能读/写/转发 | `private`、`session_shared`、`project_shared`、`team_published`、`org_published` + ACL/policy ref | team/org 不是三组件的可执行 scope；不能只靠 `global` |
| applicability | 哪个任务可用 | `task / project / user / explicit_global` stack + stable canonical IDs | 已有较强基础，需继续写明遮蔽与合并规则 |
| retention | 何时复核/失效/删除 | `observed_at`、`effective_from`、`valid_until`、review cadence、tombstone | Memory 已有大部分；Knowledge/Experience 需统一 retention contract |

由此得到四条硬规则：

1. 项目是**适用范围**，不是天然共享范围；项目文件可被团队成员读，必须来自项目 membership/Host principal，而非因为 scope 为 `project`。
2. 个人偏好默认 `private`。把多人共同偏好提炼成团队做法时，应去标识化、生成新对象、保留源链，不能复制原偏好正文。
3. team/org 内容只能来自显式成员与权限 Adapter；没有可靠 principal、membership、tenant 的本地单机模式，不能宣称已经提供团队级记忆。
4. `global` 必须是显式 audience 的发布对象，而不是 project 搜不到时的回退库。

用户提供的材料中“先由消息场景决定默认归属、再决定类型、第三方识别与升格证据”的思路值得作为产品策略候选；但其具体阈值、DeerFlow 的实现叙述尚未在本轮以一手资料逐项核验，不能直接写成 Craft 已证明的行业事实。

## 当前 Craft 0.12.36：已具备与尚缺能力

### 已具备且应保留

- Knowledge 的 Source、revision、Evidence、Claim、reviewed/stale/revoked 与只让 reviewed Claim 进入 Context 的边界。
- Memory 的 source/version、scope、sensitivity、Evidence、TTL、`observed_at`/`effective_from`、topic、supersede/revoke 历史；冲突不覆盖、缺 scope 不全局回退。
- Experience 的 Observation → Pattern → Candidate → gate → routeable Procedure 分层，以及 JSON Workflow/Graph 与 Markdown 审阅视图的双表示。
- Context Receipt、成员选择、预算、scope alias、决策点 Context Gate 与 keyword-first/vector 需评测才启用的机制。
- 受管 Markdown + SQLite 索引 + Bundle 冲突不覆盖的本地数据主权路线。

### P0：需要先收口的架构缺口

1. **从 `scope kind/id` 升级为 Scope Policy。** 新对象应持有 `owner_principal_ref`、`audience_policy_ref`、`tenant_ref`（单机可为空/`local`）与 `applicability_scope`。Resolver 在匹配 topic 前先作 read authorization，再作 scope precedence；Receipt 记录授权依据的 digest。当前 `team`、`organization`、成员变更、转发/导出权与撤销传播均不能由三组件可靠表达。
2. **把 Working Notes 从长期 Ledger 语义中真正拆出。** 当前 `working_note:true` 是兼容桥，仍复用 `memory_ledger`；应在 WorkControl/Session State 建立独立、TTL 驱动的 Note store，并让其仅由关联 Run/Session 读取。完成后再迁移兼容读，不要硬删旧记录。
3. **统一“procedure”名词。** `Memory.procedural`、Experience Procedure、Capability Workflow/Skill 容易让 Host 把局部提示当发布资产。保留兼容字段，但在数据模型和 MCP 中将 Memory 那一类称为 `practice` / `local_hint`，将通过 gate 的可执行资产固定称为 `Procedure`。
4. **团队/组织前先做 principal Adapter，而不是先加 scope 枚举。** 本地 Codex/Claude 没有可验证人类身份时，只应支持 `local user`、canonical project 和显式 bundle import；团队/组织写入与读取必须在身份、成员关系、ACL、审计与撤销 Adapter 存在后启用。
5. **明确跨机器 merge 的信任边界。** canonical project identity 已解决路径差异；但同一用户跨设备、同一团队多设备仍需要稳定 principal/device identity、bundle signer/receiver policy、tombstone 的授权人和撤销传播。仅以 `add/duplicate/conflict` 不覆盖是必要但不充分。

### P1：改善有效性而非堆叠存储类型

1. **知识保鲜与来源级评测。** 对 Source revision 做增量 fragment reuse、stale propagation、review cadence 与“被引用的 stale Claim”告警；知识 claim extraction 不能长期只是原 fragment 复制。
2. **决策点召回评测。** 对每条 Memory/Procedure 记录“是否在造成差异的 Tool/参数决策之前被选择”，而不只统计 search hit 或被注入次数。
3. **同 topic 的时间/矛盾模型。** 保持 `supersede/revoke/abstain`，补全 explicit historical query、可信来源优先、事实/偏好/纠正不同的默认生命周期；不以使用频率单独提高真值。
4. **Experience 的负例资产。** 将失败三件套（触发条件、独立 verifier、回归 Case）与 Procedure candidate 绑定。学习是否成立，应首先看已知失败复发率和保留集回归，而不是 Procedure 数量。
5. **Context 预算按成员和风险分配。** Knowledge、Memory、Procedure 不应互相抢同一不透明预算；Receipt 需解释每个成员的额度、遮蔽与遗漏。可学习排序，但需保留 deterministic baseline。

### P2：只在真实数据证明需要后再做

- 向量、实体或图检索：先在冻结集证明比 keyword baseline 的召回净收益、零跨 scope 泄漏、成本/延迟可接受；不要把“有 Embedding Adapter”写成“语义检索已生效”。
- Team/org sync、云对象存储或自动共享：先有 identity/ACL/tenant 与撤销案例，再做 Transport Adapter。
- 自动深度维护：Light 可自动做 TTL、去重、敏感检查、引用健康；Review/Deep 只能在模型/预算/空闲条件满足时提出 candidate，不应把“梦境整理”变成无界事实改写。
- Graph Procedure：只有分支、并行汇合、审批、恢复/补偿的真实 Observation 才用 Graph；稳定顺序任务仍应是 Workflow。

## 评测：每层怎样证明“有帮助”

单元测试只证明字段和边界；三组件要单独证明它们帮助 Codex/Claude 在正确时机做出更好决定。

| 层 | 机制/隔离回归 | 真实 Host 对照指标 | 关键反例 |
| --- | --- | --- | --- |
| Knowledge | source drift、fragment entailment、Evidence coverage、权限/跨 scope 读取、stale/revoke | 事实正确率、正确拒答率、来源新鲜度、决策前 Evidence coverage | 过期 README、矛盾来源、无证据 Candidate |
| Memory | consent、TTL、topic conflict、supersede/revoke、历史查询、private leak | 当前偏好命中率、冲突误注入率、决策点命中率、token/时延 | 新旧偏好、两个项目同名实体、普通聊天不应被记住 |
| Experience | Observation 终态、signature 隔离、失败三件套、gate/rollback、Graph 选择 | 已知失败复发率、终态达成率、首次成功率、无效重试率、保留集回归 | 单次偶然成功、失败 Candidate、无新 Evidence 的重复提案 |
| Context（横切） | budget、receipt、scope precedence、实际 retrieval mode | 注入 precision、遗漏率、泄漏率、决策时机、成本 | 把 pattern/候选注入执行、vector unavailable 却标称已用 |

推荐固定 `Case × Host × Model × Context Profile × N Trial`，baseline/candidate 各至少 3–5 次，固定项目快照、scope、模型、预算、验收器与 Case 版本。未校准的 LLM Judge 只能诊断；Knowledge/Memory/Experience 的 routeable 资格仍取决于真实终态、泄漏与回归。

## 最小实施顺序

1. 先写 ADR 固定四轴 Scope 模型与术语：`State`、`Working Notes`、`Knowledge`、`Memory`、`Experience`、`Procedure`；停止把 team/org 当简单 `scope_kind`。
2. 在 WorkControl 中落独立 Working Note store，并保持旧 `working` ledger 的只读兼容。
3. 为三组件引入同一 `ScopePolicy`/principal seam；本地模式只实现 local/project/user，team/org 明确 `unavailable`，而不是假共享。
4. 固定三组含负例的 deterministic case，再跑 Codex/Claude 配对 Trial，先验证 Knowledge/Memory/Procedure 是否真的在决策点降低复发率。
5. 只有身份/ACL、跨机器 signer/merge 和真实 case 证明后，再开放团队/组织 audience、自动 promotion 或向量/图检索。

## 不应做

- 不把完整聊天、工具输出或 Session history 自动混入长期 Memory；
- 不把个人偏好、项目局部经验自动上升为团队/组织规则；
- 不把 `global` 当作缺 scope 时的检索回退；
- 不以模型自评、记忆条数、引用次数或单次成功证明“学习有效”；
- 不让 Pattern、Candidate 或 raw Trace 直接修改默认 Skill、Workflow、Graph 或权限；
- 不在没有 principal/membership/ACL 的单机插件中声称已经支持真实团队记忆。

## 参考资料

- [OpenAI Agents SDK：Session](https://openai.github.io/openai-agents-python/ref/memory/session/)
- [OpenAI Agents SDK：Sandbox Agent Memory](https://openai.github.io/openai-agents-js/guides/sandbox-agents/memory/)
- [Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [AWS AgentCore：Memory terminology](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-terminology.html)
- [AWS AgentCore：Memory organization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-organization.html)
- [AWS AgentCore：Long-term memory namespaces](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/specify-long-term-memory-organization.html)
- [AWS AgentCore：Episodic memory strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/episodic-memory-strategy.html)
- [Letta：Memory Blocks API](https://docs.letta.com/api/typescript/resources/agents/subresources/blocks)
