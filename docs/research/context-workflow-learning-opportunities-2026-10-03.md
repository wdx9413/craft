# 从 Linkly、loop-me 与持续进化资料看 Craft 的下一步

核查日期：2026-10-03。结论依据：用户提供的三份材料、官方一手页面、Matt 的 Skill 源文，以及当前 Craft 工作区源码。只做研究，没有修改功能代码、安装 Skill、创建自动化或发布学习资产。

## 结论

这些资料对 Craft 有帮助，最值得吸收的是三个连接点：**人怎样把反复做的事情讲清楚；人怎样看到 Agent 使用了什么；系统怎样证明某条经验改善了下一次任务。**

Craft 已有知识/记忆管理、受限上下文、Experience 候选与晋级、Procedure 组合和调用恢复。建议沿这些现有能力补入口与反馈，不另建循环执行器，也不把 Craft 改造成完整的个人网盘、剪藏或笔记产品。

## 1. 四份材料分别贡献什么

| 材料 | 可吸收内容 | 使用边界 |
| --- | --- | --- |
| Linkly AI 1.0 | 管理入口、解析失败原因、Agent 读取记录、人和 Agent 的作者区分；用户应能看见并控制上下文资产。 | 官方发布说明证实这些产品功能；用户贴文里的激活率变化属于创始人叙述，没有公开对照实验，不能据此预测 Craft 留存增长。 |
| Matt Pocock `loop-me` | 从反复出现的工作模式出发，访谈、比较自动化程度、形成可交接工作流规格。 | 当前是 Beta 规格设计 Skill，不是工作流执行器或自我学习引擎。 |
| 用户附件《AI Agent 怎么越用越好》 | 区分证据、诊断、经验，分开在线交付与后台改进；检查提案、验证、装载和真实结果。 | 对 Craft 的关键是验证实际闭环，不能将研究示例或一次成功当产品效果。 |
| 用户贴文《可回滚流水线》 | 将触发、输入、处理、输出、复核和失败处置写成明确合同。 | 这是有用的设计检查表；六环节不是通用执行标准，也不意味着每个任务都要固定人审或真正可回滚。 |

来源：[Linkly 1.0 官方发布说明](https://linkly.ai/changelog/linkly-ai-1-0-2026-09-28)、[loop-me 一手源码研究](matt-loop-me-primary-sources-2026-10-03.md)、[李博杰第九章](https://bojieli.github.io/ai-agent-book/book/chapter9/)。后两篇用户材料已完整阅读；没有把其未核验的所有论文结论复述为事实。

## 2. loop-me 到底如何实现

它的主体是自然语言 Skill：读取已有工作流与访谈笔记，找出用户的重复工作模式，由 `/grilling` 追问尚未明确的决策，持续整理成 `workflows/*.md` 与 `NOTES.md`。模型与 Host 提供推理、提问和文件操作，Skill 本身没有实现后台调度器。

这里的 Loop 指生活/工作中反复发生的模式，Workflow 是为该模式设计的规格。完成标准是规格足够明确，可以交给实现者，而不是某一次自动化已经跑通。它也没有实现每轮自动清空上下文、运行失败自动重启、跨任务评测晋级或自动安装新技能。

它特别强调四个词：Trigger（触发条件）、Checkpoint（人作决定的位置）、Push right（尽量把准备工作做完再交人判断）和 Brief（附成果链接的简短决策摘要）。其中 Push right 最值得迁移：先准备可审阅成果，再让用户决定；仍须在产生未授权副作用之前停下。

上游将它放在 `skills/in-progress/loop-me`，尚未进入稳定插件目录；因此 `ask-matt` 没列出它与源码存在并不矛盾。`ask-matt` 在本次任务中的正确作用是路由到 research；无需为一次研究先搭 issue tracker 或进入实现流程。

完整文件组成、固定版本、访谈维度及上游未实现建议见[一手研究](matt-loop-me-primary-sources-2026-10-03.md)。本节是机制概括，不是安装或执行该 Skill。

## 3. 对照 Craft 当前实现

本次读取的是存在大量未提交变更的工作区，Git HEAD 为 `9ada1c7a92dfc3847837b063081176696ca9f463`。以下结论不等于该提交或已发布安装包具备所有同样行为。

| 对照点 | 当前源码证据 | 判断 |
| --- | --- | --- |
| 人工管理上下文 | [资源页](../../workbench/resource-pages.js)提供记忆新增、编辑、停用；[主界面](../../workbench/app.js)的 `viewKnowledge` 展示 Claim、页面、知识包，支持编辑。 | 已有管理面，不能说 Craft 只服务 Agent 或没有 UI。 |
| 人工设计工作流 | `openWorkflowEditor` 要求填写输入与步骤 JSON；[输入适配](../../core/application/use-cases/workbench-workflow-input.ts)转为现有 DAG 草稿。 | 最接近 loop-me 的现有入口，但仍偏开发者表单，缺少此入口内的访谈式规格整理。 |
| 经验形成 | [WorkflowEvolutionKernel](../../capability/craft-experience/workflow-evolution.ts)校验同 Scenario Signature、至少两条独立来源、最多两个设计轴。 | 已有证据驱动链，用户口述不能冒充两次实际运行。 |
| 验证后才能复用 | [ProcedureStore](../../capability/craft-experience/procedure-projection.ts)保存 candidate，按 shadow、held_out、signoff、canary 晋级；[ExperienceContribution](../../capability/craft-experience/contribution.ts)仅注入匹配 scope 的 routeable Procedure。 | 应保持既有门禁；增加前端入口不应降低可信度要求。 |
| 规格与执行分开 | [ProcedurePlanner](../../capability/craft-experience/procedure-composition.ts)返回 `execution_authorized:false` 与 `acceptance_status:not_evaluated`。 | 与 loop-me 设计后交接的思路一致。 |
| 受控运行和恢复 | [ProcedureInvocationKernel](../../core/application/procedure-invocation.ts)已有 bind/dispatch/report/resume/get/evaluate，复用 DurableActionLoop。 | 不应另造一个 Ralph 式循环。实际动作仍由 Host 执行。 |
| 有限自动化 | [ProcedureAutomationKernel](../../capability/craft-experience/procedure-automation.ts)固定版本/摘要，要求验证步骤，限制 effect、次数、配额、无进展与超时；未知结果转对账/交接。 | 已有六环节文章所强调的多项机制，具体外部操作是否可补偿仍需逐项声明。 |
| 下一次是否拿到经验 | [ContextResolutionKernel](../../core/context-resolution.ts)记录范围、条目引用、预算和 contribution；现有代码已统一候选排序。 | 可以复用回执做用户解释；不要照抄旧报告，把已补齐的统一检索再列为缺口。 |
| 是否改善结果 | Invocation 的 `evaluate` 比较 3–100 对终态调用，固定 scope、Entry/Exit、输入、初始快照、Host、模型和预算；结果保留 `host_attested`，不自动晋级。 | 评测接口已存在；本次没有运行真实配对实验，不能宣称已证明学习收益。 |

相关现有测试已阅读：[资源页](../../tests/workbench-resource-pages.test.ts)、[自动化](../../tests/procedure-automation.test.ts)、[Procedure 调用](../../tests/procedure-invocation.test.ts)。它们是机制测试参考，本次研究未重新执行产品测试。

## 4. 最值得做的三个改进

### 4.1 让既有回执回答人的问题

借鉴 Linkly 的透明性，将资产、调用记录和控制动作连起来。优先在现有知识/记忆/工作流详情页增加一个可展开的“使用与依据”视图：

- 来源与作者：用户写入、Agent 建议、外部资料分别可辨；显示作用域、版本与有效状态。
- 本次使用：哪个任务、哪个 Host 得到了哪个版本，选择依据与预算截断是什么。
- 未使用原因：未审核、过期、冲突、范围不符或预算不足；仅在实际记录支持时显示，不能推断出一次全库拒绝清单。
- 可执行操作：查看来源、修改为新版本、停用，以及操作实际影响范围。

**重要区别：** Context Receipt 证明内容被解析/提供，不能单凭它证明模型已理解、遵循或因此完成任务。界面应区分“已提供上下文”“动作引用了它”“结果已验证”；证据不足的层级保持未知。

最小验收：添加一条知识→审核→在任务中召回→查看精确版本和回执→停用→新任务不再召回；另一项目不能读到。数量指标需固定 scope 和状态口径，列出待审核、有效、失效、失败，不将库总量直接等同于本次可用量。

这是基于当前页面与回执能力提出的产品建议；本次没有启动桌面应用做可用性测试，不能将源码差距扩大为完整 UX 审计。

### 4.2 给工作流草稿增加“帮我梳理这件重复工作”入口

从 `loop-me` 吸收访谈法，先做一个薄的规格整理入口，复用已有 Host 和草稿能力。第一步甚至可以是仓库内的规格文件与 Skill 调用约定，不必新增数据库表或执行引擎。

建议整理的内容：

1. 最近一次具体做了什么；正常、失败与例外各是什么。
2. 什么触发，输入来自哪里，缺失、重复、延迟怎样处理。
3. 哪些判断必须由人决定，哪些步骤可以确定执行。
4. 输出给谁、放在哪里；如何证明产物正确，而不仅是请求已受理。
5. 权限、时间和成本预算；哪些结果要人确认。
6. 失败时重试、重新规划、交接还是补偿；何时必须停止。

产出是可审阅的 Workflow Spec 草稿，列出未决问题、样例与验证合同。人确认规格只确认意图，不代表已经通过运行验收。

有两条来源不同的路径，不能混写：

```text
人工口述/访谈 → 设计规格草稿 → 实现/人工演练 → 验证结果
实际执行结果 → 独立 Observation → Experience Candidate → 既有质量门禁
```

新规格先走设计路径；取得真实独立结果以后，才有条件进入经验提案路径。尤其不能为调用 `craft_experience_procedure_draft` 而伪造观察记录。

最小验收：不要求用户写 JSON；用正常、空值、重复、失败样例完成规格；缺少决定时保留未决；保存不执行、不安装、不产生 routeable Procedure。进入执行阶段前复用既有权限与验收边界。

### 4.3 将“经验是否有用”做成一次能看懂的实验

附件的价值在于把四个失败位置分开：提案无效、没有召回、召回后未遵循、遵循后业务结果仍失败。Craft 已有多数记录基础，应该用一条真实任务贯穿它们。

建议先选“异步导出不能把受理当完成”这一类易验收场景：

- 固定成功条件：后台终态成功、目标文件存在且内容范围正确。
- 变更只改一个规则或步骤，绑定接口版本与适用条件。
- 配对案例包含异步、同步直接返回文件、失败、取消、超时及重复提交风险。
- 用相同 Host/模型/输入/预算进行 3–5 对试验，保留未通过、缺证据与回归，不只留成功记录。
- 看终态通过率、旧错误复发、重复副作用、调用成本与时延；随后检查一个新会话是否取得准确版本并正确执行。

这只是建议的试验合同，本次没有真实接口授权或数据，不创建导出任务，也不声称已有改善结果。来源：[第九章](https://bojieli.github.io/ai-agent-book/book/chapter9/)、[当前 Invocation 评测实现](../../core/application/procedure-invocation.ts)。

## 5. “回滚”要拆清楚

六环节文章可以帮助完善失败处置，但不能把保留输入或版本理解成万能撤销：

- 经验版本回退：停止使用新 Procedure，重新选定已验证旧版本。
- 本地文件恢复：在保存原状态并确认没有冲突后，恢复本次管理范围的产物。
- 外部副作用补偿：已发消息、已创建任务等通常需要专门补偿动作，部分操作不可逆。
- 结果未知：先对账，不盲目再执行。人工队列是一种交接，不等于已撤销操作。

因此应在规格中声明失败处置和可逆性，而不是对每个步骤都提供一个看似万能的“回滚”按钮。当前 Automation 对 `effect_unknown` 的处置可复用；不应扩大成未经验证的外部回滚承诺。

## 6. 本次会话暴露的接入问题

Knowledge 与 Experience readiness 均实际成功返回；共享 `craft_context_resolution_resolve` 对当前项目完成了受限解析，返回 Memory 条目以及 Knowledge/Experience contribution。查询本次 Knowledge 无命中，Experience contribution 为空，这只说明本次范围/查询没有相应结果。

开始回执：`context_resolution_ecdca864e3ef41e4968d22ea909b4348`。未发现可直接调用的独立 `mcp__craft_memory__*` 工具；Memory 使用通过共享 resolver 完成，不将其描述为独立 Memory MCP 已验收。

两项真实失败值得先于新产品入口处理：

| 会话公开参数类型 | 实际调用结果 | 当前源码对照 |
| --- | --- | --- |
| `craft_procedure_list.scope` 暴露为 object | 传对象返回 `scope must not be empty`，不能视为空 Procedure 库。 | [ProcedureStore.list](../../capability/craft-experience/procedure-projection.ts)要求非空字符串；[当前 schema](../../core/mcp/tool-schema.ts)也写 string。 |
| `craft_component_diagnose.observed_tool_names` 暴露为 string | 传字符串返回 `observed_tool_names must be an array`。省略可选字段后诊断成功。 | 当前运行时实际要求数组，与会话描述不一致。 |

已证实的是本次 Host 工具描述与实际行为不一致。究竟是 Host 缓存、插件包还是 Schema 转译导致，本次未定位，不推断根因。建议验证完整的参数契约与真实业务调用，不能只验证工具名、readiness 或安装状态。也不能把当前源码的正确 schema 当成当前 Host 已更新的证据。

## 7. 建议顺序与完成边界

1. **先修实机可调用性。** 对齐上述参数契约，验证实际 scoped list / context 调用及失败状态；通过后再谈“已接入”。
2. **做一条可见的上下文闭环。** 复用现有页面与 Receipt，让用户看到来源、使用、停用与下一次不再召回。
3. **做一个访谈式工作流草稿入口。** 只支持一类有真实需求的重复任务，与既有草稿/验证/执行链衔接。
4. **跑一个真实配对实验。** 证明指定改动对指定任务有收益，再考虑拓展自动学习与自动化范围。

暂不建议为了这些文章新增独立聊天入口、通用资料管理全家桶、自主修改全局 Skill 的守护进程或无限重试循环。Local First 也不能代替数据流说明：第三方模型实际收到什么，仍需按调用与 Receipt 展示。

研究完成标准：准确识别 loop-me；为 Craft 判断给出当前代码依据；把已具备机制、产品建议和未验证效果分开；文档链接可检查。此次仅新增研究文档，未要求实现，也未运行产品测试或覆盖率；增量代码覆盖率不适用于纯研究文档变更。

已运行仓库 `scripts/ci/check-doc-links.ts`：222 份文档、641 个内部链接、19 个 ADR 索引检查通过。两份新增文档另做文件级空白/冲突标记检查；没有重写或清理用户原有未提交改动。
