# 上下文的五个成员，以及每个成员由谁持有

> 状态：架构结论 + 当前实测状态。基线 v0.12.33（工作版本号未升）。本文记录**决定**与**实测**，两者分开标注；未决问题集中在最后一节，不散落在正文里。

本文回答一个反复被问到的问题：`context` 到底由什么组成、每一项存在哪里、谁负责管理它。`src/capability-protocol.ts` 是这套结论的代码形式，本文是它的散文形式；两者不一致时以代码为准，并把文档修好。

## 整体框架

```text
agent   = model + harness
harness = permission + context + tool + environment   (+ hook，正交轴)
context = history + knowledge + memory + experience + state
```

`hook` 不在 `harness` 的那一行里，因为它不回答"有什么"，而回答"在流程的哪一刻"。这是它被单列的原因，不是排版。

## 五个成员

| 成员 | 由谁持有 | 生命周期 | 门槛 | 可插拔 |
| --- | --- | --- | --- | --- |
| `history` | 宿主 | 这一次对话 | Craft 只存 digest | 否 |
| `knowledge` | Craft | 跨任务 | Evidence | 是 |
| `memory` | Craft | 跨任务 | 显式批准 | 是 |
| `experience` | Craft | 跨任务 | 评测 + Signoff 后才成为 Workflow | 是 |
| `state` | Craft | 当前任务 | 无，随任务过期 | 否 |

三个"可插拔"的判据是**同一件事**：它们由 Craft 跨任务累积、按 scope 检索、并且各有一道门槛。`history` 与 `state` 不满足，因此不成为 capability。`pluggableMembers()` 直接由 `CONTEXT_MEMBER_SOURCES` 推导，不是另一张手写清单。

### `history` 为什么只存 digest

Craft 按设计**不持有对话正文**。宿主给查询，Craft 给出有界、可复现的 Context Resolution Receipt；receipt 里只有 `query_digest`（见 `src/context-resolution.ts` 的 `resolve`）。这不是省事，而是让"内容不在 Craft 数据库里"成为可检查的事实而不是承诺。

### 自托管时谁是宿主——一个看起来像反例、其实不是的情形

Craft 自己跑循环时（`internal-host-driver.ts`，与 `codex-cli`、`claude-code` 并列的第三个 Host Driver），**Craft 就是宿主**：它在 `internal_session` 里持有 transcript，并在构造模型请求之前直接压缩它。它不会向自己要一个 `ContextContribution`，因为"贡献"是**自己持有 prompt 的宿主**向 Craft 要材料的方式；宿主就是 Craft 时这个往返没有意义。

所以 `history` 在两种模式下都是 `host_provided`。**变的不是哪个成员可插拔，而是宿主是谁。** 如果将来要让**外部**宿主也把历史托管给 Craft，那是一次对 `CONTEXT_MEMBER_SOURCES.history` 的**故意放宽**，理由必须写在那张表旁边——不是顺手改。

## `state` 到底存什么（这一段是此前最模糊的地方）

`state` 不是文本，也不是业务内容。它是三样东西的组合：

| 记录 | 内容 |
| --- | --- |
| `state_snapshot` | 某个 Workspace 的**无内容**文件树 / 产物 digest：路径、摘要、artifact 引用 |
| `task_run_state` | `{status, action, actor}`——`status` ∈ cancelled / paused / needs_replan / awaiting_approval / running / ready_for_delivery / awaiting_acceptance / recovery / blocked；`actor` ∈ none / human / host |
| `context_manifest` | 把 knowledge、capability、Workflow、model、Host、acceptance 的引用摘要钉在一起 |

外加 `stability_digest`：契约版本、activation profile、budget account、task_id、workspace、prompt_digest、environment_digest、budget_digest 的摘要。**任一项漂移就进 `needs_replan`**（`task-run.ts` 的 `refresh`）。

一句话概括 `state` 的用途：**现在进行到哪、谁该动、下一步唯一安全的动作是什么。**

它的判别特征是**读取方式**，不是内容：`state` 靠**按 id 查询**（`task_run_get`、`state_workspace_compare`）拿到，从不按相关度检索；任务结束即过期。而 knowledge / memory / experience 是"按 scope 检索出来的累积物"。这正是 `CONTEXT_MEMBER_SOURCES.state === "current"` 的含义，也是它不该被当成第四个可插拔成员的判据。

## 历史与压缩：结论，以及三套互不认识的机制

"`history` 既要有整份、也要有压缩后的一块"——这个判断是对的。实测下来，能力**已经存在**，但分散在三处，彼此不知道对方，而且 `history` 这个成员一个都没引用：

| 机制 | 位置 | 策略 | 持久化 |
| --- | --- | --- | --- |
| `compactConversation` | `runtime-truth.ts` | 保留 system + 从最近往前填到预算 65% 的 tail，**丢弃 middle**；两段式：先规则省略，再可选模型摘要，无模型时回退为确定性、无内容、带摘要的 note | 是（`internal_session`、`context_compaction`） |
| `ReversibleContext` | `context-retrieval-capture.ts` | 按 **weight 再 recency 整段丢弃**，omitted 段报出 id | **否** |
| governance pin | `governance-pinning.ts` | 约束**不参加淘汰竞争** | 是 |

三者的差别是真实的，不只是实现细节：

- **丢弃 ≠ 压缩。** 淘汰整段是确定性的、可逆的、不需要模型调用；摘要会**替换**原文，不可逆，需要模型，并且产生一个**派生**事实——必须带来源，否则分不清一条原始回合和一条对它的总结。Craft 的整体设计是"无内容 + digest 钉住"，所以摘要必须是带 scope、带归属的内容，且**不能静默替代原文**。
- **可逆性目前跨不了调用。** `craft_context_project` 的说明写着"omitted segments are named and can be restored"，但 `craft_context_restore` 要求调用方**把原始 segments 数组再传一遍**——而被省略的东西按定义就是调用方手上不再完整持有的。实测：只传 `segment_id` 会抛 `Context segment s2 does not exist`，且 `context_segment` 集合为空（没有任何持久化）。所以"可逆"只在调用方那份数组的生命周期内成立。
- **压缩结果曾经只能写不能读。** `context_compaction` 与 `work_note` 此前没有读回动词，恢复中的会话只能知道"曾经压缩过一次"，无法知道压缩后是什么。已在 v0.12.43 补上 `craft_runtime_truth_compaction_get` / `_list` / `craft_runtime_truth_work_note_get`（记录 id 就是 session id，所以恢复只知道自己名字即可）。

## 目标、计划与验收：为什么它们是内置的

"发起一个任务说了一堆话，最终必须有目标和验收，否则不知道干完没有"——这个判断成立，而且代码里已经**强制**：

| 环节 | 工具 | 关键语义 |
| --- | --- | --- |
| 目标 | `craft_intent_compile` | 自然语言 goal → durable、host-neutral 的 Task Contract；`route = simple \| governed \| clarification`；**歧义直接返回澄清问题** |
| 澄清 | `craft_guided_work_create` / `_decide` / `_launch_prepare` | **所有必需决策答完**才允许准备 launch |
| 验收 | `craft_acceptance_compile` | 若 `route === "clarification"`，**直接抛错**：`Task intent requires clarification before acceptance compilation` |
| 计划 | `craft_task_graph_create`、`durable_action_loop` | 依赖图；action loop 的每个 work item **自带 `acceptance_digest`** |
| 闸门 | `craft_acceptance_gate_outcome` | **只有 passed gate 才能产生 verified Outcome**；工具说明原文："Host completion is not a passing verdict" |

**为什么"要求"必须内置而"评测方式"可以插拔**：如果验收可以被配置成"没有"，系统就退化成"宿主说完成就算完成"，而 `acceptance_gate_outcome` 的全部意义就是防这个——一个能被配置掉的闸门不是闸门。反过来，**怎么评**已经可插拔：`craft_acceptance_evaluator_save` 注册 program / model / business-signal 评测器，走 domain adapter，内置的有 file artifact、覆盖率、ffprobe。

所以正确的缝是：**要求内置，评测方法可插拔。** 目标/契约/验收门是内置的；评测器是 capability/adapter。

## 三个累积成员各自的读侧，以及为什么 experience 的读侧只给指针

三个成员都能写，读侧是一个共享出口加一个例外：

| 成员 | 读侧 | 出口 |
| --- | --- | --- |
| `knowledge` | 按 scope 与查询检索内容 | `src/context-resolution.ts` 的 `resolve`（核心） |
| `memory` | 同上，检索 ledger 条目 | 同上 |
| `experience` | **只给出"哪些编译过的经验适用于这个场景"** | `capability/craft-experience/contribution.ts` |

experience 的例外不是策略选择，而是数据模型决定的：`compile` 只存 `hypothesis_digest` / `applicability_digest` / `counterexample_digest`，记录带 `content_free: true` 与 `execution_visible: false`，而工具说明写着 "execution Hosts never receive it directly"。**Craft 里根本没有那段散文可以泄露。** 所以它的贡献只能是指针加出处：哪个 pattern、哪个版本、什么类型、由多少独立观测支撑、以及是否已有干预通过 Signoff（`requires_governed_route: true`）——这正是路由策略决定"要不要走受治理路径去查账本"所需要的。测试断言条目的字段里**不能出现** `hypothesis` / `applicability` / `counterexample`，因为这条读侧唯一可能的坏法就是长出一个字段。

`resolve` 因此变成 async：贡献者的 `contribute` 是异步的。结果是**校验错误从同步抛错变成 rejection**——对 MCP 路径无差别（handler 两者都接），对直接调用者是一个真实的行为变化，测试里所有 `assert.throws` 相应改成 `assert.rejects`。

## 四个问题的处理结果

此前列在这里的四个未决问题都已决定并落地：

| 问题 | 决定 | 落地 |
| --- | --- | --- |
| 三套压缩机制合并？ | **合并为一套** | `src/compaction.ts` 的 `compact()`；三处入口成为它的适配器。见 [ADR 0020](../../adr/0020-one-compaction-policy.md) 与下面「压缩」一节 |
| transcript 对外成为能力？ | **不对外** | `CONTEXT_MEMBER_SOURCES.history` 保持 `host_provided`，未改一行。见 [ADR 0019](../../adr/0019-transcript-is-not-an-external-capability.md) |
| `ReversibleContext.restore` 持久化？ | **持久化** | `src/context-projection.ts` 的 `ContextProjectionKernel`：`context_session` 存段落、`context_projection` 存无内容的投影，`restore` 只需要 `session_id` + `segment_id` |
| `state` 统一只读视图？ | **给一个** | `src/state-view.ts` 的 `StateViewKernel`，工具 `craft_state_view_get`；它只有读方法，`status` 是派生的，因此不会成为第二个事实来源 |

### 压缩：一套策略，两个阶段

`compact()` 是唯一的实现。两个阶段的填充规则**故意**不同：

1. **保留阶段**（`tail_share`）：取一段**连续**的近期后缀，遇到装不下的就停。连续性正是"被省略的跨度可以被打包成一段来描述"的前提，这是 transcript 需要的规则。
2. **竞争阶段**：剩下的按权重打包，装不下就跳过并试下一个——这才是把预算用满。

决胜项只有一个：**权重降序、再新者优先**。此前两套机制按权重排序却把并列项朝相反方向决胜，于是调用者拿到什么取决于它碰巧调了哪个函数。合并改变了 `compactionPlan` 在权重并列时的输出，这是自觉的后果并有测试记录。

保护是**减法**：`protect` 把段落同时移出预算与 omitted 集合，成本单独报告（`protected_tokens`、`total_tokens`），没有匹配到的保护 id 报为 `unbound`。给约束一个大权重仍会输给更紧的预算，而那正是治理研究测到的失效模式。

### `state`：一个视图，一条优先级

`StateViewKernel` 读五个记录（契约、run、run state、launch、delivery loop，以及可选的 manifest 与 workspace 快照）并报出**一个** `status` 与**一个**安全动作。优先级是它的全部内容：

1. 已取消/已暂停的 run 说了算——一个停下来的 run 不会因为投递循环里还有动作而"在跑"。
2. `needs_replan` 说了算——钉住的输入变了，下游每一项读数都属于一个不再适用的计划。
3. 待批的 approval 说了算——那是人的决定，报循环的动作等于邀请调用者跳过它。
4. 否则由投递循环的动作决定。

它**只读**：没有写方法，`status` 派生不存储，所以不可能成为第二个事实来源。`sources` 列出实际读了哪些记录，让读的人看到依据而不是只看到结论。

## 关联

- [Capability 扩展协议](capability-protocol.md)：本文的五个成员如何由 capability 装配与贡献。
- [Internal Host](internal-host.md)：自托管循环，以及它为什么自己持有 transcript。
- [Runtime Truth](runtime-truth.zh-CN.md)：压缩笔记与 trace envelope。
- [上下文、记忆与后台整理](context-memory.md)：范围化记忆与后台整理的既有设计。
- [Knowledge Source / Memory Ledger / Context Resolution](knowledge-memory-context.md)：实现这三件事的三个模块，以及为什么读取侧留在核心。
- ADR：[上下文成员的性质是固定的](../../adr/0014-context-members-have-fixed-natures.md)、[目标与验收内置、评测可插拔](../../adr/0015-goal-and-acceptance-are-built-in.md)
