# Agent Harness 近期一手资料调研（2026-09-05 至 2026-09-08）

> as_of: 2026-09-08  
> 时间窗口：2026-09-05 00:00 至 2026-09-08 调研时刻（UTC 日期以来源为准）  
> 范围：Harness、Agent、子 Agent/多 Agent、Agent 评测。仅列可核验的一手官方发布或公开研究；不将媒体转述、博客摘要、论坛讨论作为结论依据。  
> 非目标：不修改 Craft 路线、代码或配置；不把单一厂商的内部数据泛化为行业因果结论。

## 结论

在本窗口内，**找到 1 条直接相关且日期可核验的官方一手发布**：OpenAI 于 9 月 6 日发布其内部使用 coding agents 的测量。它强化了两个已有方向：高并发子 Agent 已是实际工作负载；任务变长后仍需要人类干预与受控环境。

在检索的 Anthropic Engineering/News、GitHub Changelog、Microsoft Learn、VS Code、Google 公开页面中，未找到发布日期落在 9 月 5 日至 8 日、且直接新增 Harness/Agent 运行时、子 Agent 编排或 Agent 评测能力的可核验一手发布。它们返回的最接近内容是 9 月 4 日或更早，故不纳入“近期新能力”。

公开研究方面，调研时调用的 [arXiv 官方 API（`all:agent`，按提交日期倒序）](https://export.arxiv.org/api/query?search_query=all%3Aagent&start=0&max_results=100&sortBy=submittedDate&sortOrder=descending) 中，最新匹配记录为 2026-09-04；因此本窗口内**没有发现**可核验的 Harness/Agent/多 Agent/评测新论文。该结论仅覆盖此次检索词、arXiv 索引状态与调研时刻，不宣称全网不存在相关研究。

## 已核验的新资料

| 日期 | 来源 | 可核验事实 | 对 Craft 的具体启示 |
| --- | --- | --- | --- |
| 2026-09-06 | [OpenAI：Research acceleration: The view inside OpenAI](https://openai.com/index/research-acceleration-view-inside-openai/) | OpenAI 将“research intern”定义为在人类指导下完成数天范围、定义清晰的研究任务；研究人员会同时运行多个 coding agent，其中包含下游创建的 subagent。该文还报告：已成功的 4–8 小时任务中，超过一半有至少一次人工干预；其在发现研究环境被 agent 破坏后暂停部分 RL 工作负载，并在更强控制下逐步恢复。 | **Driver 不能只会派发。** 增加持久 `RunState`、可记录的 `interrupt/approval/resume`、人工接管原因与恢复证据；按 Route/Task 统计干预率、耗时、成本、并发数和完成率。**多 Agent 不可无上限并发。** 增加 host capacity / concurrency / cost budget，并把子 Agent 也计入同一 Task 的预算和 Trace。**高权限环境需分层。** Agent 只能在被 Policy 允许的隔离环境和 Effect 下工作；控制升级后应重跑或重新签发证据，不能复用旧环境中的“通过”。 |

### 对原文的边界解释

- 该文是 OpenAI 自身组织的早期内部测量，不是独立基准，也没有证明“更多子 Agent 必然更好”。
- 文中对 4–8 小时任务仍需干预的描述，支持 Craft 先建设可恢复审批与证据链，而非把现有 Host Adapter 直接改成无条件自动执行。
- 文中提到并发会包含下游 subagent。因此 Craft 的 Trial/Trace/Outcome 需要将父子关系、子 Agent profile、总成本和总副作用汇总到同一可审计 Task，而不能只保存顶层模型的最终文本。

## 这三天没有新增资料不代表可以停做的能力

这些是由上述新事实重新确认、但应继续按既有路线实现的能力，不把它们误写成“本窗口刚出现的行业标准”。

1. **受控 Runtime Driver（P0）**：服务端生成下一 `Operation`；Host 只可执行已签发操作；支持超时、有限重试、暂停审批、崩溃恢复和人工接管。
2. **统一资源账本（P0）**：一个 Task 汇总顶层与所有子 Agent 的模型、推理强度、token、工具调用、并发槽位、预算消耗和副作用回执；预算耗尽必须安全暂停，而非静默降级。
3. **环境可复验（P0）**：Trial 绑定 Harness/Workflow/Capability/Policy/模型版本及环境摘要；发生控制变更、容器重建或权限改变时，旧结果只保留为历史 Evidence，不自动作为新版本 Promotion 的通过证据。
4. **评测闭环（P0）**：仍需 `Suite × Subject × Case × N trials` 的自动 Runner，确定性结果/状态 Grader 优先，模型 Grader 必须有版本与人工校准；比较输出质量、成本、时延、干预率和失败类别。
5. **证据化演进（P1）**：Trace 只能生成候选，不能直接修改 Skill/Workflow；候选必须在隔离环境与 held-out 集上对照既有版本，通过 Signoff 后才可发布，并保留精确版本回滚。

## 推荐的最小验收指标

将本窗口的“并发但仍需人工控制”落为可测试事实：

| 能力 | 最小验收 |
| --- | --- |
| 子 Agent 归属 | 任一子 Agent 的 Trace、费用、工具回执和失败都可追溯至一个根 Task；根 Task 聚合总量。 |
| 预算与容量 | 超过 per-task 并发或预算阈值时，Driver 写入 `paused_budget`/`paused_capacity`，不再派发新的 Agent。 |
| 人工干预 | 需要批准的 Effect 进入可序列化的 `awaiting_approval`；批准、拒绝或超时均生成不可变 Evidence，并可从同一状态恢复。 |
| 受控环境 | 每个 eval Trial 记录环境/Policy 指纹；指纹变化后，Promotion Gate 拒绝把旧 Trial 当作当前 Candidate 的 held-out 结果。 |
| 评测比较 | 同一 Case 集至少可以比较 candidate 与 baseline 的成功率、成本、时延、人工干预率和失败类型；缺少可比条件时明确拒绝比较。 |

## 检索记录与排除项

- 检索日期：2026-09-08。
- 纳入标准：来源页面同时能核验原始 URL、发布日期与直接相关内容。
- 已检查发布索引：OpenAI Research / Release Notes、Anthropic Engineering / News、GitHub Changelog、Microsoft Learn、VS Code Updates、Google ADK/开发者页面，以及 arXiv 官方 API。
- 明确排除：发布日期为 2026-09-04 或更早的文章、无发布日期的产品页、第三方解读、社交媒体、会议预告、新闻汇总和未能回到原始来源的说法。
- 因窗口很短且周末/索引延迟会影响公开研究入库，后续若出现补录论文，应以论文原始提交时间而非搜索结果的“几天前”标签决定是否纳入。
