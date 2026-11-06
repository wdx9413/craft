# 上下文成本、记忆生命周期与长任务控制面：一手资料核验

调研日期：2026-09-21  
范围：LoopX 作者仓库、Fortunate Recall 预印本与代码归档、OpenAI/Anthropic 官方工程资料。本文不把二手文章、宣传星数或未复现实验当作产品事实。

## 结论

Craft 的方向正确：**模型负责判断，Craft 保存外部状态、限定动作、验收真实终态，并把经验变成受控 Procedure 候选。**

本轮最值得吸收的不是再加一个记忆库或新框架，而是三个小而硬的闭环：

1. **Context Compiler**：以稳定前缀、最小动态投影、按需读取和结构化状态替代重复传入聊天/工具全文；
2. **Memory Lifecycle Router**：在语义检索前按事实槽位、状态、生效/事件时间和查询意图排除过期、已撤销或被取代的内容；
3. **Run Eligibility Gate**：在唤醒模型前判定“现在是否有值得执行的工作”，只有独立验收确认有效进展后才消耗自动化配额。

三者都应复用 Craft 的 Scope、State、Trace、Receipt、Acceptance 和 Evaluation 账本，不能演化出第二个控制面。

## 一、如何降低输入而不牺牲能力

### 已核验事实

- Anthropic 将 Context 视为有限且会产生边际递减的注意力预算；其建议不是把所有历史/RAG 一次性塞入，而是以轻量标识符配合工具进行 just-in-time、渐进式读取，并在长任务中使用 compaction、结构化笔记或隔离子任务。[Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- OpenAI 的原生 compaction 会保留高价值状态并压缩较早上下文；其官方工程资料也建议将确定性筛选、聚合和工具结果处理移到代码侧，只把相关结果回送模型。[Responses API computer environment](https://openai.com/index/equip-responses-api-computer-environment/)、[GPT-5.6 builder’s guide](https://openai.com/index/builders-guide-to-gpt-5-6/)
- OpenAI 的提示缓存复用稳定的**精确前缀**。静态指令、工具定义和范例应保持在前，变化的用户/任务内容放在后；可通过 `cached_tokens` 或缓存诊断观察效果。[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- 这并不意味着“输入越短越好”：官方共同强调的是最小而高信号的 Context；错误压缩或漏掉约束会使长任务更容易偏航。

### 对 Craft 的建议

将现有 Context Resolution 收敛为一个可评测的 `Context Compiler`，每次只输出以下预算化投影：

```text
稳定前缀：Policy、固定工具定义、项目不变量、版本/digest
当前状态：Goal/Target、当前 Step、验收、checkpoint、未解决阻塞
决策材料：本次行动相关的 Knowledge/Memory/routeable Procedure
按需引用：文件路径、Artifact digest、Source fragment、可再次调用的检索工具
```

具体优先级：

- **先减少重复，而非先摘要。** Host 支持缓存时，让静态层按 canonical project 和 Release/Capability digest 固定；将每轮动态 Context 作为尾部 delta。Craft 只能记录布局/Cache Receipt，不能声称 Codex/Claude 内部一定命中缓存。
- **原文外置、状态结构化。** 大型工具输出与历史 transcript 保留为受控 Artifact/文件引用；模型只接收可验证摘要、位置和按需读取入口。`State` 与 `Checkpoint` 是事实源，摘要不得取代它们。
- **在决策点检索。** Tool 选择、参数决定、外部写入、连续失败、恢复前重新解析最小 scoped Context；不能等到第 40 轮才召回本应在第 3 轮使用的规则。
- **将确定性工作下沉。** 搜索过滤、文件统计、差异摘要、结果聚合放入工具/代码，回送结构化小结果，而不是原始输出。

应新增的评测不是单纯 token 数，而是：`constraint_recall_at_decision`、Context 选择漏召回率、错误注入率、终态达成率、输入/缓存命中、时延和成本。只有能力不退化时，缩短 Context 才算成功。

## 二、Fortunate Recall：可借鉴的生命周期层，不是已验证的通用记忆产品

### 一手资料核验

Fortunate Recall（FR）是 2026-09-09 的 [arXiv 预印本](https://arxiv.org/abs/2609.10413)，页面明确标为 *under review*。论文描述的机制是：LLM 在摄入时抽取 10+1 行为类别、槽位和时间元数据；之后用确定性规则执行按类衰减、slot-key supersession、事件时间有效期及按类检索路由。作者自建 LifecycleBench（516 题），报告 FR-Bank 76.9%、其他基线 61%–70.5%、LongMemEval-S 75.2%。

代码/日志存放于 [Zenodo 归档](https://zenodo.org/records/20067778)，但为匿名作者的 2.8GB ZIP，无法像公开源代码仓库一样在线逐文件核验。因此：**机制可作为设计参考，分数只能视为作者报告，不能当作独立复现或 Craft 的生产收益。**

论文自身的消融也值得保留：只保留通用生命周期元数据、去掉 typed layer 时，作者报告正确率差异不显著；其类型本体的主要贡献更接近校准/降低虚构，而非已证明对所有领域提升正确率。

### 对 Craft 的具体补充

Craft 已经采用 `observed_at`、`effective_from`、`expiry`、topic、supersede/revoke 等方向；仍应补齐以下统一 Router，而不是继续堆检索器：

```text
FactSlot(subject, attribute, scope)
  + lifecycle state(active | superseded | expired | revoked | conflicting)
  + observed_at / effective_from / event_at / valid_until
  + provenance / evidence / review
  + policy class
```

1. **Slot 与状态优先。** “搬到伦敦”可以取代“住在伊斯坦布尔”；“考虑搬家”不能取代当前住址。旧项保留历史，不物理删除。
2. **按查询意图过滤。** `current` 默认排除 superseded/expired/revoked；`historical` 才返回时间线；未解决冲突返回可解释 abstention，不能随机注入其中一条。
3. **策略按领域配置，而非硬编码 10+1 类。** 个人偏好、项目依赖、截止日期、团队规则的变更速度不同；`PolicyClass` 应声明取代条件、有效期/到期激活、衰减和可见范围。第一版只做少量可审计 profile。
4. **压缩不覆盖事件。** Compaction 只能产生派生摘要，并保留指向事实、Evidence、supersede/revoke 事件的来源链；摘要不能成为唯一检索源。
5. **把陈旧注入纳入评测。** 除 recall@k 外，新增 stale/superseded injection rate、冲突 abstention correctness、历史问答正确率和决策点命中率。

这正是“我爱喝咖啡”与“我昨天开始戒糖”可以并存、而“我改用 npm”与“我用 pnpm”才进入同一槽位冲突的基础。

## 三、LoopX：可借鉴的长任务控制面，不应作为 Craft 的第二套运行时

### 已核验的 LoopX 事实

LoopX 官方 README 将自己定义为运行在 Codex、Claude Code、Cursor 等 Harness 之上的 provider-neutral、本地优先状态/控制面；它保存 goals、gates、todos、evidence、quota 和 handoffs，而 Harness 负责有界执行。[README](https://github.com/huangruiteng/loopx/blob/main/README.md)、[文档入口](https://github.com/huangruiteng/loopx/blob/main/docs/README.md)

其官方 release notes 进一步可核验：

- `v0.2.12` 记录每次 heartbeat 的 quota receipt，并明确调度仍归 Host Automation 所有，**LoopX 本身不创建后台 scheduler、也不授予外部写权限**。[v0.2.12](https://github.com/huangruiteng/loopx/releases/tag/v0.2.12)
- `v0.4.0` 强化可机读 activation、repair evidence 与有界 quota packet，并明确 Planner 只读、Worker 受已声明文件与校验命令限制；不授予 merge、publish、credential 或生产权限。[v0.4.0](https://github.com/huangruiteng/loopx/releases/tag/v0.4.0)
- 同一 release 明确说明没有宣称 benchmark 或 long-horizon outcome uplift。因此二手文所称“200+ 小时稳定运行”“最优解”不能外推为通用可靠性证明；应只视为项目作者展示的轨迹，而非严格配对评测结论。

### Craft 已有与真正缺口

Craft 的 Goal/Target/Plan/Step/Accept、Policy、Trace/Receipt、Checkpoint/Handoff、Lease/Heartbeat、Decision Context Gate、预算与自动化 Job 已覆盖 LoopX 的多数概念。不要再引入并行的 Goal、Todo、Quota 或 Evidence 数据库。

真正值得从 LoopX 收口到 Craft `WorkControl` 的是一个前置判定：

```text
RunEligibility
  = active goal
  + runnable next step
  + valid lease
  + available budget
  + fresh context / no replan drift
  + no repeated no-progress signature
  → run | wait | request_input | handoff | skip
```

并配套：

- **ProgressDelta**：只将独立验收确认的状态/Artifact/Evidence 差异视作有效进展；模型回复或工具成功本身不算。
- **Quota Settlement**：dispatch 前保留预算，独立 `Outcome` 证明有效进展后才消费 slot；无任务、重复失败或无增量时 skip，不唤醒模型。
- **Review/Handoff Packet**：用结构化短包交接 `Goal + current Step + Evidence + blocker + next permitted action + stop condition`，而非重新灌入完整聊天记录。
- **Stop policy**：同类无进展签名达到阈值，或 effect 状态不明时，创建 checkpoint/handoff/reconcile，不能无限重试或自称成功。

这能解决“while true”只会重复执行、却不知道为什么继续/何时停止的问题，同时仍让 Craft 的 Policy 与 Acceptance 成为唯一可信边界。

## 四、建议的优先级与验收

| 优先级 | 改造 | 验收证据 |
|---|---|---|
| P0 | Context Compiler + 动态预算 Receipt | 固定 coding/file Case：约束决策点命中不降、终态不退化，输入 token/成本下降 |
| P0 | Memory Lifecycle Router + 陈旧注入回归集 | 新旧偏好、过期义务、撤销计划、历史查询、跨 scope 泄漏均可确定验收 |
| P0 | RunEligibility / ProgressDelta / Quota Settlement | 无任务不调用 Host；两次无进展后 handoff；验收成功才 spend；effect_unknown 必须 reconcile |
| P1 | 缓存布局/Host Receipt | 支持 Provider 时测 `cached_tokens`/cache diagnostics；不支持时只记录 unavailable |
| P1 | 真实配对 Trial | 固定 Case × Host × Model × Harness，baseline/candidate 各至少 3–5 次，比较成功、复发、成本、时延和恢复率 |
| P2 | 领域 PolicyClass 与可选向量重排 | 只有关键词基线、时间/泄漏/成本评测达标后启用；向量失败必须同请求回退 keyword |

## 不应做

- 不将历史聊天全文作为降低输入的素材或长期事实源。
- 不把 FR 的分类表和作者分数直接写成 Craft 的默认“真理”。
- 不用访问/召回次数自动提高事实可信度。
- 不将 LoopX 作为 Craft 的第二个状态内核，也不因“长任务”默认开启多 Agent 或后台自动执行。
- 不把模型自述、工具 exit code 或压缩摘要当作终态验收。

## 来源

- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [OpenAI: Equipping the Responses API with a computer environment](https://openai.com/index/equip-responses-api-computer-environment/)
- [OpenAI: Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Fortunate Recall, arXiv:2609.10413](https://arxiv.org/abs/2609.10413)
- [Fortunate Recall code/log archive](https://zenodo.org/records/20067778)
- [LoopX README](https://github.com/huangruiteng/loopx/blob/main/README.md)
- [LoopX v0.2.12](https://github.com/huangruiteng/loopx/releases/tag/v0.2.12)
- [LoopX v0.4.0](https://github.com/huangruiteng/loopx/releases/tag/v0.4.0)
