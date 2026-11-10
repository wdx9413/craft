# Agent Harness 近期一手资讯与 Craft 差距判断

> as_of: 2026-09-14  
> 窗口：优先核验 2026-08-31 至 2026-09-14；窗口不足处补充近半年一手资料，并明确日期。  
> 方法：只把官方产品公告、工程文章、规范当作外部事实；“对 Craft 的推论”是设计判断，不等同于行业标准或已实现能力。

## 结论

近两周最明确的行业变化不是“又出现一种编排框架”，而是模型厂商把 **Harness + 计算环境 + 长程状态 + 子 Agent** 作为正式产品面交付。与此同时，公开运行数据仍显示长任务需要人工干预，高权限环境需要比普通工具调用更强的控制。

因此 Craft 离理想态的最高优先级，仍是把已存在的控制面变成有真实证据的运行闭环：**受信 Host/环境回执、真实 Outcome 评测、人工干预与恢复数据**。不应为了追热点默认多 Agent，或让托管 Provider 取代 Craft 的任务事实与证据账本。

## 近期一手信号与含义

| 日期 | 一手事实 | 对 Craft 的推论 | 优先级 |
| --- | --- | --- | --- |
| 2026-09-10 | [OpenAI Agents API](https://openai.com/index/introducing-the-agents-api/) 公开 beta。OpenAI 将长会话、工具效率、子 Agent 协调和持续运行放入托管 Harness；计算环境可选 OpenAI sandbox、自有基础设施或合作方 sandbox。 | Provider Harness 是可接入的 **Host/Compute Adapter**，不是 Craft 的事实源。Craft 需要记录 Provider run、环境摘要、模型/配置版本、取消与最终再观察；Provider 回答“完成”不能直接成为 Craft Outcome。 | P0 |
| 2026-09-06 | [OpenAI 内部研究 Agent 使用测量](https://openai.com/index/research-acceleration-view-inside-openai/) 报告高并发会包含下游 subagent；在已成功的 4–8 小时任务中，超过一半仍有至少一次人工干预。文中还披露在研究环境被 Agent 破坏后曾暂停部分负载，并在加强控制后恢复。 | 将 `intervention / interruption / approval / resume` 作为一等可观测事件与评测指标；父 Task 必须聚合子 Agent 的成本、并发、回执和副作用。多 Agent 只能受容量/预算/隔离工作区约束，不能作为默认拓扑。 | P0 |
| 2026-09-01 | [OpenAI Path to Astra](https://openai.com/index/path-to-astra/) 说明更高能力模型在网络安全场景需要在开发和发布前强化保护与测试。 | Capability 描述、MCP annotation 或模型自评都不是安全证明。Craft 应继续将“发现能力”与“签发执行权”分离，并为高风险 Effect 保留环境证明、审批与可观察/补偿路径。 | P0 |
| 2026-08-27（补充） | [Google DeepMind 双盲 AI 评测试点](https://deepmind.google/blog/piloting-the-worlds-first-double-blind-ai-evaluations/) 描述用保密计算使模型开发方和评测方都无法查看对方敏感材料的双盲机制。 | Craft 无需为早期试点建设保密计算，但 held-out Case 至少应有来源、访问主体、digest、Grader/环境版本与分区审批的不可变证明，防止测试集泄漏或被开发过程污染。 | P0 |
| 2026-08-04（补充） | [OpenAI 第三方网络安全评测](https://openai.com/index/third-party-cyber-evaluations-involving-openai-models/) 记录隔离 CTF 环境因配置错误出现公网访问的事件，并说明随后加强控制。 | “配置了 sandbox”不是安全结论。每次可写运行应产生网络 deny/allowlist、文件/进程边界、环境 fingerprint、暂停/终止回执；安全检测需要覆盖行为序列，而不只检查单个工具请求。 | P0 |
| 2026-07-28（补充） | [OpenAI 科学计算现场报告](https://openai.com/index/scientific-computing-agentic-ai/) 观察到 Agent 可加速实现，但无法可靠判断科学有效性；最强验证方式依赖外部参照、精确结果比对、统计性质或预先确定的模拟数据。 | Craft 的真实 Eval Suite 应优先建设领域状态验证器与人工金标，而非把模型 Judge 或单元测试覆盖率当作交付质量。Candidate/Baseline 比较要以外部 Outcome、成本、时延、干预率和失败类别收口。 | P0 |
| 2026-03-24（补充） | [Anthropic 长程应用 Harness 设计](https://www.anthropic.com/engineering/harness-design-long-running-apps) 显示独立 evaluator 能缓解 Agent 自评偏宽，但同时增加编排复杂度、token 与时延。 | “独立评估器/Expert/子 Agent”应作为明确 Harness 变体，在同环境、等预算、重复 Trial 的真实 Case 上证明净收益后才进入默认 Activation Profile。 | P1 |
| 2026-07-28（补充） | [MCP Tasks RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) 提议以 task handle 支持异步工具任务；其草案特别提示 task ID 可能近似 bearer token，所有 Task 请求仍需鉴权。 | 外部 MCP task 应映射为 Craft 的 Operation/Receipt Adapter，并绑定主体、会话、权限与 TTL；不能把外部 task handle 当成 Craft 可枚举的全局任务身份。 | P1 |

## 对理想态的优先级映射

### P0：从“协议正确”到“真实运行可证明”

1. **可信 Host / 环境回执 Adapter**：为至少一个真实 Host 建立规范化 `dispatch → receipt → re-observe → acceptance` 链路；保存环境、模型、Harness、Policy、输入与输出对象的摘要指纹。
2. **真实 Eval Campaign**：先导入两个脱敏任务域（研发、文件/媒体），使用外部状态验收器与少量人工金标；同 Case、同环境、等预算下比较 minimal single-agent 与一个候选 Harness，允许结果为 `inconclusive`。
3. **干预、恢复与预算账本**：把人工接管、审批、超时、取消、重试、子 Agent 并发槽位和成本汇总到根 Task；环境/权限/输入指纹变化后强制 `needs_replan`。
4. **高风险执行的环境证明与轨迹监测**：不以“声明启用 sandbox”作为结论；每个可写 Adapter 必须有工作区、网络、凭据、取消清理、资源上限和再观察的 Conformance 证据。为危险行为序列提供分类、阻断/暂停/撤权、回滚和 replay drill；不能满足则只读或拒绝。

### P1：仅在 P0 产生数据后扩展

- **托管 Harness Adapter**：接 OpenAI/其他 Provider 的 run、checkpoint、artifact 和 cancel 语义，但 Craft 保留 Task、Policy、Evidence、Acceptance 和 Promotion 的中立账本。
- **可评测的子 Agent / evaluator**：子 Agent 最多按父预算和隔离工作副本运行；独立 evaluator 需有独立输入范围、Grader 版本和金标校准。
- **异步互操作**：用 MCP Task/A2A 的 Adapter 接入外部运行，不让外部 task id、工具元数据或远程“成功”绕过 Craft 的身份、授权和验收。

## 不应跟风的方向

- **默认多 Agent**：近期一手资料证明并发正在发生，但同时证明人工干预和环境风险仍高；先拿到单 Agent 基线与净收益数据。
- **让托管 Agent API 替代 Craft**：它解决某一 Provider 的执行便利性，不解决跨 Host 的任务事实、证据生命周期、业务验收与候选发布治理。
- **把 LLM Judge 当发布 Gate**：没有校准和外部状态验证时只能作诊断信号，不能单独晋级 Candidate。
- **“自动自进化”直接改 Prompt/Skill/Workflow**：真实 Trace 最多形成带假设与适用范围的 Candidate，仍须 shadow、held-out、Signoff、Canary 和精确回滚。
- **先做全局行业树、世界模型或 Agent 市场**：它们不解决当前最关键的 Outcome 真实性、环境可信性和长期运行恢复问题。

## 近期可验证的下一步

将下一阶段定义为一个小型真实闭环试点，而不是新平台层：运行两类脱敏 Case，接入一个真实 Host 与一个受控写入环境，记录人工干预并进行至少三次 paired Trial。验收问题只有一个：

> 在同一任务、环境和预算下，Craft 选择的最小 Harness 是否能以可观察 Outcome 改善成功率、恢复率或人工返工，而不造成不可接受的成本、安全或时延回归？

若答案尚无证据，结论应为 `inconclusive`，而不是继续增加抽象或宣称自进化有效。
