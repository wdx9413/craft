# Context 与子能力：业界机制增量对照

核查日期：2026-10-09。本文是研究与源码对照，不是实现报告；不修改功能代码、不运行真实模型实验。先阅读了 [前次一手资料评审](context-primary-sources-2026-10-08.md) 与 [修复记录](context-remediation-2026-10-09.md)，已修复的授权竞态、引用身份、SDK 依赖、正式/测试双版本不再列为缺失能力。

## 判断原则

当前最有价值的增量是把已有机制接成真实有效的链路，而不是继续增加工具数量。Context 的 module 应通过小 interface 隐藏选择、生命周期和成本；Knowledge、Memory、Experience、Codebase 的事实合同不能混成一个通用记忆库。下列外部资料只证明外部机制存在，收益仍需 Craft 独立验证。

页面以当前访问内容为准，不把搜索引擎显示的抓取时间当发布日期；main 分支链接不是冻结 commit。论文以明确版本引用。未复现论文实验，也不借用其收益数字。

## 一手能力与当前差距

### Context：推荐工具集合与真正按需加载仍不同

**外部事实。** [Claude Tool Search 官方文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)说明 `defer_loading` 决定工具定义何时进入模型上下文，完整定义仍须随请求提供给平台；发现结果由平台展开。MCP connector 有独立配置方式。这是一种 Host/模型平台合同，不是普通 MCP server 返回几条 Schema 就自动获得的能力。

**当前已实现。** [context-tools.ts](../../core/mcp/context-tools.ts)按 intent 返回推荐工具及 Schema，明确 `changes_host_registration:false`；[Working Set](../../core/context-working-set.ts)与 Open 已统一引用，支持 Host history/state 引用。前次修复报告已明确实际 Host 初始 Schema token 未获证明。

**优化候选。** 做真实 Host Adapter 的能力矩阵和实测：支持延迟发现的 Host 使用其原生合同，不支持的保持完整注册；比较模型初始 Schema、发现漏召回、实际工具使用及失败恢复。工具描述补充最小有效调用及错误例，比再新增通用工具更有 leverage。不要强制所有编程工具使用 Claude 平台参数。

### Context：预算与历史压缩应留在正确 seam

**外部事实。** [Claude Context Editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)区分选择性清除工具结果与压缩历史；被清除内容由占位提示代替，压缩以摘要替代完整历史。当前文档推荐 server-side compaction，旧 SDK `compaction_control` 有弃用差异。

**当前已实现。** Craft 已有材料预算、必要引用失败、token 估计及 Host 报告计量；history/state 是 Host 提供的版本化引用，而非完整消息归档。

**优化候选。** 将“模型确实看见了什么”绑定至最终 Host emission：摘要后的必要约束、已省略原文及重新读取入口应可核对。压缩历史应由拥有消息的 Host Adapter 处理；Context 提供可信引用与重新获取能力。不要把 Context 改造成第二个聊天消息所有者，也不能将 token 估计当 Host 精确计费。

### Knowledge：可追溯引用不等于引用真的支持结论

**外部事实。** [LlamaIndex CitationQueryEngine](https://developers.llamaindex.ai/python/framework-api-reference/query_engine/citation/)提供 citation chunk 粒度与 source nodes；[官方评价模块](https://developers.llamaindex.ai/python/framework-api-reference/evaluation/)分别评价 Context 对问题的相关性、回答对给定 Context 的支持程度。两种检查不等价。

**当前已实现。** [Claim Governance](../../capability/craft-knowledge/claim-governance.ts)具备候选审核、证据与来源检查、过期/变更/矛盾同步；[Source Registry](../../capability/craft-knowledge/knowledge-source-registry.ts)导入片段保留源偏移、版本及 cursor 漂移检查。因此“没有来源同步或片段引用”不是当前事实。

**优化候选。** 对 held-out 知识任务分别验收检索覆盖、来源片段支持与最终答案；以人工校准的 judge 或可执行断言判断支持关系，不能只因 Evidence 存在或格式正确就认定结论成立。源码 `synchronize` 当前全量读取 reviewed Claims 与活动矛盾边，规模扩大时值得按失效 Source/Document 反向依赖定位待重验条目。只有出现真实 connector 需求才加增量远端 connector，不先搭完整连接器平台。

### Memory：双时间已有；排序与历史读取的接法仍可深化

**外部事实。** Graphiti [EntityEdge 官方源码](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/edges.py)区分事实生效/失效与记录创建/失效时间；[SearchFilters 官方源码](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/search/search_filters.py)允许对应时间过滤。因此“当时发生什么”和“当时系统知道什么”可以是不同查询。

**当前已实现。** [Memory Ledger](../../capability/craft-memory/memory-ledger.ts)已有 `observed_at`、`effective_from`、`valid_until`；[Context Resolution](../../core/context-resolution.ts)已有 `as_of`、`known_at`、诊断历史与当前授权重检。另有 topic 冲突、范围优先栈、衰减及证据反馈，不能再把这些整项列为缺失。

**可证实的局部不足。** Resolution 的历史路径查询全库版本，`store.get` 水合后再过滤 readable，最后才检查候选数量；当前 `listScoped` 优化未覆盖此路径。这是成本与 locality 问题，不等于已向调用者泄漏。排序的 pool 先比较 retrieval score，再比较 decay weight，因此衰减目前主要是同分排序条件，而非主分融合。是否改变衰减权重属于实验判断，不是必然 bug。

**优化候选。** 一个 Memory 读取 module 统一当前与历史候选的范围预筛、记录/事实时间、正文水合和上限，让两个调用路径共享同一 interface 与负例。衰减策略做可配置且受评测的候选，硬约束与显式必要引用不应因旧而丢失。不要引入图数据库仅为已有时间字段换存储。

### Codebase：任务词匹配之后，应优先做依赖相关的紧凑地图

**外部事实。** [Aider Repository Map](https://aider.chat/docs/repomap.html)用文件依赖图排名选择重要符号，按 token 预算生成紧凑地图，并随聊天状态调整。地图用于定位随后要读的文件，不替代源码。

**当前已实现。** [context-search.ts](../../capability/craft-codebase/context-search.ts)对 name/path 和固定中文别名打分；[repository-files.ts](../../capability/craft-codebase/repository-files.ts)按任务词优先读取文件，但仍保留 500 文件、8 MiB 合计、512 KiB 单文件上限。[Codebase Index](../../capability/craft-codebase/codebase-index.ts)已有静态 nodes/edges、TS/JS 分析及 checkpoint Adapter 导入，外部边记录 `partial`，不是无条件准确的运行时调用链。

**优化候选。** 从任务已命中位置出发，纳入 imports/callers 的有界邻域及符号定义，生成包含签名、位置、快照和省略原因的地图。用“词法命中但实际调用路径在邻近文件”“未索引区域关键符号”案例验收。现有图关系能复用；先不增加独立语义数据库。真正多语言语义分析需要实际 language server 的完整工程配置及 conformance，预检命令存在或 Adapter Schema 合法均不证明完成。

### Experience：Graph 已有；下一步是受控的改进与跨场景泛化证据

**外部事实。** [LangMem 当前 episodic 指南](https://langchain-ai.github.io/langmem/guides/extract_episodic_memories/)已给出 observation/action/result 等结构化 Episode 的抽取、存储和后续检索示例。因此旧 SDK 发布文中“尚未提供 episodic opinionated utilities”不能当作现在仍无此能力。该示例包含思维过程字段，Craft 不宜照搬隐藏推理存档。

**外部研究。** [Skill-Pro v3](https://arxiv.org/abs/2602.01869v3)，2026-05-28 修订，以激活、执行、终止条件形成可复用过程，再通过候选验证和质量维护管理它们；搜索缓存的旧标题 ProcMEM 不应覆盖当前论文标题。[Agentic Context Engineering v1](https://arxiv.org/abs/2510.04618v1)，2025-10-06，研究增量生成、反思和整理上下文，提醒反复整体重写可能丢失细节。这些是研究机制，不能据其结果预测 Craft 收益。

**当前已实现。** [Procedure Release](../../capability/craft-experience/procedure-release.ts)正式记录与最新候选分离，test 可选择候选并检查隔离工作区；Graph authoring、Entry/Exit、组合、Invocation 固定版本和验收已存在。不是需要再新增一个 workflow 框架。

**优化候选。** 利用可公开的动作、工具结果和终态证据生成“本次失败是否应修改 Graph”的建议，绑定受影响节点和旧验收，维持候选→测试→晋级。分别评价跨入口、跨仓库、跨模型/Host 的适用性；场景外拒用同样要计分。不要把成功一次的 transcript 自动升级为通用程序，不保存隐藏 chain of thought，也不让 feedback 自动修改正式版本。

## 优先顺序与非目标

| 顺序 | 目标 | 最小验收 | 依据边界 |
| --- | --- | --- | --- |
| 1 | Memory 当前/历史读取 locality | 非当前 scope 正文不提前水合；历史版本量大仍有界；旧引用当前授权合同保持 | 源码可证实成本路径；未运行性能实验 |
| 2 | Codebase 紧凑 repo map | 调用邻域定位优于仅词匹配；超预算/未分析语言明确 partial | Aider 机制已核实；Craft收益未知 |
| 3 | 真实 Host Context 使用与发现 | 无 Hook 真实会话，测初始工具定义、实际 emission、使用与终态 | 当前冷 MCP 成功不能证明模型使用 |
| 4 | Knowledge 引用支持评测 | 检索相关与结论支持分开；错误证据/片段反例拒绝 | 已有 provenance，不等于所有结论支持正确 |
| 5 | Experience 改进候选与泛化 | 失败可归因节点；隔离测试；正式版本受控晋级；场景外拒用 | 不自动改正式 Graph；不借用论文收益 |

共同验收还需记录 end-to-end 时延、检索/Schema/历史 token、成本与必要约束漏召回。当前已有执行与预检链路；缺真实 Host/模型终态样本仍是证据缺口，不应重建一套评测运行时。

本轮非目标：新增全自动记忆写入、复制第三方 agent runtime、强制 Hook、替换 SQLite、将 Experience 等同聊天历史、强制协议升级。所有建议仍应在既有 ADR 与独立 SDK 依赖合同内选择 seam。

## 当前工作区追加复核：缺陷与深化候选

本节核查当前脏工作区，不覆盖此前实现、不修改功能。临时隔离 Store 与假等待只用于复现；已清理临时数据，没有读取用户的真实 Knowledge/Memory 正文。

### 可复现缺陷

1. **P1：独立 Knowledge SDK 的等待后授权复核未集中。** `KnowledgeContribution.search`（contribution.ts:95）先过滤当前 Source/Claim，再 await 关键词排名，然后返回旧候选；直接 SDK 调用没有 Context Resolution 的栅栏。隔离用例在该等待期间将 private Claim 访问者 owner 改为 other，旧请求仍返回 1 条。Context/MCP/Working Set/Open/Hook 的 C01 已修，不能将此旁路混称为原路径未修。应将受控读取 implementation 深化，给 SDK 与 Context 共用 seam；验收需直接从公开 SDK interface 发起，并保留跨连接/跨进程撤销负例。
2. **P1：Memory approved commit 不幂等，且缺少整体事务。** `memory-governance.ts:108–121` 没有重放 candidate.ledger_memory_id；Ledger 未指定 ID 时生成随机 ID（memory-ledger.ts:57）。隔离用例同一 approved candidate 连续 remember 两次得到两个不同 ID，Ledger count=2。新 Ledger、旧条目 supersede、candidate 链接分别提交；部分提交风险来自静态调用链，尚未注入进程故障。Capture 的局部重放补偿不能证明独立 SDK 的这一 interface 完整。
3. **P2：必需 Knowledge 条目的 omitted_count 可为负。** `context-resolution.ts:333–337` 用 hit_count-selected_count；required_refs 允许无词法命中仍选入。隔离 contributor 返回一条无关材料且该引用必需，selected=1、omitted_count=-1。已有必需条目测试没有断言该计数；需用选择、命中、去重与预算矩阵验证不变量。

### 架构深化候选（尚未设计新 interface）

| 候选 | 强度 | 摩擦与 deletion test | 验收方向 |
| --- | --- | --- | --- |
| Memory 晋入/替代 module | Strong | Governance 值得保留；删除它会把重放、替代、失败一致性散给 Capture/SDK/Host。应把这些 implementation 集中。 | 顺序/并行重试只有一个 Ledger；故障注入后数据库与内容引用一致，处理已创建文件的恢复。 |
| 受控当前/历史读取 module | Strong | Guard 已集中撤销规则，不能删除；但 SDK 旁路及历史 map(get) 后 filter 使 locality 不完整。删除统一读取会把时态、访问、正文读取顺序分散。 | 无关 scope 正文不水合；公开 SDK 与 Context 共用撤销/时间/失效负例。 |
| Context Working Set depth | Strong | Host refs、K/M/E、Codebase 各自扣预算与写 Receipt；Open 还按错误文字重平衡。删除目前 Working Set 并不会删去多数选择复杂性。 | 在同一 seam 比较必要材料、代码、Host refs、Hook 已输出、预算和计数；保留 ADR-0025，不加第四个 shallow module。 |
| 仓库事实与任务视图解耦 | Worth exploring | query 排序后的 500 文件 subset 直接成为 Workspace.include_paths，可能让纯查询切换造成 Checkpoint 变化；分析仍在发布事务内。 | >500 文件交替查询、并发 Work Loop，测 Checkpoint/Index 数量、持锁时长；纯查询不应造成事实漂移。 |
| Host 装载/计量 adapter | Worth exploring | 推荐工具集合不是 Host 延迟加载，当前 Context daily 仍注册 76 工具；估计字段不等同 Host 实际注入。 | 多 Host 能力矩阵、完整注册与原生 deferred 两种真实 adapter，测初始 Schema/工具发现错误/实际材料及终态。 |
| Knowledge/Experience 价值评测 | Worth exploring | 引用存在不等于结论受支持；词面 Graph 路由不等于跨任务过程有效。现有 Runtime/Eval 值得复用。 | 分开评检索与引用支持；经验跨入口/仓库/Host 泛化和场景外拒用，不另建执行器。 |

规模注意：`ContextReadGuard` 构造时扫描七种记录的全库版本头，再对候选逐条复核；read_refs 也包含未最终选中的候选。并发正确性已增强，规模成本和失效范围尚需测量。`memoryRecords` 历史路径仍全库存头/正文，普通路径已经 listScoped。不能将此成本路径直接称为对用户泄漏。

语义注意：`memory_confirmation` 当前被写入，但没有进入 resolver 的 confirmed_at（仍取 observed_at/updated_at）或 maintenance 读取；确认记录与“延长信任/避免再次询问”的行为尚未形成闭环。确认是否应影响这些行为是产品选择，不能简单改成自动延长期限。SDK 的 topic 建议以词面及有限语言词为提示，存在误匹配/漏判；应以明示 subject 和已授权更正优先。

ADR-0016 中“Claim 仍不归属 Knowledge 包”的示例已与当前 knowledge.claims 注册、ownership 正则不一致；原则仍成立，建议更新示例/注明历史阶段。此项不是推翻 ADR。

建议先处理三个可复现缺陷，再深化 Context Working Set 与受控读取。Guard 的规模优化、Codebase repo map、Host 原生延迟加载和 Experience 泛化以真实实验决定收益。Hooks 继续可选，Skill+MCP 独立合同保持。
