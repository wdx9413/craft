# Context 与四个子能力：当前缺陷与补齐优先级

评审开始于 2026-10-08，针对当前工作区及本次已有改动；不是只看远端发行版。本文以源码、隔离复现和一手资料为依据，仅增加评审文档，没有修改功能代码。业界资料见 [一手来源研究](context-primary-sources-2026-10-08.md)。

## 判断

现有方向合理：Context 是统一入口，Knowledge/Memory/Experience 提供受治理材料，Codebase 提供快照固定的代码结构；四个包声明依赖 common-base、common-store-local、common-log，已经没有反向声明依赖 craft-agent-harness。

当前更需要把已有能力收敛成可靠的工作集与任务学习闭环，而不是继续增加子能力或堆接口。不能把“有 SDK”“召回成功”“索引 ready”“测试覆盖率高”分别等同于完整独立业务能力、模型已使用、结构完整或真实收益。

## 已证实的高优先级问题

### C01 / P0：异步召回期间的权限撤销未在返回前复核

[Context Resolution](../../core/context-resolution.ts)先检查 Memory 当前 scope/audience、Source 状态等，再等待 contributor 和检索；最终选择与返回使用预先枚举的候选，没有再次校验最新授权。

隔离复现：私有记忆初始只允许 owner；让一个 contributor 在 Promise barrier 上等待；等待期间将记忆受众改为 new-owner；恢复后请求 principal=owner 仍收到 private-memory。没有调用外部 embedding，没有读取用户实际记忆，也没有证明生产已发生泄漏。

建议：在材料外发给检索供应商前及返回给 Host 前复核最新 Source、Memory、Claim、Procedure 的访问/撤销状态；异步返回后遇到变更应重新选择或显式失败。缓存与复用绑定授权修订，不能依赖曾经通过的 Scope 检查。

验收：慢检索期间撤销 audience/tenant/source、更正或撤回 Memory、停用 Procedure，旧授权请求均不能取得材料；负例同时覆盖 warm cache 与跨进程更新。

### C02 / P0：Working Set 引用身份失真

[Working Set](../../core/context-working-set.ts)第 41–43 行以 `source_id` 优先生成 Memory 引用，贡献条目却读取 `ref_id/memory_id/id` 与 `version`，而 Knowledge/Experience 使用 `claim_id/claim_version`、`procedure_id/procedure_version`。

隔离复现：底层选择 Memory one、two 和 Claim claim-one；Working Set 只返回 `builtin.evidence-wiki@1`、`undefined@latest`。两条记忆因同 Source、同版本被误合并，知识身份丢失。这是高级 Working Set 入口的已证实缺陷，不表示默认 context_open 的 memory_refs 同样错误。

建议：统一结构化 AssetRef（member、id、record/content version、digest、scope），禁止 undefined/latest 伪引用；明确 SourceRef 与资产引用的区别，按真实资产身份去重。

验收：同来源两条同版本记忆、同记录版不同 Claim/Procedure、跨内容修订、历史读取与撤销都能准确追溯，且不得产生 undefined 引用。

### C03 / P1：代码引用参与预算过晚

[Context Open](../../core/application/use-cases/repository-context.ts)先完成 Knowledge/Memory/Experience 排序及预算，再用剩余项数和字符数选择 Codebase；代码不是统一候选池的一员。

隔离复现：同查询 alpha，max_items=1，有匹配记忆和 alpha.ts；结果选了记忆，code_refs=0，报告 codebase_budget_exhausted。partial 的报告正确，但选择策略可能使修代码任务缺少代码依据。

建议：依任务类型分配材料预算或保留必需代码位置；支持跨四个子能力的 typed required_refs。当前只对 memory_ids 提供真正的必需项失败保护，source_ids 是范围过滤，不能替代必需 Claim/Procedure/Symbol。

验收：CR、Bug 诊断、开发、纯知识任务各有已标注材料集合；预算不足时说明缺失必要材料，而不是安静地用可选记忆占满。

## Context 自身的结构缺口

| 问题 | 当前依据 | 建议与验收 |
| --- | --- | --- |
| 检索入口尚未收敛 | [ADR-0025](../adr/0025-context-working-set-is-the-retrieval-seam.md)指定 Working Set 为唯一检索 seam；Context Open 实际直调 ContextResolution，Hook 也直调 resolver。Working Set 默认入口未实化 history/state，仅标记 host_owned_members。 | 先修 C02，再统一内部工作集合同；Host 只交任务、根目录、访问身份及必要材料。history/state 保持 Host/任务拥有，避免硬塞进长期记忆。 |
| Hook 与 Skill/MCP 的复用合同不完整 | [Hook bridge](../../core/interfaces/codex-hook-bridge.ts)提供 scope、receipt_id、selected，没有代码 checkpoint；Hook 不索引代码。Context Open 不接收匹配 Hook receipt/session/turn 控制。 | 一个 task/turn 初始化接口负责匹配、升级为含索引的 pack、失效重开与去重；保留 Hookless 路径。不能靠“Hook 已安装”判断已完成初始化。 |
| 同请求不是默认幂等初始化 | 隔离重复调用同查询、同仓库，index_reused=true，但两次 receipt ID 不同；resolver 缺省生成随机 receipt ID，Context Open 不转发稳定 receipt_id。 | 按任务/轮次与授权、内容、checkpoint 形成复用键；变更即失效，不能做永久 query cache。允许审计保留不同调用事件，但不重复扫描和注入。 |
| 字符预算与真实上下文占用不一致 | [resolver](../../core/context-resolution.ts)按 Memory 正文长度计费，对 Knowledge/Experience 用序列化条目长度；工具 schema、返回 metadata/receipts 和 Host history 不在同一预算中。 | 保留内容/传输预算区分，增加模型 token 估计与最终注入计量；测真实 Host 占用，而不是声称 max_chars 就是 token 限制。 |
| 工具面仍宽 | [surface registry](../../core/interfaces/mcp/surface-registry.ts)以四个子能力日常工具集合的并集组成 Context。 | 保留高级兼容工具，但支持按当前任务动态发现和渐进装载；衡量调用错误率与 schema token 成本，再决定精简范围。 |
| 反馈难定位整包中的作用项 | [feedback](../../core/context-resolution.ts)绑定 receipt/evidence，但主要保留 memory_refs；Memory usage 加权只利用其 helpful feedback。Codebase refs 在另外的 pack_receipt。 | 将反馈归因到具体 typed ref 和它实际参与的决策；分别记录 selected/shown/used/helpful/verified outcome，错误或过期反馈进入子能力的更正流程。 |

## 四个子能力分别还缺什么

| 子能力 | 已有机制 | 主要不足与补齐 |
| --- | --- | --- |
| Knowledge | Source/Document/Claim、内容修订、Evidence、scope/audience/tenant、撤销及 reviewed-only 召回；当前文档摘要与 Source 摘要检查。 | 大量材料仍通过 Store 全量取出、正文水合和关键词排名；缺少覆盖真实来源同步、事实过期及矛盾证据的完整评测。优先作用域查询下推、来源变化/撤销同步与按片段的必要事实引用，随后再用实测比较分块、混合检索和 rerank。已有 cursor ingestion，不应描述成完全没有增量导入。 |
| Memory | 显式用户授权、Candidate→Review→Ledger、topic 冲突、scope 优先级、时间选择、到期与维护候选。 | 冲突依赖明确 topic；[用户陈述捕获](../../core/application/coordinators/cognitive-write.ts)与 Hook 未提供 topic 时，不会自动把语义相反的偏好识别为同一主题。建议有证据的主题分类候选、显式更正/替代、长期条目确认及可查看的治理待办；不得让模型猜测直接覆盖原条目。读侧以及治理/捕获/维护仍有大量逻辑在 core。 |
| Experience | 场景 Graph、命名入口/出口、版本、候选/晋级、Invocation、有界返工、独立出口验收、配对评价、graph.yml 状态视图。 | [配置保存](../../capability/craft-experience/procedure-configuration.ts)新候选会暂停旧正式版，graph.yml 不能同时表示可运行旧正式版和隔离新测试版。若产品目标要并行正式/测试，需要独立发布指针与测试环境合同，不是改 YAML 数字。还需子场景的意图/前置材料匹配、变更影响及真实跨任务收益；嵌套 Graph、任意并行写仍明确不支持。 |
| Codebase | 自动识别 Git、ignore/排除/退出控制、checkpoint、内容摘要、增量符号缓存、TS/JS 语义分析与外部分析导入。 | [文件选择](../../capability/craft-codebase/repository-files.ts)按路径排序限 500 文件、8 MiB 总量、单文件 512 KiB；[基础分析](../../capability/craft-codebase/basic-analysis.ts)每文件最多 16 个节点、正则声明、无关系边。Context 中文任务只用整句或最多六个英文词查符号。优先任务相关文件排序、路径/关键词/符号/关系组合检索；Python/Java/Go 等语义 Adapter 要分别验收，不能用“读到文件”称全语言调用分析。 |

## 依赖包的判断

包依赖方向已基本正确，保留 `craft-common-log`、`craft-common-store-local`、`craft-common-base`。问题在“接口闭环”尚未完全移到各子能力。

- Memory 包的 Ledger/Signals 已独立，但 [MemoryGovernance](../../core/memory-governance.ts)、捕获、维护和 resolver 在 core；直接用 SDK kernel 不能自动等同于经过同意及冲突治理的完整路径。
- Knowledge 的 Claim 写入/审核协调在 [CraftService](../../core/application/craft-service.ts)，包里 Source/Contribution 的独立性不能证明所有知识操作都是独立闭环。
- CodebaseIndex 在子包，仓库 ensure 仍依赖 core 的 Workspace/checkpoint/service 协调。
- Experience 的资产管理已经有独立 SDK；Invocation/实际 Host 运行在 core 是合理分工，应抽象受治理的执行合同，避免把执行器复制到子包。
- [CraftStore.list](../../common/craft-common-store-local/src/store.ts)带 predicate 时仍读全量最新记录并先水合正文，再 JS 过滤和截断；Context 长期数据增长会增加 CPU/I/O 和 SQLite 竞争。仓库 ensure 在写事务中同步枚举、读文件、分析；重复索引复用也先进行扫描及 Workspace 保存。应测并发和数据规模，再下推范围查询、缓存失效、后台索引，不能宣称已有这些性能改造。

## 业界借鉴与真实评测

[Anthropic 的 Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)强调有限 token 资源、减少重叠工具、按需加载以及长期任务的压缩与结构化笔记。这支持工作集生命周期与渐进发现，不能证明 Craft 应把所有对话长期保存。

[LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)提供状态检查点与恢复机制。可借鉴精确版本/状态绑定，但 replay 不是外部副作用撤销，也不是可复用成功经验。其他来源及不宜照搬处见一手研究。

[Anthropic 的 agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)区分真实环境终态与 Agent 成功陈述。Craft 已有 [消融实验准备器](../../scripts/eval/component-ablation.ts)和实际回执评价合同；缺口是可复核的真实 Host/模型实验结果，而不是完全没有评测工具。应比较无 Context、当前 Context、候选策略，并控制输入、代码快照、模型、Host、初始记忆、工具与预算；测任务成功、错误注入、必要事实漏召回、时间和成本。

[检索评价](../../core/retrieval-evaluation.ts)先按 scope 切分 supplied corpus，再计算返回 ID 是否属于 corpus。因此该 leak_count 不能替代组合后 Context 的真实 Source/audience/tenant/revocation 负例；C01 正是纯检索评价之外的漏检情形。

MCP 支持边界保持诚实：[代码](../../core/distribution-and-first-run.ts)明确支持三个 2025 修订，对 2026 修订为 assessed_deferred；[官方源码](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/versioning.mdx)有新旧协议机制差异。暂缓迁移不是已证实的 Host 失败；验收按真实 Host 的协议和 transport 分支，不能泛化 initialize 或立即强制升级。

## 建议顺序

1. P0：C01 返回前授权复核；C02 结构化引用及唯一工作集合同。先补相应负例，再修实现。
2. P1：任务预算与跨能力必需材料；Hook/Skill/MCP 初始化复用与失效；中文代码检索；作用域 SQL 查询和索引扫描成本。
3. P1：完整单能力治理接口、具体材料反馈归因；是否保持正式/测试双版本由产品合同明确，再实现路由和隔离。
4. P1/P2：真实 Host 配对/消融评测和语言 Adapter 矩阵；效果未证明前不做自动晋级或无人值守发布。

## 本轮证据边界

- 25 项相关已有回归通过；它们没有覆盖本轮新发现的两项反例，不能用通过率否定缺陷。
- 三组隔离脚本复现：Working Set 错引用、代码预算被占满和同请求新 receipt、异步访问权限撤销仍返回旧材料。临时数据已清理，没有修改用户实际知识/记忆/经验。
- 当前仓库实际 Context Open 返回 partial：索引 omitted_files=211、omitted_symbols=12283，且有预算/查询截断。该数字属于本次快照和预算，不是固定产品规模。
- 没有运行真实模型收益实验、真实多 Host 完整业务流程或生产部署；本轮只增加文档。
