# Craft 四个子能力：业界对照与补齐顺序

核查日期：2026-09-28。假设：Craft 的目标是跨编程 Host 使用的 Skill + MCP 能力层，Hook 可选；不是再做一个完整 IDE 或通用工作流平台。本轮只研究，未修改产品实现、部署或安装状态。

证据分为官方能力合同、当前源码、隔离运行三类。未实际运行外部产品横评，因此不提供排名或性能领先结论。详细来源和代码定位见 [Knowledge / Memory](industry-knowledge-memory-2026-09-28.md) 与 [Experience / Codebase](industry-experience-codebase-2026-09-28.md)。

## 判断

目前的主要差距已经是默认调用路径、语义精度和真实使用收益。Craft 的作用域、证据、版本、撤销、审批及回执边界已有较多实现，下一阶段应让它们承载更好的召回、记忆维护和真实研发执行，而非继续仅增加对象、工具或门禁。

| 子能力 | 已具备，应该保留 | 对照与确认的不足 | 对用户的影响 |
| --- | --- | --- | --- |
| Knowledge | 来源信任、revision、Evidence、候选审核、stale 和独立 BM25 索引 | 默认 governed Claim 查询仍是关键词重叠，未接入独立 BM25/向量重排；文本固定字符切片，整源 revision 失效，文件上限无续传信息 | 换一种问法可能找不到；只修改一份资料可能导致其他已审核内容也失效 |
| Memory | scoped ledger、TTL、替代/撤销、冲突弃答、真实向量请求及 hybrid | history_view 被前置 active/TTL 过滤；向量缓存仅进程内、全候选计算；usage/decay 未进入默认排序，整理仍依赖 Host 推进 | 查不全历史；库增长后的成本未受充分控制；记得更多不等于用得更准 |
| Experience | 多入口/出口、固定版本子流程、Invocation、幂等回执、未知派发恢复 | blocked/inconclusive/取消折叠为 failed；失败策略未接到执行；目前串行 Host 驱动，可信执行来源与收益验证仍需补齐 | 等待依赖会变成终态失败；并行、补证后恢复不能靠图定义自动获得 |
| Codebase | checkpoint 固定、显式激活、摘要校验、外部分析导入 | 内建 TS/JS 正则分析；LSP adapter 只有 DocumentSymbol 节点、无关系边；全量建图与单 record 存储 | 同名/别名/方法调用容易误判；Java/Python/Go 标签支持不等于调用关系支持 |

Knowledge 的摄取对照 [LlamaIndex ingestion](https://developers.llamaindex.ai/python/framework-api-reference/ingestion/) 的文档级缓存、upsert/delete；Memory 对照 [Mem0 检索](https://docs.mem0.ai/core-concepts/memory-operations/search)、[Zep 时间事实](https://help.getzep.com/facts) 和 [Letta 整理流程](https://docs.letta.com/configuration/memory)。这些项目的可配置能力、托管能力及 OSS 能力不能合并成默认产品能力。

Experience 对照 [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) 的持久暂停与外部输入恢复；Codebase 对照 [Sourcegraph 精确导航](https://sourcegraph.com/docs/code-navigation/precise-code-navigation) 和 [SCIP schema](https://github.com/scip-code/scip/blob/main/scip.proto) 的语言语义索引。建议接成熟分析器，不自行扩展正则模拟编译器。

## 三个应先修的具体问题

### 1. 混合 Context 按成员顺序分配预算

[ContextResolutionKernel](../../core/context-resolution.ts) 先让 Memory 使用预算，再给 Knowledge/Experience 剩余额度。隔离临时数据库中，query=`alpha beta gamma`、`max_items=1` 时，仅命中 alpha 的 Memory 占满槽位，三词全命中的 reviewed Knowledge 被遗漏；knowledge-only 则可以取到。

这证明返回受成员顺序支配，不证明任意 Memory 都不该优先。需要显式区分 required/pinned 内容与一般候选，统一选材或保留可解释的成员配额，不能直接比较不同检索器未校准的原始分数。

验收：同一标注集下单成员和混合读取均可解释；关键事实不会被低相关条目静默挤掉；回执包含预算遗漏原因。先复用真实 BM25 和现有 embedding 能力进入默认路径，再决定是否引入新检索依赖。

### 2. history_view 不是真正的历史读取

隔离构造 current、superseded、revoked、expired 四条记录，`history_view:true` 只返回 current。预筛发生在历史选择之前，故问题不是缺少历史参数，而是参数语义没有贯彻。

验收：明确 current/history/as_of 的合同，分别验证业务有效时间与系统获知时间；历史结果仍受 scope/权限约束，且不成为当前执行授权。完整探针及输出见 [专项报告](industry-knowledge-memory-2026-09-28.md#两项隔离复现)。本轮使用临时合成数据，未读取真实 Ledger。

### 3. Invocation 非成功状态丢失

[ProcedureInvocationKernel.report](../../core/application/procedure-invocation.ts) 接收四态 observation，却用一个 passed 布尔值决定 receipt、outcome 和 lifecycle。blocked/inconclusive 及 Host 取消均落为 failed，随后 current 拒绝终态恢复。此项由源码确认，未另跑行为复现。

验收：分别保留失败、阻塞、证据不足和取消；定义哪些状态可补证/恢复、哪些必须重新规划；每次恢复重验版本、授权与状态摘要，继续保留未知派发不可盲目重放的边界。

## 共同不足：有评测框架，尚缺收益证据

[eval-suite](../../core/eval-suite.ts) 明确区分 capability/safety/value，value 当前没有用例。Invocation 的 3–5 对比较可作为冒烟信号，不能证明跨任务普遍提升。[retrievalEvaluate](../../core/context-resolution.ts) 当前接收调用方报出的指标，没有在该路径绑定数据集、语料摘要及逐条检索结果；因此 eligible 不能代替实际召回达标证明。

需要复用已有评测基础，将不使用 Craft、单独启用各组件、组合启用作配对实验，固定 Host、模型、预算和仓库 revision。先选 20–30 个代表任务作为起步建议，并非行业统一样本标准；保留测试集并记录重复试验及不确定性。

- Knowledge：同义问法、中文和代码符号、来源更新/删除、召回与引用正确性。
- Memory：跨会话复用、偏好变更、历史问题、冲突弃答及 scope 泄漏。
- Experience：完整需求与独立 Review，阻塞、取消、断线、重复回执及补证恢复。
- Codebase：同名、别名、跨文件、类型/方法关系、删除/重命名及真实 Java/Python 项目。
- 整体：实际任务通过率、错误修改、用户纠正次数、耗时、token 和成本；不把模型宣称完成当作最终环境状态。

这是 [Anthropic Agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) 所强调的实际 outcome 与执行轨迹之别。覆盖率只能回答被测代码是否执行，不能证明技能被正确触发、召回正确或用户任务更容易完成。

## 跨编程工具接入：继续以 Skill + MCP 为主

[Agent Skills](https://agentskills.io/specification) 定义渐进加载的说明格式；[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) 定义可发现、可调用的工具，工具选择由模型/Host 控制。两者都不保证在所有 Host 上每轮、每个动作都触发。

因此无需强制 Hook，但应公开两级合同：

1. 标准模式：Skill 指导显式调用 MCP；任务开始、重要 checkpoint、任务结束的操作能独立完成。
2. 增强模式：Host 生命周期集成提供自动时机与事件捕获；Hook 是可选实现。MCP 自身入口可以强制自身门禁，但不能拦截所有外部 Host 操作。

[component-readiness](../../core/component-readiness.ts) 已检查版本与工具名，仍应补加载产物、工具 schema 及能力清单指纹，识别同版本不同构建。每个 Host 都必须从 initialize、tools/list 到真实业务调用验收，安装成功不等于当前会话已可用。

本轮现场：Memory resolve 可调用，但无 canonical scope 时返回 `scope_unavailable`；Knowledge 曾出现已声明却 TypeError 不可调用，Experience 未暴露。均不能解释为空资料库，也不足以判定整个发行包坏掉。需区分当前会话工具挂载和源码实现。

还存在文档漂移：[Codebase 模块说明](../technical/modules/craft-codebase.md) 仍描述旧 full-only 边界，而 [MCP surface](../../core/interfaces/mcp/surface-registry.ts) 和独立产品已变化。后续改进应把文档、Skill、schema、安装包和 Host 验收共同更新。

## 推荐交付顺序

| 批次 | 交付 | 完成证据 |
| --- | --- | --- |
| 第一批：正确性 | Context 选材与默认检索贯通、history 契约、Invocation 四态与取消语义、检索评估证据绑定 | 上述反例回归；评测报告可追溯到固定数据与真实结果 |
| 第二批：实际能力 | TS 加 Java/Python 中一门真实语义索引；一条来源文档级增量链路；有界持久检索；跨会话记忆整理 | 真实项目 precision/recall；单文档变更不影响无关文档；冷启动和大数据集成本；新会话复用成功 |
| 第三批：可靠使用 | Host 对账和有界恢复、所需的分支/并行语义、指纹握手与跨 Host 兼容矩阵 | 故障注入、目标侧核实、真实 Host 完整流程；收益对照可复跑 |

多入口、多出口、子 workflow 已适合承接粗粒度研发流程。只有运行中条件分支、并行汇合、回环等需要额外 Graph 运行语义；仓库已有 GraphCompiler，应复用。当前不优先引入通用图编辑器、完整 Temporal 执行引擎、全量知识图谱或大量尚无真实来源的连接器。

## 本轮验证边界

完成官方资料核对、源码调用链检查、两项隔离探针、文档本地链接与 diff 检查。未运行外部产品性能横评、全量产品测试、真实多 Host 任务集、远程部署或生产接入。新增研究文档不改变前轮实现状态。
