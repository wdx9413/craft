# Craft Context 与四类上下文能力：一手资料机制评审

访问日期：2026-10-08。范围：七项官方资料；资料内容是外部机制事实，不是 Craft 实现证明。本文没有复现供应商效果数据、运行模型实验或修改产品实现。建议是评审候选，实施前须与当前代码和既有控制面逐项比较。

## 假设与证据边界

- Context 的目标是让当前决策拿到充分、合法、有效且可回溯的材料；存储量、检索命中、工具成功、上下文长度均不能单独代表目标达成。
- Knowledge、Memory、Experience、Codebase 可以共享范围、预算和引用契约，但原始资料、用户记忆、可执行程序和代码快照各自的更新与使用条件应保留。
- 只研究可借鉴机制，不建议引入整套第三方运行时。下列验收指标是本文提出的候选，不是供应商原有指标或 Craft 已通过的测试。

## 七项资料及对应判断

### 1. Anthropic：上下文预算与渐进读取

来源：[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)，2025-09-29 发布，2026-10-08 访问。

**资料事实：**文章建议保留最小充分的高信号内容，通过路径、查询和链接等轻量标识按需加载；预先检索与运行时探索可混合。长任务可以使用压缩、结构化笔记和隔离子任务；压缩过度可能丢失关键约束。运行时探索也有时延和工具误用成本。

**可借鉴：**Context 首次只提供任务约束、关键状态、来源位置和下一步读取入口；决策点再读取原文。预算不仅统计已选材料，也说明哪些必要内容未能进入。原文与权威状态外置，摘要保留来源，不替代它们。

**不宜照搬：**没有跨模型通用的最优 token 数；不要把“更短”直接变成“更好”，或从文章推导必须部署多代理。

### 2. LangGraph：检查点、历史分支与恢复

来源：[Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)，2026-10-08 访问。

**资料事实：**检查点按 thread 与 checkpoint namespace 保存状态，并带 checkpoint ID、父状态、下一节点和任务信息。`update_state` 创建新检查点，不改写原检查点。Replay 重新执行选定检查点之后的节点，包括模型和 API 调用。文档区分同步、异步、退出时持久化及其崩溃恢复取舍。

**可借鉴：**Experience 程序版本、执行快照和程序改进候选分别保存；Invocation 固定实际使用的版本、输入条件与验收定义。Context 恢复绑定状态版本和引用版本，历史检查点只说明当时状态，不自动授予当前访问权限。线程执行状态与跨线程长期记忆保持不同生命周期。

**不宜照搬：**检查点不是成功经验，也不是外部副作用回滚。可复用步骤必须有独立结果证据；恢复与实验分支须防止重复外部写入。这些治理约束是本文建议，不能说 LangGraph 已替 Craft 提供。

### 3. Letta：显式记忆块与共享写入风险

来源：[Memory blocks (core memory)](https://docs.letta.com/v1-sdk/memory/memory-blocks)，2026-10-08 访问；当前导航标记为 V1 SDK legacy，机制可参考，API 不能当作新 SDK 保证。

**资料事实：**记忆块有 label、description、value 与字符 limit，进入模型上下文；可附着到多个 agent。默认可读写，可设 read-only。更新 value 是整体替换；多进程并发更新采用 last-write-wins，官方提醒可能覆盖 earlier changes。

**可借鉴：**常驻记忆应少量、目的明确、有上限；团队规则可只读。共享记忆需要显式写入责任与修改审计；用户更正、撤销和来源失效应能传播到下一次读取。

**不宜照搬：**共享块不等于知识 ACL；字符上限不等于 token 预算。不要让模型直接覆盖已审查事实或版本化程序，也不要将默认自编辑视为用户同意。

### 4. LlamaIndex：输入版本与转换缓存

来源：[Ingestion Pipeline](https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/)，2026-10-08 访问。

**资料事实：**pipeline 对 node 与 transformation 的组合计算哈希并缓存；docstore 使用 doc_id/ref_doc_id 识别输入。附加 vector store 时，同 ID 内容哈希变化会重新处理并 upsert，未变则跳过；没有 vector store 时能力主要是输入去重。

**可借鉴：**Knowledge 和 Codebase 派生索引同时绑定输入版本与转换配置；源内容或分块/解析配置变化应有明确失效机制。缓存键纳入必要的范围与版本，索引缺失、删除、失败分别返回可解释状态。

**不宜照搬：**哈希去重不能证明事实正确、授权合法或依赖关系完整；正文相同也可能因授权撤销而不再可用。通用文本分块不能替代语言解析和调用链分析。

### 5. Sourcegraph Cody：多路代码上下文与 Host 差异

来源：[Cody Context](https://sourcegraph.com/docs/cody/core-concepts/context)，2026-10-08 访问。

**资料事实：**页面列出 keyword search、Sourcegraph Search 和 code graph，并支持用户显式选择文件、符号和仓库；不同客户端可选上下文种类不同。扩大上下文也增加响应时延。页面的质量收益描述是供应商说明，不是本文独立实验结论。

**可借鉴：**先限定仓库与任务，结合精确符号、词法检索与静态关系候选，允许用户固定关键文件。Codebase 返回代码位置、范围和快照；Context 只决定材料选择，不将检索排序宣称为动态影响事实。

**不宜照搬：**不应假设向量库是必要前提，也不能因为一个编辑器能提供符号选择，就声称所有 Host 的能力相同。跨仓库搜索需要显式授权范围。

### 6. Anthropic：真实效果需要终态评测

来源：[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)，2026-01-09 发布，2026-10-08 访问。

**资料事实：**文章区分 task、trial、transcript 和 outcome；outcome 是环境真实终态，不是 agent 的成功陈述。建议结合代码、模型和人工 grader，校准模型 grader；能力与回归评测分开，重复 trial 衡量不稳定性，隔离初始环境，兼顾该触发与不该触发的案例。

**可借鉴：**固定任务、仓库快照、模型、Host、工具与初始数据，对无召回、现有召回、候选策略做比较。除了检索质量，还观察任务达成、错误材料注入、约束漏召回、成本与时延；Memory/Experience 效果要在真实后续任务中检验。

**不宜照搬：**不能用离线检索通过率、一次模型成功或某供应商分数替代 Craft 收益；也不能把实验输入中的答案写入记忆再宣称记忆提升。

### 7. MCP：跨 Host 验证必须带协议版本

来源：[2026-07-28 Versioning and Compatibility 官方源码](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/versioning.mdx)，2026-10-08 访问。官方网页首次访问返回正文，复核时不可访问，因此以同一官方仓库源码复核：第 11–12 行声明没有 negotiation handshake，第 31–34 行区分 modern 与 legacy，第 66–71 行说明 server/discover。链接跟随 main，后续复核应再次检查，不是固定 commit 证据。

**资料事实：**该修订取消 negotiation handshake，版本、身份和能力逐请求声明；2025-11-25 及之前属 initialize 握手版本。现代 server 必须实现 server/discover，client 可选先调用；dual-era 兼容依 transport 机制识别，modern 与 legacy 不应无条件互通。

**可借鉴：**Host 验收记录实际协议版本、transport 和能力集合，按版本测试发现及真实业务调用。Hookless 路径需要 Host 明确读取 Skill 并调用 MCP，最后验证模型确实读取和使用返回材料。

**不宜照搬：**不能把 initialize 写成跨所有版本的通用验收，也不能仅因为新规范发布就强制旧 Host 升级。协议可调用不证明 Host 会自动注入上下文或遵守 Skill；这需要实际 Host 会话证据。

**Craft 边界：**[当前声明源码](../../core/distribution-and-first-run.ts)第 106–109 行列出三个支持修订 `2025-03-26`、`2025-06-18`、`2025-11-25`，并标记 `assessed_deferred`；仓库已有 [迁移评估](v01233-mcp-2026-07-28-migration-assessment-2026-09-18.md)。暂缓新修订不构成已证实的通用缺陷；真实 Host 只应按双方声明且实际支持的版本验证。本文没有宣称 Craft 支持 2026 修订，也没有证明任何 Host 因此发生实际接入失败。

## 评审优先级与候选验收

以下是基于上述资料的设计建议，均需由 Craft 当前代码和真实实验确认。

| 顺序 | 评审问题 | 可验证条件 | 不足以证明的证据 |
| --- | --- | --- | --- |
| 1 | 材料是否仍可用且合法 | 撤销、更正、冲突、过期和跨 scope 案例能正确排除或显式拒绝；历史引用重新授权 | 查询命中、无异常 |
| 2 | Context 是否充分并可解释 | 必要约束可追溯；预算不足显式失败；选择、省略与读取来源绑定同一状态快照 | 单纯降低字符或 token |
| 3 | Experience 是否安全复用 | 固定 Procedure 版本；Entry/Exit 验证；Invocation 绑定独立结果；旧版本可禁用 | 一次工具成功、保存了 transcript |
| 4 | Codebase 是否新鲜且有边界 | 修改、删除、配置变更后引用对应新快照；未支持语言和解析失败显式 partial | 建索引成功、返回符号 |
| 5 | Hookless 是否跨 Host 成立 | 各实际 Host 在无 Hook 会话中完成版本兼容、发现、业务召回、后续读取并形成使用证据 | 安装、enabled、readiness |
| 6 | 是否带来任务收益 | 隔离 trial、对照与重复运行；报告达成率及成本/时延；保持回归能力 | mock 测试、供应商营销、少量 demo |

最值得先做的是材料生命周期与可解释选择，再做程序版本绑定和真实任务对照。以上七项资料没有证明 Craft 已具备这些条件，也没有证明引入新框架、向量数据库或自动学习即可改善实际效果。

## 本轮上下文调用记录

按 Craft Context Skill 使用 context-only 路径：`context_resolution_c3b94678f0c14e909b85ba377e008cca`，`context_pack_06826c08f4649d1e2a4435a1`；返回 zero selected items、partial=false，Codebase=skipped/not_requested。这只证明本次限定范围调用与状态返回，不证明材料覆盖率或模型收益。
