# Experience / Codebase 业界对照

调研日期：2026-09-28。范围是当前工作区源码和官方文档，不是性能横评；本轮只研究，不改实现。对照目标是可迁移到多种编程 Host 的受约束能力，不要求 Craft 复制一个完整 Temporal 或 IDE。

## 结论

Experience 已有实际调用账本，不能继续描述为“只有计划、没有执行闭环”。它具备父子出口验收、输入和状态证据绑定、幂等回执及重启恢复；但目前是串行 Host 驱动的执行协调。最值得补的是非成功状态及可恢复交互语义、真实执行来源验证、规模化评估，而不是先画一个 Graph 编辑器。

Codebase 的 checkpoint 固定、显式激活、摘要与范围校验是优势；当前内建分析仍是 TS/JS 正则启发式。多语言入口已经有，完整多语言语义索引尚未有。LSP DocumentSymbol 转换支持任意语言标签，但产物是符号列表，`edges: []`，不能据此声称 Java/Python/Go 调用图已经可用。

## Experience：已经具备的基础

- Procedure 的 Entry/Exit/Route/Call 会校验输入输出、子定义版本和摘要、作用域、副作用、递归深度及步数。[组合编译器](../../capability/craft-experience/procedure-composition.ts)
- Invocation 已绑定 VerifiedWorkLoop，事务内更新派发、验收及回执；恢复对未回执派发返回 `reconcile_dispatch`，不盲目重放。前置证据校验调用路径、任务、输入摘要、快照、状态修订与 TTL。[调用内核](../../core/application/procedure-invocation.ts)
- 调用效果可按 Entry/Exit、输入、初始状态、Host、模型和预算配对；外部回执明确标为 `host_attested`，不自动晋级。[evaluate/report](../../core/application/procedure-invocation.ts)

## Experience：还缺什么

| 优先级 | 已确认的差距 | 影响与最小补齐方向 |
| --- | --- | --- |
| P0 | `report` 接受 observation 的 `passed/failed/blocked/inconclusive`，最终却用 passed 布尔值把后三种都写为 failed；session.cancelled 也汇入失败。`current` 又拒绝终态 resume | 暂时缺依赖、验收证据不足和真正失败被混同；保留原 verdict/cancellation，建立可恢复阻塞、补证、取消的显式转换和出口政策。源码位置：report 149–197、current 253–258 |
| P1 | `failure_disposition` 被编译和存储，但 Invocation 没有据此调度重试、交接或补偿；`resume` 的未知派发恢复停在提示 reconcile | 定义“谁核实目标状态、怎样生成核实回执、允许重试什么”，优先增加 bounded retry 与人工补充输入，不做通用自动补偿执行器。源码位置：组合编译器 156、Invocation 201–207 |
| P1 | bind 的 `previous` 在整个递归降低过程中只形成一条链；DurableActionLoop 有 pending action 时不再派发另一个 | 父子流程复用可用；并行 Review、并行测试等需要 fan-out/join、取消传播、资源预算及输出合并合同。不能只加一个 parallel 字段。源码位置：Invocation 49–75、[DurableActionLoop.next](../../core/durable-action-loop.ts) |
| P1 | `expected_version`、快照和回执保证账本一致性，但真实动作在 Host 外部执行，回执与 Evidence 仍属 host_attested | 增加受信任适配器/CI 观察者来源、与真实工具回执关联、断线后的目标侧核对；不能把摘要绑定当作独立证据或 exactly-once 外部执行保证。源码位置：Invocation 117–124、143–185 |
| P1 | evaluate 限 3–5 对且只返回通过率与原始耗时/指标 | 可做冒烟比较，不能证明普遍收益；增加任务集版本、失败类型、保留集、跨 Host 分层和不确定性。缺失测量继续显示 unavailable，不自动晋级。源码位置：Invocation 219–236 |

LangGraph 的 Graph API 支持条件路由、并行 super-step 和共享状态合并；其 interrupt 使用持久线程恢复外部输入，恢复时当前 node 从头再执行，因此副作用仍需幂等约束。这些是控制流语义，不是单纯多一个图形表现。[Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api)、[Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

LangGraph 子图区别单次调用隔离、跨 thread 累积和无状态模式；Craft 当前按 call_path 隔离接近单次调用模式，应保留这种默认，避免复用流程时把上次执行状态误带进新需求。[Subgraphs](https://docs.langchain.com/oss/python/langgraph/use-subgraphs)

Temporal 用事件历史校验 Replay 产生的 Commands，并通过专门 awaitable 管理 Activity、子流程、信号、计时器等。Craft 的可恢复账本不是同一种确定性执行引擎；目前没有必要为研发流程补齐全部 Temporal 能力，但长时间等待、取消和恢复协议值得借鉴。[Workflow Execution](https://docs.temporal.io/workflow-execution)

## 粗粒度 workflow 与 Graph 的边界

多入口、多出口、子流程并不自动要求一个通用 Graph。当前选择入口及目标出口后得到固定 Route，很适合“只做 CR”“完整需求研发”这种不同深度的业务流程。

运行过程中根据测试结果改走另一条路径、并行分支汇合、有界回环或人工恢复，才需要明确的运行时 Graph 语义。仓库已有 [GraphCompiler](../../core/graph-compiler.ts) 和 Graph 校验，它们识别 retry、human_gate、compensation 并生成计划；但编译成功明确不代表 Host 已执行。下一步应把需要的少量 Graph 语义接入既有执行层，避免建立第二套生命周期。

## Codebase：与 SCIP 精确导航的差距

Sourcegraph 官方区分搜索式导航和 SCIP 精确导航，优先精确结果并降级搜索；提供 Go、TS/JS、Java/Kotlin/Scala、Python 等语言索引器，并建议复杂构建复用 CI 环境生成索引。这给 Craft 的启发是接入成熟语言分析器，保留自己的 checkpoint 和授权合同。[Precise Code Navigation](https://sourcegraph.com/docs/code-navigation/precise-code-navigation)

SCIP 的源格式能表示 occurrence、外部符号、引用/实现/类型定义等关系。Craft 当前标准化格式仅接受 file/symbol 节点和 imports/calls 边，不能无损容纳上述关系。[SCIP schema](https://github.com/scip-code/scip/blob/main/scip.proto)、[importAnalysis](../../capability/craft-codebase/codebase-index.ts)

| 优先级 | 当前实现与缺口 | 最小充分改进与验收 |
| --- | --- | --- |
| P0 | 内建 `builtin-regex-static-v1` 只扫描 TS/JS。声明与调用按名称匹配，没有词法作用域/类型绑定；调用来源是 file node。注释、字符串、同名局部变量、方法接收者、import alias 都存在误判或遗漏风险 | 先接 TS compiler / SCIP 或成熟 LSP 的 definitions/references/callHierarchy；用同名/别名/重载/跨文件/注释负例衡量 precision/recall。保留 heuristic/partial 降级 |
| P1 | LSP adapter 只把 DocumentSymbol 规范化为节点，明确返回空边；测试只验证 Java/Python/Go 标签及范围转换 | 接真实语言 server/SCIP indexer，生成关系边并验收真实项目；不能用“测试里文件后缀是 java”代替 Java 分析器验收 |
| P1 | build 对选定 checkpoint 的全部支持文件重新读取与建图，未缓存文件级解析结果；整个 nodes/edges 存于一个 record，查询时数组扫描 | 按内容摘要+分析器版本缓存，依赖变化失效；大仓再做分片与查询索引。验收全量/增量等价、删除/重命名/配置变更、构建耗时和内存 |
| P1 | import 限 2 MiB、10,000 nodes、20,000 edges；多语言完整仓库会较快触及上限。所有边端点必须在同一导入内且所有节点属于本 checkpoint | 提供有界分页/分片导入事务，按需要增加 package/repo/version 外部符号；不能直接去掉保护上限 |
| P1 | impact 以 imports/calls 边双向广度扩展，只是邻域候选；没有类型/数据流、测试覆盖或运行证据 | 区分 inbound callers、outbound dependencies、test relevance；保留 candidate_only，禁止用空结果证明无影响 |
| P2 | context_slice 只给 path/span/digest，不给源码；findSymbol 只做名字匹配，没有自然语言语义检索 | 这是内容最小化边界，非必然缺陷。先实测 Host 在符号定位+文件读取中的成本，再决定是否需要受限片段或语义搜索 |

本地依据：[索引模块](../../capability/craft-codebase/codebase-index.ts) 的 7–8、101–177、181–215、237–272 行；[LSP adapter](../../capability/craft-codebase/lsp-adapter.ts)；[LSP 测试](../../tests/codebase-lsp-adapter.test.ts)；[能力归属](../../capability/craft-codebase/ownership.ts)。当前 Codebase 是一个 Workspace checkpoint 的可重建静态视图，跨仓分析应通过显式 federated 查询扩大范围，不应偷偷扩大现有 Workspace 授权。

## 取舍及未验证项

1. 优先解决 Experience 状态语义和 Codebase 语义精度；它们会直接影响错误处理和开发决策。
2. 再把一条真实研发路径和两种主要语言端到端跑通，加入故障注入、断线恢复和真实项目检索集。无需等待所有 Host 都齐全。
3. 当前没有运行性能横评或对源码问题做测试复现；上述实现判断来自明确代码路径。真实多 Host 成功率仍须实验，不引用前轮单测覆盖率作为业界能力优越性证据。
4. 本次不使用旧 Cursor 索引网页作为当前产品合同：搜索结果同时出现旧 embedding/Merkle 描述及较新的 Instant Grep 方向变化，未能建立一致的当日官方能力基线。Codebase 对照以公开 SCIP schema 和 Sourcegraph 当前文档为准。
