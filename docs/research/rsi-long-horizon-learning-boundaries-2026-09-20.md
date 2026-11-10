# RSI、长任务与可验证学习：对 Craft 的边界研究

调研日期：2026-09-20  
资料范围：论文原文、作者维护的 RSIAgent 仓库、Anthropic 与 OpenAI 官方技术文档。本文不将二手文章中的叙述或单次演示视为结论。

## 结论

RSIAgent 对 Craft 的真正启发不是“默认改成三个 Agent”，而是把学习链条拆成相互可审计的五件事：**在决策前取得适用经验、在真实环境中执行、由独立验证器检查终态、把失败固化为带触发条件的回归 Case、仅把经验证的模式作为下一次的最小上下文**。

Craft 已有 Trace、Receipt、State/Acceptance、Memory/Knowledge、Candidate 和 Eval 的零件；当前缺口是将这些零件在同一个 `VerifiedWorkLoop` 内自动闭合，并用“老错误复发率”而非“记忆条数”衡量学习是否有效。

## 一、可确认的 RSIAgent 事实

1. RSIAgent 是一篇 2026-09-14 发布的 arXiv 预印本及对应开源实现；它**不更新模型参数**，而是由 Curriculum、Actor、Verifier 三个角色探索环境、验证结果并构建可复用记忆。[论文摘要](https://arxiv.org/abs/2609.15364)、[作者仓库](https://github.com/AetherLabsAI/RSIAgent)
2. Actor 执行动作，Verifier 独立检查任务需求和结果环境；仓库明确说明 Verifier 不能读取 Actor 的私有推理或记忆。这是“不要让执行者给自己判卷”的实现边界，而不是泛化的多 Agent 宣传。[框架说明](https://github.com/AetherLabsAI/RSIAgent#-framework)
3. 它分为 broad exploration、deep exploration、frozen-memory test-time reuse 三阶段。测试阶段禁用 Curriculum 和记忆更新，避免评测答案污染学习状态；基准评分留在学习环外。[方法与阶段定义](https://github.com/AetherLabsAI/RSIAgent#-method)
4. 作者仓库报告 OSWorld 2.0 partial credit 从 71.97 升至 78.98；同时明确该 RSI 汇总只使用部分记录、保留其余 baseline，并混入记录的 retry/checkpoint 与不等预算，**不是匹配重复 Trial 的平均值**。因此它是有前景的研究信号，不构成 Craft 采用多 Agent 的净收益证据。[报告范围](https://github.com/AetherLabsAI/RSIAgent/blob/main/docs/PAPER.md)
5. 作者自己的失败分析列出：探索未命中真正弱点、验证接受不完整工作、记忆巩固错误。因此“多探索/多记忆”本身不能证明会提升质量。[仓库结果与限制](https://github.com/AetherLabsAI/RSIAgent#-results)

## 二、文章中的主张：可采纳与不可确认部分

| 主张 | 判断 | 原因 |
|---|---|---|
| 三角色应分离，批改者不看做题草稿 | **有实现依据，但非通用必需** | RSIAgent 的 Verifier 隔离有源码/文档依据；低风险确定性验收不需要额外 Agent。 |
| OSWorld 71.97 → 78.98 | **作者报告，尚非独立复现** | 口径含选择性 RSI 条目、retry/checkpoint 和不同预算，不能当作严格 A/B。 |
| REAPER 68 → 94.17 | **本轮未在论文、作者仓库或官方报告中找到** | 不应写入 Craft 的事实库或产品文档。 |
| “只要把规则存进记忆就能避免复发” | **不成立** | 经验若没有在相关决策点进入上下文、没有触发条件或没有回归验证，仍会复发。 |
| 自动自我改进可以直接改默认 Skill/Prompt | **不成立且不安全** | 应先形成 Candidate，再经 Shadow、held-out、Signoff、Canary 验证。 |

## 三、长任务不跑偏、不摆烂、不阻塞的已验证工程原则

Anthropic 的长任务实验说明，仅靠上下文压缩不够：Agent 容易一次做太多、留下半成品，或看到已有进展就错误宣布完成。其有效做法是首轮建立需求/进度/可验收特征清单，后续每轮只推进一个小特征并留下结构化交接。[长任务 Harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

对应到 Craft，应把每个可恢复 Step 固定为：

```text
目标与验收条件
→ 决策点 Context Receipt（含触发条件和约束）
→ Action Contract / precondition
→ Host Receipt
→ State Re-observation
→ 独立 Acceptance
→ Checkpoint / structured handoff
```

因此应以如下指标治理长任务，而不是靠模型“自觉”：

| 失效模式 | 运行时控制 | 可度量信号 |
|---|---|---|
| 跑偏/上下文漂移 | 在每个行动决策点重新解析最小 Context，输入/状态漂移即 `needs_replan` | 过期 Receipt 使用率、漂移后重规划率 |
| 摆烂/过早完成 | Host 完成仅是 Receipt；State Observer + Acceptance 才能生成 Outcome | 自述完成但验收失败率 |
| 无进展循环 | 每 Step 有预算、租约、进展谓词、最大重试及首错归因 | 无效重试率、停滞终止率 |
| 宕机/阻塞 | append-only Trace、Checkpoint、心跳/租约、可重建 Context；不可重新附着即 `interrupted` | 恢复成功率、重复副作用率 |
| 修复同一坑却复发 | 把失败建成触发条件 + 独立验证器 + 回归 Case 三件套 | 复发率、回归 Case 覆盖率 |

OpenAI 与 Anthropic 的官方资料也支持“外置持久状态 + 可重建执行环境”的方向：前者将 snapshot/rehydration 用于容器失败后的恢复，后者将可恢复 Session Log 与具体 Context 管理分离。[OpenAI Agents SDK](https://openai.com/index/the-next-evolution-of-the-agents-sdk/)、[Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents)

## 四、对 Craft 的具体改造边界

### 应做

1. **Decision-point Context Gate**：不只在任务开头检索 Memory/Knowledge；在 Tool 选择、参数决定、写入/外部 effect 前，按 Step 的 target、precondition、environment 与 failure signature 解析最小上下文，并保存 `Context Resolution Receipt`。
2. **Failure 三件套作为同一产物**：每个已确认失败同时生成 `Failure Attribution`、带触发条件的 `Regression Case`、以及候选规则/Memory/Workflow Diff；三者互相引用同一 Trace、Receipt、真实终态。
3. **独立验收优先**：文件、命令、数据库等可确定检查先于 LLM Judge；LLM Judge 只能诊断，未校准不得晋级。对高风险或主观产物再使用隔离 Evaluator/盲评。
4. **经验的作用时机可评测**：新增 `decision_point_recall_precision`、`precondition_hit_rate` 与 `recurrent_failure_rate`。一条经验即使被检索到了，若晚于决定发生，视为未命中。
5. **学习与线上执行隔离**：生产 Run 只消费已验证的 Knowledge/Memory/routeable Workflow；维护/学习 Run 可以读 Trace 与 rejected candidate，但不得直接改变生产默认。

### 不应做

- 不因为 RSIAgent 使用三角色而默认启用多 Agent。只有在相同 Case、Host、模型、预算、环境下的重复配对 Eval 证明净收益，才进入 Activation Profile。
- 不让执行 Agent 直接把每轮总结写成长期事实或全局 Skill。
- 不把“探索次数”“记忆条数”“LLM 自评提升”当作业务质量提升。
- 不用不可比较的 benchmark retry、checkpoint 或选择性样本给 Craft 计算改进率。

## 五、建议的最小验收实验

选择一个历史上真实复发的 Coding/File 场景，建立 baseline 与候选：

1. baseline：现有 Context/执行链；
2. candidate：只增加 `Decision-point Context Gate + Failure 三件套`；
3. 固定 Case 版本、Host、模型、环境、预算与验收器，至少 5 组配对 Trial；
4. 记录终态达成率、首次成功率、无效重试率、上下文 token、复发率；
5. 只有终态和复发率同时不退化、且成本增量合理时，才将候选提升为可路由 Harness 变体。

这比先引入默认多 Agent 更能检验“这次经验有没有在下一次正确的决策点发挥作用”。

## 来源

- [RSIAgent 论文，arXiv:2609.15364](https://arxiv.org/abs/2609.15364)
- [RSIAgent 作者维护的实现与报告口径](https://github.com/AetherLabsAI/RSIAgent)
- [Anthropic：Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic：Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic：Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)
- [OpenAI：The next evolution of the Agents SDK](https://openai.com/index/the-next-evolution-of-the-agents-sdk/)
