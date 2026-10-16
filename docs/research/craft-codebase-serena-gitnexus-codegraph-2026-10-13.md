# Craft Codebase 与 Serena、GitNexus、CodeGraph 能力对比

调研日期：2026-10-13；实现与复核：2026-10-14
范围：Craft 当前源码和本机仓库索引结果，对照各项目公开的官方文档与仓库说明。竞品功能/性能声明不当作独立验证结果；文末补记后续实现与测试状态。

## 结论

Craft Codebase **尚未达到这三个工具在代码智能上的功能广度**。不过它们的产品目标并不完全相同：Serena 面向 IDE/LSP 符号语义和代码编辑；GitNexus 面向预计算关系图、执行流与影响分析；CodeGraph 面向多语言持久图索引、混合检索和 IDE/MCP 接入。Craft 更强调索引快照、证据来源、只读边界和预算控制。因此，Craft 在治理与可追溯方面有明确优势，但不能据此推断其结构分析能力已经同等成熟。

## 能力对照

| 维度 | Craft Codebase 当前实现 | Serena | GitNexus | CodeGraph |
|---|---|---|---|---|
| 主要定位 | 为 Craft Context 提供只读、快照绑定的代码结构材料 | LSP/JetBrains 后端提供符号检索、引用、诊断和重构操作 | 解析仓库并构建可查询关系图，侧重调用链、流程和影响分析 | 多语言代码图、符号/关系查询、混合检索及 IDE/MCP 接入 |
| 结构与语义 | Basic 分析主要抽取有限符号，不分析关系；semantic TS/JS 使用 TypeScript checker，Python 使用 stdlib AST（Jedi 可选增强）；其他语言可接外部 LSP adapter，但结果标记为 adapter-reported/partial | LSP 或 JetBrains 提供定义、引用、实现、类型等语义查询；能力取决于后端和语言服务器 | Tree-sitter 结构解析并解析导入、调用、聚类和 process；不同语言分析深度有差异 | Tree-sitter 解析多语言符号和关系，提供图查询与影响分析；功能范围以项目文档声明为准 |
| 搜索与工作流 | 结构查询和 Context 投影；没有覆盖竞品所宣传的通用混合语义搜索、process 图工作流 | 符号级查询和编辑工具；不是以预计算仓库知识图为中心 | 预计算 process/调用路径、impact、hybrid search，并提供 Agent 集成 | 声称支持 BM25/向量等检索、影响分析及跨项目能力 |
| 编辑能力 | 明确只读，不执行代码，也不提供符号重构 | 支持符号重命名、移动、插入/替换等编辑工具 | 主要是仓库图查询与 Agent 工作流，不以符号编辑为核心 | 提供 IDE 插件/MCP 交互；是否编辑取决于 Agent/IDE，不应与索引引擎混为一谈 |
| 索引与更新 | 每仓库自动建立有界 basic 索引；checkpoint 固定；关系查询需要 ready semantic index；有文件数、字符数、节点数、边数上限 | 以语言服务器和项目工作流为中心；项目激活/onboarding 仍是其工作流的一部分 | 支持 watcher 刷新；其 README 将更细粒度的“只重索引变更文件”列为后续计划，不能把 watcher 等同于完全增量解析 | 声称按文件内容哈希增量索引，并将图和 embedding 持久化 |
| Host 接入 | Craft MCP/Skill/插件入口可提供代码结构工具；结果附带来源、快照与回执，可被 Context 组合 | MCP，可经 stdio 或 HTTP 接入多个 Agent/IDE | MCP、CLI、多个 Agent 配置及部分 Hook/Skill 集成 | MCP、VS Code 扩展和 JetBrains 插件 |
| 证据与安全边界 | 快照 digest、引用位置、索引回执；外部 adapter 关系不冒充本地验证；只读、预算受限 | 信任项目/忽略配置与语言后端；能力依赖外部 LSP/IDE 运行环境 | 本地索引与可选远端部署；远程服务要考虑 token 和仓库数据访问边界 | 本地引擎/索引持久化；需注意安装引擎、模型与本地数据的配置和生命周期 |

竞品资料： [Serena README](https://github.com/oraios/serena)、[Serena 工作流文档](https://oraios.github.io/serena/02-usage/040_workflow.html)、[GitNexus 原作者仓库](https://github.com/abhigyanpatwari/GitNexus)、[GitNexus 架构文档](https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md)、[CodeGraph 官方仓库](https://github.com/codegraph-ai/CodeGraph)。CodeGraph 的“38 种语言”、性能数据和工具数是其维护者声明；GitNexus 的语言分析深度与 roadmap 也应按其实际实现逐项核验，不能直接作为精度证明。

2026-10-14 对官方页面复核后，差距判断仍成立：Serena README 已标注 v2 的 REPL agent interface，并声明其 LSP 后端覆盖 40 多种语言，同时提供符号检索、引用、实现查询与符号重命名；GitNexus 1.6.8 changelog 包含可选 PDG/CFG、跨过程 slicing、taint 与 mutation-oracle 验证，以及多分支索引和最短调用路径工具；CodeGraph 工具指南包含全量/增量重索引、文件级索引与目录导入，并文档化了部分语言的控制流和数据流工具。它们的公开功能面明显超出 Craft 目前的自动语言分析与静态影响查询；这些页面是维护者资料，不构成独立精度或性能验证。[Serena README](https://github.com/oraios/serena#programming-language-support--semantic-analysis-capabilities)、[GitNexus 1.6.8 changelog](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/CHANGELOG.md)、[CodeGraph tool-calling guide](https://github.com/codegraph-ai/CodeGraph/blob/main/docs/tool-calling-guide.md)。

本次更新重新核对官方仓库截至 2026-10-13 可见的实现：Serena README 明确列出层级符号检索、引用、实现查找以及依赖后端的符号重命名；GitNexus 1.6.8 changelog 列出可选 PDG/程序切片、数据/控制依赖和 mutation-oracle 验证；CodeGraph 工具调用指南列出 workspace 全量/增量重索引与目录 watcher。这些是项目公开的功能面，不代表统一 benchmark 已验证精度。[Serena 功能表](https://github.com/oraios/serena/blob/main/README.md)、[GitNexus changelog](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/CHANGELOG.md)、[CodeGraph 工具调用指南](https://github.com/codegraph-ai/CodeGraph/blob/main/docs/tool-calling-guide.md)

## Craft 本机验证

在 2026-10-13 对 Craft 仓库调用 `craft_codebase_repository_ensure`：

- Basic 索引返回 `ready`，但结果为 `partial`：报告 457 个受支持文件、43 个不支持文件、260 个省略文件；分析器报告已分析 54 个文件、复用 446 个文件，并省略 11,499 个符号，关系标记为 `not_analyzed`。这些是本次接口回执中的原始计数；由于计数口径不同，不应将其相加或推导成完整覆盖率。
- 最初及本轮活动 Context MCP 对同一仓库请求 semantic 索引失败，错误为 `TypeScript graph exceeds import budget`，外层状态为 `INTERNAL_ERROR` / `dispatch`。当前工作树及新构建的 `craft-context` / `craft-codebase` DSH MCP 已通过 >10,000 节点、>20,000 边的语义索引 smoke；插件包完整性、版本一致性与组件 MCP initialize/tools-list/tools-call smoke 也通过。安装缓存中的 0.12.42 bundle 仍含旧 10,000/20,000 硬限制，实际桌面 Host 尚未加载修复后的 bundle；因此本轮确认这是分发接入滞后，而不是当前源码的图容量错误。未改写用户安装缓存。
- 调研初始快照中的 semantic TS/JS 分析受 10,000 节点、20,000 边硬限制；超限会失败。后续实现已将这条失败路径改为有界 partial graph 和更高的导入/持久化预算，旧桌面安装缓存仍保留历史限制。当前没有足够的跨仓库同任务集召回率、调用边精确率、索引耗时/内存基准，无法量化与竞品的准确率差距。

### 本轮修复后的状态

最初修复预算失败时，TS/JS 分析器先保留所有必要文件节点，再在当时的 10,000 节点、20,000 边和 1,800,000 字符预算内构建确定性部分图；超限返回可导入图和省略诊断。Python 同期接入 semantic onboarding，并与 TS/JS 统一合并、应用节点/边/字符预算。之后本轮已将索引上限、持久分片与节点/邻接路由扩展，见下方最新数据。Java/Go/Rust 自动语义分析、增量建图和准确率基准仍未解决。

2026-10-13 最新本机 semantic 冷索引重复测量：Craft 仓库有界纳入 500 个文件，建出 33,872 个节点、140,610 条边，写入 61 个图分片、256 个路由分片，路由序列化约 13.6 MB；索引用时约 46.3 秒。随后一次复测为 33,872 个节点、140,610 条边，耗时 37.5 秒。目标 `ensureRepository` 的符号查找、调用者查询、两层影响查询分别约 1,429 ms、319 ms、2,064 ms；影响查询返回 27 个节点、40 条边。相较此前单次测量，调用者查询通过直接按节点路由读取从约 1,007 ms 降至约 314 ms；符号搜索和影响分析仍慢，须继续优化。索引状态为 `ready`，分析置信度仍为 `partial`，且虽有 500 文件纳入但摘要不列省略项；这些数值只能代表该仓库和本机运行，不能推断完整覆盖或竞品差距。

新的 Codebase 索引记录仅保存图摘要、计数和有序分片清单；分片与节点/邻接路由在单一 Store 事务中创建，路由单条限制 4 MiB、总量限制 32 MiB。每个图分片、路由分片和主清单都有摘要校验；已知节点的关系、context-slice 和 impact 查询按路由读取节点分片，并在单次查询内缓存路由和节点分片；符号查找仍须扫描节点分片。测试覆盖跨分片符号/调用者/impact/context 查询、定向 shard 读取、篡改拒绝，以及旧版内嵌 `nodes`/`edges` 索引读取。Python AST 行偏移改为预计算 UTF-16 行前缀，6 万定义的显式预算回归测试从此前约 49 秒降至约 1.3 秒。仍需改进真实仓库更新时的增量建图、多语言语义深度、PDG/流程分析与 precision/recall 基准；这不证明已达到 Serena/GitNexus/CodeGraph。

后续复核发现 Source→Host 打包断层：`dist/plugin/craft-mcp.cjs` 已包含新图预算，但生成的 `dist/adapters/dsh/*/runtime/craft-mcp.cjs` 仍含 10,000 节点/20,000 边的旧硬限制；当前活动 Craft Context MCP 也返回了同一错误。重新运行 `pack-adapters.ts` 后，新增 DSH smoke 分别启动 Craft Codebase 和 Craft Context MCP，以 10,001 个 target/caller 对（超过 10,000 个节点和 20,000 条关系）做 semantic onboarding，并从 status 回执验证索引尺寸；两个本地生成的 DSH 包均通过。该验证证明本地 DSH 产物已修正，但没有证明活动桌面插件已经切换到新产物；活动 Host 的确切加载路径和更新后行为仍待验证。

另为可导入关系增加了 `craft_codebase_relations_find`，使 Agent 能按方向查询 calls/imports/references/implements/type_definition，并保留 adapter provenance/confidence、查询回执和截断计数。MCP 端到端关系测试通过；TS/JS checker 已新增 snapshot-bound 的 references、implements 和 type_definition 边，有已解析与未知类型的用例。其他语言仍须由 adapter 提供这些关系；这不等于所有语言已具备 Serena 级语义精度。

本轮扩展显式 stdio LSP 客户端和 `scripts/codebase/analyze-lsp.ts`：除 JSON-RPC initialize、didOpen、documentSymbol 外，按服务器 capability 可显式请求 references、definition、incoming call hierarchy、implementation、typeDefinition 和 Type Hierarchy；位置可为 LSP `Location` 或 `LocationLink`，层级端点通过 URI、selectionRange 和 checkpoint 的 DocumentSymbol 精确绑定。definitions 先请求 references（includeDeclaration），再对每符号最多 20 个、全请求最多 500 个快照内引用位置请求 definition，并跨符号去重，边的源码范围对应引用 token；本机 clangd 15 两文件 C++ fixture 验证 `Child : Base` 的 Base token 能跨文件查到 Base 定义，同时正确丢弃析构函数声明的伪边。另有超全局上限夹具验证保留 500 个候选并将剩余 20 项标为 partial。`implementations` 映射为 `implements`，`type_definitions` 映射为 `type_definition`，超/子类型映射为有方向的 `extends` 边；请求失败、响应畸形、超预算和快照外位置分别保留失败/省略阶段。新增 `craft_codebase_definition_find`，可在已导入图上按路径和 UTF-16 offset 查找已有关系目标，并使用按源码位置路由只读相关边分片；这是静态候选查询，不启动 LSP，也不保证空结果代表无定义。fake-server→analysis_import→symbol_find/relations_find/definition_find 闭环及真实 clangd 定义/层级查询通过。LSP 客户端和关系 collector 增量行/分支/函数覆盖已达 100%。本机验证仍只覆盖 C++ 小型 fixture，不代表其他服务器或大仓 precision/recall。验收时发现 `/tmp` 符号链接导致 clangd 返回的 canonical file URI 无法映射到词法 checkpoint 路径；客户端现在在启动前解析 checkpoint 根路径。协议依据为 LSP 3.18 [implementation](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.18/language/implementation.md)、[typeDefinition](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.18/language/typeDefinition.md)、[typeHierarchy](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.18/language/typeHierarchy.md) 和 [definition](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.18/language/definition.md)。客户端不由自动 onboarding 静默启动，Java/Go、多语言大仓精度、调用图准确率与跨仓库覆盖率仍未验证。它仍不等同 Serena 的完整语义服务，也没有 GitNexus 的 process/PDG 能力。

随后将 Codebase 符号查找与 Context 候选统一到共享 BM25：索引字段包含符号名、camelCase 拆词、路径、类型和语言，保留精确标识符/前缀/片段匹配，并把图邻居作为次级候选。BM25 现在保存倒排 posting，只对命中词的文档计分；符号搜索对象绑定已验证快照并限制为每个 Kernel 两个缓存项，缓存复用前会对底层最新分片的原始 payload 计算内容指纹，任何变化都会重新完整解析并执行已有分片 digest 校验。名称片段通过 trigram 先取候选，短于 3 个码点的查询保留完整名称检查。新固定双语查询集覆盖登录、权限、Context 回执与缓存失效，当前 MRR 与 Recall@3 均为 1.0；这是 5 个合成符号上的回归集，仅证明排序行为，不是竞品 benchmark 或真实用户查询质量证明。

真实 Craft 仓库热/冷查询复测：索引 500 个文件、约 33,877 个节点和 140,250 条边，冷索引用时约 35.6 秒；首次 `symbol_find` 约 1,846 ms，随后三次相同查询为 39/36/30 ms，返回符号 ID 与首次一致。此前剖析中全量节点装载约 1,000 ms、重建 BM25 约 750 ms；热符号查询约下降 98%。同一轮 `impact_query` 首次约 2,209 ms，随后三次为 147/148/149 ms，节点和边 ID 保持一致，约下降 93.3%。结果缓存最多八条，只绑定实际读取的边路由与图分片内容指纹；命中前对原始 Store payload 重验指纹，分片漂移会回到原 digest 校验路径。同一进程对未变化仓库再次 `repository_ensure` 用时约 255 ms，并复用同一 checkpoint index。此无变化测量不代表单文件变更增量更新性能；单机单仓库结果也不代表多仓库内存压力或竞品 benchmark。索引仍是 `partial`，调用者查询约 346 ms。候选只使用索引元数据，不把仓库源码发送给外部 embedding 服务。

新增可复现的真实仓库检索评测 `node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts`：使用 Craft 当前 500 文件 semantic index，对 10 个经源码核实目标的任务式查询比较旧排序与当前排序，并设 MRR ≥ 0.60、Recall@5 ≥ 0.90 的本地回归门槛。本次结果 MRR 从 0.358 升至 0.666，Recall@5 从 0.40 升至 0.90，Hit@10 为 1.0。该集为单仓库、手工挑选的 10 个开发查询，存在目标选择偏差；它仅能防止这些目标上的排序明显回退，不代表线上查询、其他语言或与 Serena/GitNexus/CodeGraph 的同条件比较。另为 TypeScript graph nodes 增加了 digest-pinned declaration kind，并让 analyzer 查询可利用符号类别；这丰富了可检查语义，但此轮真实仓库评测未提升整体指标，目标 `analyzeTypeScript` 在多词查询中的排名仍为第 8，需更多不同仓库及人工 query set 后再调整排序。

自动创建 basic 索引解决了“每个仓库都要手动激活”的摩擦；本轮又解决了大图单记录保存与已知节点查询的全图扫描问题。语义更新已支持当前 checkpoint 快速复用，以及 TS/JS 现有外部模块的文件级重算和传递反向 import 闭包。新增/删除文件、ambient/global 语义、`.d.ts` 或不完整缓存仍全量重建。`partial` 状态仍说明预算可容纳并不能证明关系完整。

### TS/JS 文件级增量更新验证

2026-10-13 增加本地无源码文件单元缓存，记录 analyzer 版本、文件 digest、节点/关系、模块边界、未解析关系和单元摘要。摘要/形状/版本校验失败会全量回退。相同 checkpoint 和策略在分析器执行前直接返回当前索引；修改已有外部模块时从导入图计算 transitive reverse-import 闭包，重算受影响文件并复用其他文件单元；文件集合变化和不确定的全局/ambient 语义全量回退。新缓存仅在 checkpoint 绑定导入成功后与 repository state 一起提交。

验证用例覆盖精确无变化复用、修改源模块并传播到调用者、无关模块复用、文件新增/删除触发安全全量重建、损坏/不兼容缓存回退、预算或不完整增量结果触发全量重试，以及增量 Python/TS 节点和边逐项等于全量分析结果。Python AST 更新按导入闭包重建图单元，但仍解析 checkpoint 中所有模块以解析跨文件名称；Jedi 当前未提供单元级结果时使用全量路径。TypeScript checker 现在按文件集合有限复用最多两个 compiler program，并仍以内容摘要区分变更源文件。新增单元测试验证相同源集复用 program、源内容变化后刷新结果。

隔离临时仓库基准从真实 Craft 源码中选取 485 个普通 TS/JS 外部模块（明确排除 `.d.ts` 和 ambient/global 声明），生成约 33,128 个节点和 135,759 条边。当前 `sharded-v2` 大图/分片摘要用字段顺序固定的 JSON SHA-256；原始 `sharded-v1` 规范化摘要仍兼容读取。关系 ID 同样只对固定字段对象采用顺序 JSON 摘要。路由表构建缓存相同节点/文件路径的桶摘要，避免对高频边端点重复 SHA-256。此次单次本机运行冷建索引 12,770 ms；修改单文件注释后增量耗时 7,373 ms，受影响 1 个文件、复用 484 个；同一变更的热 compiler program 全图重建路径耗时 13,990 ms，节点和边摘要完全一致。增量 analyzer 用 13 ms，增量图导入用 5,614 ms；全量 analyzer 用 5,960 ms、导入用 6,753 ms。与上一轮单次数据相比，增量导入约快 4.8%，但全量重建有所变慢，单次运行噪声与 OS/进程缓存影响尚未排除，不能据此断言稳定收益。TS/Python file-unit 仅写入摘要变化的单元；关系 span 每文件扫描一次行起点并二分转换 UTF-16 位置。测试验证旧 v1 索引可读、未变单元的 Store record version 保持不变、变更单元更新，且多行 Python 与含 emoji 的 TS 边位置正确。该结果是单次本机隔离仓库测量，存在 OS 缓存和进程内 compiler program 复用，不能当作统计结论；它仍远低于 IDE builder 的预期交互延迟，也不是 Serena、GitNexus 或 CodeGraph 同仓库比较。它不含全仓 `.d.ts`/ambient 文件；完整 Craft 仓库中这些语义仍按安全策略触发全量路径。尚未测量峰值内存或多仓并发。

当前本机 `repository-context.test.ts`、`typescript-incremental.test.ts` 聚焦测试和 `tsc --noEmit` 通过；尚未完成跨语言统一增量图或竞品 precision/recall benchmark，CodeGraph/Serena/GitNexus 仍在这些维度领先。

重建 TS/JS 增量实现后的本地发布产物并运行了 DSH Codebase 与 Context MCP smoke；两个 DSH runtime 都成功索引超过 10,000 个节点和 20,000 条边。另一次组件 MCP smoke 的 initialize、tools/list、tools/call 全通过。它们验证生成包和本地协议调用，不代表活动 Codex/Claude Host 插件已热切换。

### 2026-10-14 语言覆盖采样与 Context 回执

发现仓库选择器过去按路径排序直接截断 500 个文件，会让大型 TS/JS 仓库把路径靠后的 Python、Java、Go、Rust 等语言挤出快照。现改为按 TS/JS、Python、Java、Go、Rust、C/C++、C#、Ruby、PHP 语言族做确定性轮转，选择后再按路径排序；仍遵守 500 文件、8 MiB 总量和 512 KiB 单文件限制。安全读取失败以及各类预算省略数量按语言族记录，`craft_codebase_repository_ensure` 和 Context pack 都能返回这份诊断；索引策略版本已递增，旧仓库索引会按新选择集合重建。

本轮真实 Craft 仓库仍纳入 500 个文件，10 条手工任务查询的 MRR 为 0.666、Recall@5 为 0.90、Hit@10 为 1.0，达到本地评测门槛，没有观察到检索回归。临时仓库验证了 TS 主导且后排存在 Java/Python 时两种语言仍被纳入，8 MiB 边界内语言族均被公平保留；源发现模块经 32 项仓库上下文测试达到 100% 行/分支/函数覆盖。重打包的 DSH Codebase/Context MCP 分别索引超过 10,000 节点、20,000 关系，组件 MCP initialize/tools-list/tools-call smoke 通过。

对桌面 Craft Context MCP 的复测从调用回执和只读本机 Trace 确认：仓库调用失败原因为 `TypeScript graph exceeds import budget`，Trace 错误类别为 `LIMIT_EXCEEDED`。旧安装缓存的 0.12.42 bundle 明确仍带 `nodes > 10000 || edges > 20000` 限制；当前工作树已移除此旧阈值，并将图导入硬上限设为 64 MiB/60,000 节点/150,000 边。当前源码对该仓库计算出 33,197 节点、134,806 边、31.8 MB；重建 dist/plugin 后旧阈值字符串不再存在，插件包完整性、版本检查及 MCP smoke 通过。但安装缓存位于用户插件目录，本轮未改它；活动桌面 Host 尚未加载新包，因此实际 Host 调用仍失败，需通过正式重新安装/升级验证。语言选择器现识别 30 多族常见源码/配置扩展名，但自动语义分析仍主要是 TS/JS 与 Python。PATH 发现 clangd 和 sourcekit-lsp；Swift LSP 的真实调用未成功，且 `swift build` 因本机 Command Line Tools 与 SDK Swift 补丁版本不一致、ModuleCache 写入受限而无法准备 package fixture，故不能算 Swift 支持。外部 LSP 的正向真实服务端证据仍限 clangd C++ fixture。语言轮转解决的是“某语言因排序而完全缺席”，没有补齐 Java/Go/Rust 等自动语义分析，也没有解决 PDG/CFG、跨过程数据流、跨语言增量或同条件竞品精度基准。

## 差距优先级

1. **增量图更新：**TS/JS 与 Python（AST）已按文件事实和反向导入闭包增量更新；新增/删除文件和不确定语义安全回退。Python AST 现在对未变模块复用带来源摘要的符号与类方法元数据，只解析受影响模块；当前仓库 6 个 Python 文件的单文件变更验证显示解析 1 个、复用 5 个，合并图与全量图一致，复现命令为 `node --experimental-strip-types scripts/smoke/codebase-python-incremental-self-index.ts`。脚本最近一次单次运行记录 92 ms 增量分析和 150 ms 全量重建；样本小且 Python 启动成本占比高，不足以证明稳定提速。全 checkpoint 发现/读取/传输仍然发生。Jedi 没有文件单元时仍全量；还需在更大 Python 仓库测冷/热成本，并评估 TS builder program 及 Jedi 的解析器级增量。
2. **语言语义一致性：**自动语义分析主要覆盖 TS/JS 与 Python；外部 stdio LSP 可按需请求 references、definitions、incoming calls、implementations、type definitions 和 type hierarchy，并将结果归一成快照图边。定义候选最多每符号 20 个、每次请求 500 个静态引用位置，仍非任意光标的实时 LSP 请求。真实服务端证据目前限于 clangd 两文件 C++ fixture；仍需在 Java/Go 多文件仓库测量 provider、精度、recall 和 coverage。
3. **流程与程序依赖分析：**TS/JS 新增了基于现有 statement CFG 的函数内 may-reaching definitions 查询；仍无 GitNexus 风格 process graph、完整 PDG/控制依赖、字段/别名传播、跨过程数据依赖或 taint。每个扩展都需明确算法范围并使用数据流 mutation oracle，不能把局部静态近似当作运行时完整性。
4. **检索闭环：**当前代码检索是词法/结构排序，缺 CodeGraph 风格代码混合检索；应固定符号、调用、影响、自然语言问题集并测 precision/recall 和 Agent 任务成功率。
5. **公开可复现性能与覆盖指标：**按仓库规模、语言和冷/热索引给出耗时、内存、覆盖率、关系精度和 partial 原因，避免用单一“支持语言数”代表质量。

下一轮应补真实仓库的冷/热更新基准、解析器级增量、多语言适配器绑定及真实 Host 端到端验收。无需为了追赶工具数而把 Codebase 改成可写编辑器：若其定位仍是 Context 的可信只读证据提供者，应优先守住快照、来源与不确定性标注；对符号重构可通过 Serena/LSP 等外部能力接入，并把外部事实继续标成外部来源。

## 判断边界

这是基于当前源码、一次本机调用和官方公开资料的能力审查，不是相同仓库/任务集上的竞品 benchmark，也没有验证竞品对 Craft 仓库的实测效果。要声称“达到行业标准”，还需要固定仓库与查询集，比较定义/引用/调用图正确率、检索排名、索引更新正确性、资源成本和 Agent 完成任务率，并公开评测脚本与结果。


### 2026-10-14 扩展自动仓库文件发现

仓库发现现在识别 30 多个语言族的常见源码及配置扩展名（包含 JVM 系、Swift/Dart、Shell、函数式语言、Terraform/Nix、Web 组件、SQL 与常见配置格式），均进入既有有界快照和语言族轮转预算。扩展名识别只代表文件可纳入基础快照；TS/JS、Python 之外仍没有对应的内置语义分析器，semantic 模式会将无适配器的语言明确标成 unavailable。文件扩展表变化会通过 repository index policy 触发旧快照重建。

### 2026-10-14 受信任 LSP 自动索引接入

新增用户管理配置 `<CRAFT_DATA_DIR>/config/codebase-lsp.json`，将已登记的语言服务器接入 semantic repository onboarding。配置按语言绑定绝对可执行文件、参数、分析器标识、关系类型和文档上限；仓库内配置不能注册或执行程序。MCP worker 负责启动异步 LSP 客户端，输入只包含当前有界快照文档的临时镜像，结束后清理目录；索引状态包含配置摘要，配置变更将触发重建。无适配器、配置损坏、服务器失败及文档上限都会以语言诊断呈现。TS/JS 与 Python 仍使用内建分析器。实现用可注入适配器回归测试和 MCP worker + stdio LSP fixture 端到端测试验证，并补充配置、预算、语义导入和配置失效测试；配置和 worker 新增模块通过 100% 行、分支、函数覆盖门槛。

这一轮只打通适配器执行链，不应把扩展名清单或可配置 LSP 等同于“覆盖 Serena/GitNexus/CodeGraph”。已验证的自动 LSP 样例使用 stdio fixture，真实 clangd 的已有测试覆盖 LSP 客户端和 C++ 两文件关系，但未证明自动配置在多个真实语言项目中的 precision/recall。跨语言 per-file 增量、配置/编译数据库投影、控制流/数据流图、同条件性能与检索质量评测仍需后续迭代；外部服务器在本机 OS 用户权限下执行，临时快照不是 OS 沙箱。

### 2026-10-14 TS/JS LSP 适配和当前差距复核

复核 Serena 官方 README 的符号查询/引用/重命名与 CodeGraph 官方工具指南的文件级重索引后，发现前一轮适配配置不能接管 TS/JS：TS/JS 总是走 Craft 内建 checker，导致其对应语言服务器的 references、implementation 等关系能力被忽略。现将 `typescript`、`typescriptreact`、`javascript`、`javascriptreact` 注册到同一受信任配置表；显式登记后该语言本次语义索引由 LSP 输出替代内建 analyzer，未登记时仍走内建 TS/Python analyzer。端到端 fixture 通过 `craft_codebase_symbol_find` 和 `craft_codebase_relations_find` 取回 TypeScript class hierarchy；LSP config/worker 行、分支、函数覆盖维持 100%，完整相关测试及 TypeScript 类型检查通过。

这补齐的是接入路径，不证明外部语言服务器对每个仓库都能准确解析。Craft 当前仍没有 Serena 的符号级改写/rename 工具（且只读快照定位明确不承担写入职责），也没有 GitNexus/CodeGraph 风格 CFG/PDG、跨过程数据流和细粒度 LSP 文件缓存；CodeGraph 的混合语义检索和文件级增量能力也尚无同条件评测。不能宣称总体能力平齐；下一步应优先建立 Java/Go/C++ 多仓 relation precision/recall 集与跨语言冷/热增量基准，再依据真实误差决定是否实现 LSP file-unit 缓存或查询层混合检索。官方能力声明链接：[Serena symbol tools](https://github.com/oraios/serena/blob/main/src/serena/tools/symbol_tools.py)、[Serena README](https://github.com/oraios/serena/blob/main/README.md)、[CodeGraph tool-calling guide](https://github.com/codegraph-ai/CodeGraph/blob/main/docs/tool-calling-guide.md)。

### 2026-10-14 打包后真实仓库回归

活动桌面 MCP 仍可复现旧 0.12.42 bundle 的 `TypeScript graph exceeds import budget`；历史源码证据定位到 10,000 节点/20,000 边硬失败。为防止本地打包验收只覆盖小型 Codebase fixture，组件 MCP smoke 现会启动由当前工作树生成的 `craft-context` bundle，并对完整 Craft 仓库调用 `craft_context_open(index_depth="semantic")`，断言 Context 已解析且 Codebase 返回带 index/checkpoint 的 `ready`；同时断言 Codebase 与 Context 两个 Host 工具面都公开 impact 的方向参数。本地生成包通过；检索评测在 488 个文件、10 个手工目标上的 MRR 0.666、Recall@5 0.90，较旧词法基线分别为 0.357 和 0.40。相关 Codebase/LSP/Context 测试 63 项通过，LSP config/worker 覆盖率为行/分支/函数 100%，TypeScript 全量类型检查通过。该 smoke 证明当前生成包在该真实仓库可用，不证明桌面安装缓存已更新；也不替代多仓、多语言语义精度及性能评测。

### 2026-10-14 SourceKit LSP 实测与诊断

用本机 `sourcekit-lsp` 对临时 SwiftPM 快照发送 LSP 请求：`initialize` 成功，服务端随后在 `textDocument/documentSymbol` 阶段以 `SIGTRAP` 退出；命令行环境为 Xcode Command Line Tools 下 Swift 5.10。Swift 语义能力因此仍未验证成功，不能将扩展名识别或 LSP 配置入口算作 Swift 支持。为减少类似失败的定位盲区，LSP 客户端退出错误现在报告固定协议阶段、退出码和 signal，不暴露文档内容或可执行参数；已有 clangd 真服务测试及 fixture 测试通过，stdio 客户端新增改动达到 100% 行/分支/函数覆盖。尚未确认 SourceKit 崩溃来自本机工具链、快照初始化条件还是服务端缺陷，需用匹配 SDK 的独立 SwiftPM 环境复测。

继续抓取 SourceKit stderr 后确认：用户级 Clang ModuleCache 写入受限，且当前 Swift 编译器 5.10.0.13 与 SDK 所需 5.10.0.12.5 不匹配；临时重定向 `CLANG_MODULE_CACHE_PATH`/`SWIFT_MODULE_CACHE_PATH` 后进程不再立即 SIGTRAP，但 documentSymbol 仍超过 15 秒未返回。因此为受信任 adapter 增加 `request_timeout_ms`（默认 10 秒，最大 120 秒），可适配较慢的 LSP 初始化与文档请求；它不解决 SDK 版本冲突，也不算 Swift 成功验证。配置、worker、stdio 客户端相关覆盖门槛均为 100%，相关仓库/LSP 测试 56 项通过，三个 MCP 入口重建并通过组件 smoke、包完整性和版本一致性检查。

### 2026-10-14 LSP 符号跨快照增量缓存

受信任 LSP adapter 现在可跨 checkpoint 复用每个文件的 `documentSymbol` 结果：缓存键由 analyzer、analyzer 版本、adapter 配置摘要、路径、语言和源码摘要共同约束；只保存符号名、类型、位置和子符号，不保存源代码正文或 `detail`。每次索引仍向 LSP 打开完整快照，并重新运行引用、调用、实现、定义和类型层级请求，因此缓存只省去未变文件的符号请求，不省略关系分析。缓存单次总量限制为 32 MiB，符号图不完整或超过限制时不缓存相关文档；缓存与新图导入在同一最终存储事务中提交，索引失败不会发布部分新缓存。

验证包括：编辑跨文件调用方后，未变目标文件命中来源摘要缓存、变更文件重新查询，调用关系仍从新快照重算；缓存摘要不匹配回退到 LSP 查询；超预算缓存被省略。stdio 客户端和 LSP 适配器测试分别达到 100% 行/分支/函数覆盖，类型检查、仓库上下文 36 项、组件 MCP 启动/工具调用 smoke 与 DSH Codebase/Context 大图 smoke 通过。生成产物仍为 0.12.42，本地打包已刷新；当前桌面 MCP 安装缓存是否更新仍未验证。

### 2026-10-14 SourceKit 失败归因与诊断保留

使用带 `Package.swift`、Swift 源文件和 `.sourcekit-lsp/config.json` 的临时 package 重试。官方配置文档允许 `swiftPM.sdk` 与 `swiftPM.scratchPath`；但在当前 Command Line Tools 环境执行 `swift package dump-package --sdk <MacOSX13.3.sdk> --scratch-path <临时目录>`，manifest 编译命令仍使用默认 `MacOSX.sdk`，错误明确指出默认 SDK 要求 Swift 5.10.0.12.5，而当前编译器为 5.10.0.13；编译器同时试图写入用户级 `~/.cache/clang/ModuleCache` 并被系统拒绝。显式 SDK 在普通 `swiftc -typecheck` 上成功，不代表 SwiftPM/SourceKit 的包语义链路成功。官方配置虽能设置 SwiftPM SDK/构建目录，但本地实测未能改变 manifest 编译的默认 SDK，因此这台机器上不能宣称 Swift semantic indexing 已可用。参见 [SourceKit-LSP 官方配置文档](https://github.com/swiftlang/sourcekit-lsp/blob/main/Documentation/Configuration%20File.md)。

Codebase 之前将所有可信 LSP 适配器失败折叠成 `analysis_failed`。现在在不返回 stderr、源码内容、命令参数或任意异常文案的前提下，保留安全失败类别（超时、服务崩溃、启动失败、协议请求失败或其他分析失败）、协议阶段，以及可解析的退出码/signal。新增的七类诊断分支通过本地测试；`repository-context.test.ts` 与 LSP stdio 测试共 52 项通过，TS 类型检查通过。完整覆盖门禁为 93/115 组通过，Codebase 索引组仍有 `codebase-index.ts` 的既有未达 100% 分支/函数行；其他多组也有不相关覆盖或测试失败，本次未扩展修复。Swift 正向语义索引与兼容工具链仍需在具备匹配 Swift/Xcode 环境的主机验收。

### 2026-10-14 文件符号大纲

新增 `craft_codebase_symbols_overview`，按已知 checkpoint 相对路径返回排序、有界且不含源码正文的声明大纲；新 sharded-v2 索引通过位置路由仅读相关节点分片，旧分片索引保留 digest 校验后的全节点兼容路径。路径越界、checkpoint 外文件、超限和路由摘要损坏均有拒绝测试。MCP/Hookless surface、旧版分片兼容与 Codebase Skill 入口已接通。真实 Craft 仓库 488 文件、33,250 节点、134,391 边 smoke 通过，目标文件返回 500 个符号（受工具 500 上限约束），不含正文；增量相关测试 27 项通过，`tsc` 与 `git diff --check` 通过。该项补齐了 Serena 的文件级符号概览这一基础查询形态，不提供符号编辑、重命名或完整 LSP 语义。总 Codebase 覆盖仍未达到 100%，本轮完整 coverage-gates 在其他组首先出现既有未达门槛后中断；此前 Codebase `codebase-index.ts` 也存在分支/函数覆盖缺口，需单独继续处理。

同日复核检索评测发现第二个可验证问题：TypeScript analyzer 生成的 `declaration_kind` 在 `analysis_import` 规范化节点时被丢弃，导致搜索端无法用函数/类类别调整排序。现在导入时保留该类别并校验为非空、最多 100 字符；缺省仍兼容旧 adapter。对原 10 条仓库检索集重跑后，MRR 从 0.666 提升到 0.808，Recall@5 从 0.90 提升到 1.00；`analyzeTypeScript` 目标从第 8 名升至第 1 名。相关 Codebase/搜索测试 24 项通过，TypeScript 类型检查通过。该提升来自元数据保存和现有类别加权，不构成与 Serena/GitNexus/CodeGraph 的同条件检索精度对比。

为避免同一 checkpoint 的本机旧索引因幂等复用继续丢失声明类别，仓库索引策略从 9 调整为 10。迁移测试构造 policy 9 的旧索引记录并验证相同快照重新生成新策略索引、类别落盘；该变化不改数据库 schema、不删除历史旧索引。Codebase 级门禁仍有遗留未覆盖分支：最新独立跑为 95.00% branch、99.43% functions（lines 100%），因此 Codebase 全组仍不满足 100% 要求。

### 2026-10-14 图完整性与预算门禁闭环

继续按 Codebase 覆盖报告补齐图读写边界：测试现在验证重复节点、悬空边、节点/边/字节预算、单路由桶与总路由表预算，路由映射碰撞合并、未知分片拒绝、分片摘要与索引总摘要双重校验，以及旧内联图兼容。`loadIncidentEdges` 对缺少已知节点路由明确失败，避免把损坏索引解释成“无影响”。删除了路由节点已由前置端点校验保证存在时的冗余空值回退。Codebase 专项门禁当前 101 项测试通过，受控源文件行/分支/函数覆盖均为 100%；TypeScript 类型检查和 `git diff --check` 通过。这是质量门槛结果，不代表与竞品在多仓库、多语言语义准确率或性能上已达到同一水平。

### 2026-10-14 LSP 多文件请求并发

stdio LSP 客户端过去逐文件串行等待 `textDocument/documentSymbol`。现在先打开所有有界快照文档，再将符号请求按 8 路并发分批执行，并按原输入顺序收集结果。20 文件 fixture 证明首个查询前所有文档已打开、峰值并发恰为 8、乱序响应仍映射到正确符号；LSP 客户端专项 18 项测试以及真实 clangd C++ 关系测试通过，客户端行/分支/函数覆盖 100%，TypeScript 类型检查通过。该优化减少服务器往返等待，但仍发送全量快照并对全量符号查询关系；跨调用的增量 LSP 缓存和 IDE 级持续进程仍未实现，不能视作 LSP 全量解析瓶颈已解决。

同日重新运行当前工作树真实 Craft 仓库评测：488 个源码文件、10 条人工审核目标，检索 MRR 为 0.808（旧词法基线 0.357）、Recall@5 为 1.00（基线 0.40）；两个固定阈值通过。该测试集仍小且集中于 Craft 自身符号，不能外推为跨仓库、多语言泛化精度。另用 472 个普通 TS/JS 外部模块的隔离项目更新一个文件：受影响 1 个、复用 471 个，增量端到端 6.03 秒，干净全量重建 9.58 秒，图摘要一致；更新仍需约 3.92 秒导入持久化，显示索引图导入是下一步主要成本，analyzer 本身只耗时约 11 毫秒。该结果是单次本机实测，需多轮/多仓库分布评测后再作性能结论。

### 2026-10-14 LSP 大图预算对齐

外部 LSP 符号归一器原先在 10,001 个符号时抛错，使该语言整批分析不可用；其 10,000 符号阈值低于 Codebase 60,000 节点图预算。现将符号上限对齐为 60,000，超限时保留有界符号并通过 `budget_limited`、`omitted_symbols` 传递 partial 状态；LSP 单帧响应上限也从 16 MiB 对齐到分析输入预算 64 MiB，超预算响应仍拒绝。回归覆盖 10,001 符号完整保留及 60,001 符号时准确省略 1 个；stdio 端到端验证 partial 诊断完整到达结果。LSP normalizer 和 stdio client 行/分支/函数覆盖均为 100%，相关 19 项 stdio 测试与 28 项 LSP adapter/行业回归测试通过，类型检查通过。

本地由当前源码生成的插件包通过组件 MCP initialize/tools-list/tools-call smoke；Craft Context 对完整仓库 semantic indexing 返回 ready。重新生成的 DSH Codebase 与 Context MCP 包也通过超过 10,000 节点、20,000 边的索引 smoke。桌面内已安装的旧插件 MCP 在本会话仍返回 `TypeScript graph exceeds import budget`；本次没有改用户安装缓存或升级版本，须由 Host 安装/升级到新包后才能证明实际桌面调用已恢复。`pnpm run build:plugin` 因依赖状态检查尝试访问 npm 镜像且无 TTY 中止；改用本地已安装的 esbuild 完成本地 bundle 构建，版本仍为 0.12.42。

### 2026-10-14 官方能力资料复核：下一步差距

本节按 2026-10-14 可访问的 Serena、GitNexus、CodeGraph 官方仓库/文档复核；“官方明确”表示项目源码或维护者文档明确列出该能力，不表示独立准确率验证。“Craft 推论”是结合本报告记录的当前实现与本机测试得出的优先级判断。

本轮再次查看当前官方页面，补充一个容易误读的区别：GitNexus changelog 同时记录了 PDG/CFG 分块输出与 mutation-oracle CI，也将新增 Taint/PDG M0 schema 标为“尚无 phase 发射这些新节点/边”；因此不能把新 substrate 当作 taint 分析阶段已经完整上线。[GitNexus changelog](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/CHANGELOG.md)。CodeGraph 当前工具指南公开 `get_control_flow` 和 `trace_data_flow`，描述 CFG block/edge 与变量流追踪能力；Serena README 明确列出符号检索与 refactoring/rename 产品面。它们均是维护者声明，能力广度不等于同仓精度证明；Serena 的写入重构与 Craft 的只读快照目标也有不同产品边界。[CodeGraph tool-calling guide](https://github.com/codegraph-ai/CodeGraph/blob/main/docs/tool-calling-guide.md)、[Serena README](https://github.com/oraios/serena/blob/main/README.md)。

| 主题 | 官方明确 | 对 Craft 的判断与下一步（推论） |
|---|---|---|
| 符号语义 | Serena 文档明确提供文件符号大纲、符号查找、引用、声明、实现、诊断及通过 language server 的 rename；JetBrains 后端另列类型层级、move 等工具。见 [Serena 工具目录](https://oraios.github.io/serena/01-about/035_tools.html) 与 [Serena README](https://github.com/oraios/serena/blob/main/README.md)。 | Craft 面向 AI Agent，以任务/概念、符号名和仓库路径为入口，提供只读大纲、静态符号/关系/定义查询及按文件诊断。IDE 光标不是缺失的核心能力；底层位置查询仅在 Host 已提供文件位置时作为兼容入口。实际差距是模型能否低往返地从任务意图定位候选、读取经过快照校验的源码证据，并沿定义/引用/调用/实现关系继续探索；持续 LSP 会话和写入重构不属于当前只读目标。 |
| 调用图与影响 | GitNexus 官方 changelog 描述 opt-in PDG impact、语句级/跨过程切片、resolved-callee-id soundness 与 mutation oracle；默认 call-graph impact 与 PDG 模式分开。其架构文档还说明统一图上的多阶段解析/跨文件解析/作用域解析，并指出 group store 与 repo PDG 图只在 `symbolUid` 粒度连接，跨程序数据流仍 deferred。见 [GitNexus changelog](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/CHANGELOG.md) 与 [架构](https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md)。 | Craft 有 calls/impact、TS/JS 受限 CFG 和函数内 `may_reach` 定义/使用边；仍缺 control dependence、字段/别名、跨过程数据依赖、taint、process graph，以及更广的 mutation oracle。CodeGraph 暴露 CFG/data-flow 查询也不代表各语言同等完整。后续优先扩数据/控制流金标，再按实测支持范围扩语言；不把 call-graph 遍历或单函数 reaching-def 当作程序切片。 |
| 多语言解析深度 | GitNexus 架构公开列出 Tree-sitter 捕获标签、各语言 import resolver/provider、统一 scope-resolution、MRO 与按置信度分层的调用解析，并列出 18 个语言 provider；CodeGraph 工具指南列 38 种语言，但像 `trace_data_flow`、控制流工具均是特定工具所支持的解析能力，不能从语言总数推断每种分析能力同等可用。见 [GitNexus 架构](https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md) 与 [CodeGraph 工具指南](https://github.com/codegraph-ai/CodeGraph/blob/main/docs/tool-calling-guide.md)。 | Craft 自动语义主要在 TS/JS、Python；其余主要靠用户显式配置的 LSP，真实服务端验证仍窄。高优先级不是继续扩展扩展名名单，而是为 Java、Go、C++、Rust 等建立“文件→符号→跨文件引用/调用→影响”的真实仓库金标集，逐边测 precision/recall 与 unsupported/partial 原因。 |
| 增量与规模 | CodeGraph 文档明确提供 workspace full/incremental reindex、指定文件 `index_files` 和目录导入；GitNexus 架构说明 worker 并行解析、缓存命中时复用解析产物并用 disk-backed store 避免大仓内存峰值；其 changelog 说明 PDG 可分块输出。见 [CodeGraph 索引工具](https://github.com/codegraph-ai/CodeGraph/blob/main/docs/tool-calling-guide.md#reindex_workspace)、[GitNexus 架构](https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md) 与 [GitNexus changelog](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/CHANGELOG.md)。 | Craft 已有 TS/Python 文件单元增量和 LSP documentSymbol 跨快照缓存，但关系仍重算、LSP 仍打开完整快照；TS/Python 的目录扫描/读取/图导入仍有成本。下一步以统一“变更文件集→依赖闭包→精确失效→原子发布”评测为主：增删改/重命名/配置变化/损坏缓存后，增量图必须与 clean rebuild 一致，并测峰值内存、冷/热耗时；之后再优化受影响关系的局部重算。 |
| Agent 查询与检索 | GitNexus 文档明确提供 process/context/impact/trace/detect_changes、混合搜索及 MCP resources/prompts/skills；CodeGraph 文档提供 BM25+semantic+RRF 搜索、索引/流分析工具和 VS Code/MCP 入口；Serena 提供 MCP 接入与符号级工具。见 [GitNexus README](https://github.com/abhigyanpatwari/GitNexus)、[CodeGraph README](https://github.com/codegraph-ai/CodeGraph) 与 [Serena README](https://github.com/oraios/serena)。 | Craft MCP/Skill/插件的工具面已覆盖基本只读符号关系，但召回与回答效率证据仍局限于 Craft 自己的 10 查询集；尚无相同任务、相同模型预算下的跨仓库 Agent 完成率比较。建议先扩充语言/仓库分层的检索金标集并记录工具调用数、答案依据覆盖、任务成功率，再决定引入本地向量检索；向量召回应作为候选来源，不能降低代码事实的来源与快照校验。 |

| 评测可信度 | GitNexus 官方 changelog 明确提到以 mutation oracle 验证 PDG impact soundness，并有 parser readiness/parse-drift CI；其他页面主要是能力目录/维护者声明。见 [GitNexus changelog](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/CHANGELOG.md)。 | Craft 的当前小型仓库检索集、fixture 和单次本机性能数据只能作回归信号，不能证明与竞品同等。下一步应将 benchmark 拆为符号/引用/调用/impact/增量一致性/资源成本/Agent 任务七类，公开数据版本、金标来源、失败样本、partial 口径和可重复命令；分别报告事实与维护者声明，不制作一个混合总分。 |

### 2026-10-14 实现进展：受信任 LSP 诊断

按上表 Serena 的诊断能力缺口，新增只读 MCP 工具 `craft_codebase_diagnostics_find`。工具要求 Codebase 索引已激活、目标路径属于 checkpoint、用户显式信任该语言的 LSP adapter；只把 checkpoint 文件复制到隔离临时目录并运行 LSP，不读取工作区当前源码。支持 LSP push diagnostics 与 server 支持时的 pull diagnostics；无报告、文档/消息超限、adapter 配置变化分别产生 partial 或拒绝，不把“空结果”与“干净文件”混为一谈。诊断消息仅作为本次响应返回，持久回执只记录摘要与计数。

验证：Codebase 集成 117 项通过；纳入覆盖门禁的 capability、index、CFG、diagnostics query、ownership 与应用 facade 均达到行/分支/函数 100%；LSP stdio client 和 LSP config 各自的专门覆盖门禁也达到 100%。Context remediation 29 项及 DSH Codebase/Context MCP 大图 smoke 通过。此项补齐的是按文件诊断入口，不含持续 LSP session 或写入重构。Codebase 的整体差距仍包括多语言自动分析深度、CFG/PDG/数据流、广泛 mutation-oracle 金标，以及跨仓库 Agent 任务评测；单仓 10 条检索集不能证明竞品级精度或完成率。

**优先顺序（推论）：**(1) 建立跨语言、跨仓库的可复现金标与 clean-rebuild 一致性门禁，先知道当前错误在哪；(2) 优化以任务意图/概念为入口的符号探索、源码证据读取和关系追踪，按真实 Agent 工具往返数与任务成功率评估；Host 提供文件位置时可复用位置接口，但不要求 Agent 从光标起步；(3) 选择一种主力语言试点受限 CFG/PDG 和 mutation oracle，只有被验证后再扩语言；(4) 用稳定性/资源数据优化增量局部关系更新与大仓内存；(5) 再评估混合检索是否提高任务成功率。多语言“支持数”、工具数、单仓单次速度都不能替代这些验收。

### 2026-10-14 内容寻址分片与真实仓库增量基准

对按来源路径分片的 `sharded-v3` 做了完整性复查，发现读取端之前验证了分片摘要与 manifest，却没有验证分片 ID 是否由当前 payload 摘要生成。读取现已校验 `codebase_shard_<digest 尾部>`。更正：此段前一轮报告的 smoke 图一致性断言无效，因为脚本读取的 `analysis.nodes/edges` 并不存在，两个摘要实际都基于 `undefined`；因此该次 472 文件、32,591 节点、130,374 边的性能数据可作时间记录，但不能作图一致性证据。后续将脚本改为比较持久化图摘要，并在 `sharded-v4` 中使它成为由验证过的分片摘要构成的提交。

发现 `persistIndex` 在路径分组时每次追加都复制既有节点/边数组，改为原位追加；CPU profile 进一步确认全图摘要 JSON 序列化是主要热区。`sharded-v4` 将全图、节点集、边集摘要改为有序内容分片摘要的承诺；每片仍通过 payload digest 与内容寻址 ID 校验，旧 v1/v2/v3 使用原规则读取。最终工作树在 472 个文件的本仓库进行了两次配对测量：第一次为 32,606 节点/130,412 边，增量 3.50 秒、全量 8.89 秒、图导入分别 2.65/3.78 秒；第二次为 32,608 节点/130,414 边，增量 5.87 秒、全量 11.12 秒、图导入分别 4.19/3.44 秒。两次均只持久化 16 条增量记录，对比全量 737 条；每一对的增量与全量 `graph_digest` 完全一致（各自分别为 `sha256:be8ead0473c3cc59e4b8061614ed4561bc0f73b339b8455bf9a3101bafcc0764` 与 `sha256:e31578324631dc9d9ae357bb0c4640639ade5e9a17a448a7b7cfc62430be95ed`）。耗时波动明显，不能用最快一次代表稳定表现；还需同进程多轮基准、更多仓库、冷/热分层及内存峰值采样。10 查询检索评测 MRR 0.808、Recall@5 1.0，词法基线分别为 0.355 和 0.4，仍不足以代表多语言总体表现。此轮 106 项 Codebase 覆盖门禁达到行/分支/函数 100%；TypeScript 类型检查、组件插件 MCP 与 DSH Codebase/Context 大图 smoke 通过。`pnpm run build:plugin` 因 registry 访问失败及 no-TTY 安装确认中止；随后直接调用已安装 esbuild 成功重建本地 bundle 并通过 smoke，本地通过不代表远端市场或已安装 Host 缓存更新。

随后发现影响查询把 calls、imports、references、type_definition 等异质关系合并遍历，调用方无法询问“只看调用链”或“只看导入依赖”。现为 `craft_codebase_impact_query` 增加可选 `relation_kind`，值与 `relations_find` 共用受支持关系枚举；省略保持旧的全关系行为，过滤条件写入回执和结果缓存键，防止不同查询互相命中。覆盖调用/导入筛选、非法关系拒绝及 MCP schema 的专项测试通过；Codebase 门禁 106 项全过，`capability.ts`、`codebase-index.ts`、`ownership.ts`、应用层 facade 的行/分支/函数覆盖均为 100%，类型检查通过。该能力只提升查询精度，不构成 PDG/CFG 或程序切片；控制流/数据流与变异 oracle 仍是优先缺口。

为稳定测量 TS/JS 单文件增量，`pnpm run benchmark:codebase-incremental -- 5`（底层脚本 `scripts/smoke/codebase-incremental-self-index.ts [rounds]`）现默认运行 5 轮；每轮改一个不同文件、以持续增量 Store 与新建空 Store 的全量分析配对，并逐轮要求图摘要相同。验证本仓库 472 个 TS/JS 文件的 5 轮结果：增量更新中位数 4.589 秒，全量分析中位数 8.633 秒，图摘要每轮一致；每轮重用 467–471 个文件单元。增量 analyzer 本身 8–62 ms，但图导入仍约 3.0–3.9 秒，接近全量导入的 2.7–4.5 秒，说明整体加速被全图验证、路由/持久化装配和仓库快照扫描限制。基准使用同一 Node 进程，TypeScript 编译器内存缓存会保温；空 Store 表示没有已持久化索引和文件单元，不等于操作系统冷启动。最初改成多轮时发现旧脚本全量对照在后续轮复用了 Store 和文件单元缓存，该轮速度数据作废；现已修正每轮创建新 Store 后再测。另运行 `pnpm run eval:codebase-retrieval`，本仓库 488 文件/10 个标注查询 MRR 0.808、Recall@5 1.0，对比词法基线 0.355/0.4；样本仍太小，不能代表多语言总体表现。该结果只代表当前单仓、此版本、当前机器，尚无内存峰值、多仓、跨语言配对数据。

同日再次单独运行修正后的 5 轮基准（避免与测试并行争用）：472 个文件、每轮 32,633 个节点/130,503 条边，增量中位数 5.369 秒、空 Store 全量重建中位数 9.875 秒（1.84x），5 轮 graph digest 均与全量重建一致；每轮重用 467–471 个文件单元。阶段计时显示增量 analyzer 中位数仅数十毫秒，增量 `persistIndex` 约 2.1–2.4 秒、checkpoint/发现约 1.1–1.3 秒；导入校验每次仍读取并散列 472 个快照文件。性能有明显轮间波动，1.84x 仅作本机单仓基线。另一次尝试用 `pnpm run` 触发了 pnpm 自动依赖状态检查，registry 不可达且 no-TTY 安装确认失败；直接运行 `node --experimental-strip-types scripts/smoke/codebase-incremental-self-index.ts 5` 成功，测试门禁也直接调用 Node 完成。Codebase 专项覆盖门禁 106 项通过，所覆盖四个入口模块行/分支/函数均为 100%；`tsc --noEmit` 与 `git diff --check` 通过。该轮没有改变生产代码，因此这些结果证明现有状态而非新优化效果。

随后复核 10 条检索标注时发现，查询“按源码位置解析定义”把业务入口包装函数 `codebaseDefinitionFind` 指定为唯一相关答案，但实现主体 `findDefinition` 实际排第一；这会把合法的内部实现召回误计为错。将标注目标改为直接实现，重跑 488 文件评测后 MRR 为 0.87、Recall@5 为 1.0，基线仍为 0.355/0.4。此变化只修正测试金标，不改变检索排序；10 条自仓库查询仍不足以证明泛化能力。下一轮应让每个问题允许多个相关答案（入口、实现、定义分开打分），并扩展到外部仓库及多语言数据集。

### 2026-10-14 有界 TS/JS 控制流查询

为补足 Serena 的 LSP 诊断/符号查询与 GitNexus、CodeGraph 的程序结构分析之间的差距，新增 `craft_codebase_control_flow_query`：它只针对已索引函数，从摘要校验通过的 checkpoint 文件构建有上限、无源码内容的语句级 CFG，支持常见 if/else、循环、break/continue、return/throw，并将尚未建模的 switch/try、标签、条件/短路/可选链/yield 等情况明确标为 partial。图只在请求内计算；receipt 仅固定 index/source digest，不持久化派生源码事实。114 项 Codebase 集成测试通过，受覆盖的应用/索引/所有权/CFG 模块行、分支、函数覆盖均为 100%；`tsc --noEmit` 与真实 488 文件 Craft 仓库 self-index smoke 通过。该仓库 smoke 报告 `certainty: partial`，虽无本次调用诊断，不能据此声称整个仓库分析完整。

此实现仍远低于 GitNexus opt-in PDG：没有 reaching-definitions、控制依赖、taint 或跨过程切片；CFG 只支持 TS/JS，且复杂表达式明确降级。补入一条真实 analyzer 级 impact mutation oracle：修改 checkpoint 中一个调用点、重建索引，并验证被移除的直接调用方退出影响集、未改调用方仍存在，且回执固定到新索引。115 项 Codebase 集成测试通过，相关实现行/分支/函数覆盖均为 100%。这只验证一个调用边变化，不能外推为整体 impact soundness 或 precision。GitNexus 官方 changelog 记录其逐语言 CFG/PDG、reaching-definitions、taint 和 mutation-oracle 工作；CodeGraph 工具指南列有 `get_control_flow`、`trace_data_flow`，Serena 文档列有按文件/符号诊断、引用和 REPL 组合调用。这些是维护者公开的能力声明，并非与 Craft 的独立精度对比。[GitNexus changelog](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/CHANGELOG.md)、[CodeGraph tool guide](https://github.com/codegraph-ai/CodeGraph/blob/main/docs/tool-calling-guide.md)、[Serena tools and APIs](https://oraios.github.io/serena/01-about/035_tools.html)。后续需扩展多种源码变异与控制流路径金标，验证召回后再扩展表达式/语言与数据依赖；同时建立多仓、多语言、冷/热的索引与 Agent 完成率评测。现有检索数据仍只有本仓库 10 个问题，不足以证明同业优秀水平。

### 2026-10-14 面向 Agent 的符号探索

IDE 光标查询不是 Craft 的优先入口：主要消费者是 AI coding agent，它通常从任务描述、符号名和仓库上下文开始，而不是从光标位置开始。现有 `symbol_find` → `relations_find`/`callers_find` 流程需要多次工具往返，并要求模型自行保持 node id 与关系过滤条件。新增只读 `craft_codebase_symbol_explore`，以名称或代码概念查询，一次返回有界候选及其 calls/imports/references/definitions/implements/extends/type_definition 证据；可按 checkpoint 路径、关系类型和方向过滤，返回 exact/模糊命中状态、候选与关系截断计数。它只消费已准备好的索引，不接受光标，也不返回源码正文。

验证：Codebase/MCP/Context `code` 意图接入测试通过；146 项集成用例及相关 capability/index/CFG/diagnostics/ownership/application 模块行、分支、函数覆盖均为 100%；Context remediation、类型检查、DSH smoke、全量 MCP bundle、工具面/分层/文档审计通过。在真实 488 文件 Craft 仓库的 10 条既有标注查询集上，`symbol_explore` 的 MRR 为 0.842、Recall@5 为 0.90，BM25 基线为 0.355/0.40；10 个目标符号均返回至少一条已索引关系。该结果说明新接口在此小型单仓集上保留现有符号排序并附带关系，不是 Agent 任务成功率/关系准确率证明；其中一个目标仍排第 6。仍需多个真实仓库、语言及任务集的配对评测，并继续补齐多语言语义和 PDG/data-flow 缺口。

运行时边界复核：当前桌面安装的 Craft Context 插件回报版本仍是 0.12.42，其缓存 MCP bundle 还保留 10,000 节点/20,000 边的 TypeScript 导入上限，工具目录没有 `craft_codebase_symbol_explore`；对当前 488 文件仓库调用该运行时的 semantic `repository_ensure` 明确失败为 `TypeScript graph exceeds import budget`。当前工作树源码以隔离 Store 对同一仓库 self-index 成功，产生 33,684 节点、135,214 边并标记 `certainty: partial`。因此源码构建和桌面已安装运行时不是同一个已验证分发物；更新插件包/市场并让实际 Host 运行新工具仍是未完成的发布集成工作。本次没有修改已安装缓存。

### 2026-10-14 Agent 声明源码读取与续读

用户指出 Codebase 面向 AI 模型，按光标位置查定义/引用/实现并非合适的主工作流。新增 `craft_codebase_symbol_read`：Agent 先按任务意图探索符号、查看有界关系并消歧，再按 node id 从不可变 checkpoint 读取解析器验证的完整声明；没有可靠声明范围时返回带摘要校验的有界源码窗口。超长声明可用 continuation 续读；令牌绑定 index、symbol 和 source digest，不能跨符号或快照复用。Skill 已说明该流程，没有把编辑或 IDE 光标作为前提。

在本机 488 源文件仓库的 10 条任务查询集上，symbol explore MRR 0.842、Recall@5 0.90；10/10 目标声明均通过 checkpoint digest 校验并完整读完，最长 5 页，100% 返回至少一条关系。检索验收通过。该数据仍只是单仓、小样本的检索/读取评测；解析准确率、关系 precision/recall、真实 Agent 完成率及多语言外部仓表现仍未证明。严格覆盖率重跑中，Codebase 索引模块仍发现 1 个未覆盖分支（空声明读取），已补回归用例，最终门禁结果待复跑；不应把此前 99.90% 分支覆盖表述成通过。

### 2026-10-14 调用边归属纠正与真实仓库金标

复核五条 production call path 时发现 TS/JS 调用边原先直接继承 AST 遍历的最近声明 owner。`const value = helper()` 会让局部变量 `value` 成为调用方，破坏调用者和影响查询的粒度；在真实索引里，`collectLspRelations` 的调用方被标成局部变量 `collected`。现改为调用边寻找最近可识别的函数/方法 owner；具名箭头或函数表达式仍归属其变量声明，顶层初始化保留变量归属。分析器 schema 升至 `craft-ts-semantic-v4`，使旧的文件级增量事实失效并重建。

回归覆盖函数内局部初始化、内联箭头、具名箭头变量和顶层初始化；59 项 TypeScript/repository-context 测试通过，TypeScript analyzer 行、分支、函数覆盖均为 100%。488 文件 Craft 仓库重新索引后，五个审核目标（`codebaseSymbolRead`、`codebaseRepositoryEnsure`、`persistIndex`、`collectLspRelations`、`analyzePythonCheckpoint`）的 production 直接调用方金标 precision/recall 均为 1.0；主要修复前述 `collected` 误归属。该指标只覆盖五个手工审核目标、排除 tests/scripts/plugins 路径，不能代表全仓图精度，也不覆盖动态派发、反射、跨语言调用或完整影响闭包。下一步要增加外部仓库和语言分层的 caller/impact 金标，并独立报告未解析关系与截断比例。

同一 5 目标金标也经 `craft_codebase_impact_query` 的 incoming/calls/depth=1 独立读取，直接影响集合 precision/recall 为 1.0。新增两层 fixture 验证 `target <- caller <- upstream` 的传播；此处另外发现 Agent 结果正文缺少影响查询 `truncated` 与 `max_depth`，虽然 receipt 查询元数据已有截断值，现在两字段也明确出现在正文。35 项 Codebase 集成测试通过。该结果验证直接调用影响和一个双层合成链，不证明真实大仓库的全量闭包、通用 relation-kind 影响精度或预算边界下的精确省略判断；后续评测需加入真实多层金标和截断正/负样本。

### 2026-10-14 clangd 多文件调用与影响链

本机 Apple clangd 15 在四个 C++ checkpoint 文件（两个头文件、两个实现文件）上的真实 stdio LSP 用例通过：导入了跨文件 `calls`、`references`、`definitions` 和 `extends`；`run -> callCompute -> Base::compute` 两跳调用链与 depth=2 incoming impact 查询一致，未截断。数据来自临时本地 package，没有依赖网络，也未让 clangd 读取 checkpoint 外源码。该用例证明当前 clangd 版本和简单 include/package 形态可用，不能覆盖 compilation database、宏/模板、平台 SDK、生成代码或其他 clangd 版本；Java/Go/Rust 等真实语言服务器与真实项目仍没有同等端到端金标，后续继续分层验证。

### 2026-10-14 全局索引预算与增量文件单元

在 472 个 TS/JS 模块的本机仓库测量中，TypeScript compiler 的全局语义图达到图预算后，分析器把 `budget_limited` 传播给每个文件单元。仓库 onboarding 因而拒绝持久化所有单元，单文件修改时再次全量分析。现将全局图是否截断与每文件单元是否完整分开，并各自限制单文件及聚合缓存大小；路径集合摘要一致时，增量计划还可补算缺失单元并覆盖其反向依赖闭包。图预算不完整仍如实返回 partial，不会因此把完整文件缓存清空；文件缓存预算不完整仍全量回退。

61 文件、约 6.1 万声明的回归夹具验证：目标文件缓存可保留指向全局截断图中未输出声明的关系，同时最终图不会输出悬空边。相关 TypeScript 增量计划覆盖 100% 行/分支/函数；analyzer 的严格覆盖门禁正在复跑。472 文件本机仓库两轮单文件更新后分别复用 471/467 个文件单元，增量图与 clean rebuild 的摘要一致；本次测得冷建索引 14.17 秒、增量中位 11.57 秒、全量中位 23.18 秒。单机两轮结果存在明显波动，只能说明这次工作树的正确性和初步成本，不构成持续性能承诺或同业性能比较。

### 2026-10-14 TS/JS 函数内数据依赖查询

官方能力复核显示 GitNexus 已公开 opt-in CFG/PDG、intra-procedural reaching-definitions、控制依赖和 taint 阶段；其 PDG-backed impact 也单独提供 statement-level/inter-procedural slice，并用 resolved-callee soundness 和 mutation oracle 验证。[GitNexus changelog](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/CHANGELOG.md)。CodeGraph 将 `get_control_flow` 和 `trace_data_flow` 作为按请求调用的工具，并分别说明结构与变量 flow 结果；这说明按需返回模型可消费的局部图是合适的产品入口，但工具清单本身不是准确率证据。[CodeGraph tool-calling guide](https://github.com/codegraph-ai/CodeGraph/blob/main/docs/tool-calling-guide.md)。Serena 的定位重点仍是模型按符号大纲、定义/引用和类型语义检索，并非需要 IDE 光标才能开始的 UI。[Serena README](https://github.com/oraios/serena/blob/main/README.md)。

Craft 新增 `craft_codebase_data_flow_query`：模型给已索引函数 node ID 和变量名，能力从摘要校验过的 checkpoint 解析该函数，在 statement CFG 上用 checker 的符号身份做 reaching-def 固定点合流，返回 source-free definition/use spans 与 `may_reach` 边。该工具经过 Codebase Kernel、Context 的 `code` 意图和完整 MCP surface，receipt 固定 index、checkpoint、node、变量与源码 digest。它会对同名局部变量返回 ambiguous；try/switch/短路等不完整 CFG、destructuring、for-of 左值无法映射、语法错误、事件/候选/边预算超限均明确为 partial。未将模型编辑或任意路径/offset 作为入口。

9 项模块测试覆盖直线赋值、if 两分支合流、loop back-edge、同名遮蔽、参数、compound assignment、前后缀自增、嵌套 closure 排除、析构、语法错误、事件/边/候选/固定点预算和 checkpoint-only compiler host；新模块行/分支/函数覆盖均为 100%。MCP 端到端测试确认响应有数据边、含 receipt、无源码正文且进入 Codebase surface。尚未对真实多文件 TS/JS 项目运行数据流 mutation oracle，也未验证细粒度别名/heap、控制依赖、跨过程传播、source/sink taint 或把结果用于 impact 查询。因此这是局部 reaching-def 基础，不是 GitNexus PDG parity。

多语言方面，本机当前没有 `gopls`、`jdtls` 或 `rust-analyzer`，现有可验证真实服务仍只有 clangd C++ fixture；本轮没有据此宣称 Java/Go/Rust 完成。下一步应先用稳定的多语言服务器环境建立真实跨文件金标，再将数据流算法扩到各语言实际支持的 CFG，而非从扩展名数量推断覆盖。

### 2026-10-14 中英混合任务式符号检索

模型入口已改为任务描述式 `symbol_explore`，但现有分词器虽然切分中文，Codebase 原先缺少常见研发意图到英文代码标识符的映射；“增量重建怎么规划”“关系收集器”“上下文候选”等中文任务容易只匹配路径词。新增有限、可审阅的代码领域中英别名，并将 4 条中英混合任务加进同一仓库检索评测。

在 481 个源文件的当前 Craft 快照、14 条审核目标上，symbol-explore MRR 为 0.850、Recall@5 为 1.00，词法基线 MRR/Recall@5 为 0.361/0.50；新增 4 条中文任务的 Recall@5 与默认 8 个候选覆盖均为 1.00。之前 10 条英文查询的 MRR/Recall@5 为 0.837/0.90；由于此次增加了四条查询且索引快照计数也不同，不将两次总体分数解释为可比提升。目标均通过摘要校验的声明读取；五条直接 caller/impact 金标仍各自为 1.00。新增检索模块严格测试 7 项通过，行/分支/函数覆盖 100%，`tsc --noEmit` 通过。

这组结果是单仓的 14 条手工标注查询，不是外部仓泛化或真实 Agent 完成率；别名映射也不是向量语义检索，未覆盖领域术语变化与复杂自然语言意图，需继续从跨仓、多语言任务集验证精度和误召回。

### 2026-10-14 Agent 默认候选召回

按 Agent 入口默认参数复核真实检索评测时发现，`persist graph shards and routes` 的正确实现 `persistIndex` 排第 6，而 `symbol_explore` 默认只返回 5 个候选；模型即使使用推荐的任务式入口也拿不到正确候选。默认候选数提高为 8，工具描述与 Codebase 文档均说明模型无需提供编辑器光标。评测新增默认候选目标覆盖率门槛；本机 488 文件当前仓库 10 条任务查询的默认目标覆盖率为 1.0，MRR 为 0.837，Recall@5 为 0.90；五条 production caller/直接 impact 金标 precision/recall 均为 1.0。评测用例小且只来自 Craft 自身，修改评测源码也会影响被索引语料和 BM25 IDF，因此该数值只作本轮可复现回归证据，不能说明外部 Agent 召回率、跨仓库表现或行业 parity。

### 2026-10-15 Agent 检索排序与增量一致性复核

把任务式检索集扩到 15 个中英查询并在同一 Craft 仓库重新运行后，暴露两个旧问题：`symbol_find` 先将查询全部转为小写，丢失 `TypeScript` 等 camelCase 分词边界；BM25 对声明正文、符号名和路径的匹配权重相同，使通用正文词压过符号名/路径中的精确线索。修复保留查询原始大小写供分词、以小写查询摘要保持回执稳定，增加名称/路径字段权重、常见动作词的函数/方法偏好及有限代码术语别名。对 analyzer 的“function”泛化不再作为无差别查询词；只在声明类型确为函数时加权。

真实仓库 488 个源文件、15 条手工审核目标的可复现评测结果：旧排序 MRR 0.323，修复后 MRR 0.824；Recall@5 从 0.40 升到 1.00；`symbol_explore` MRR/Recall@5 为 0.824/1.00，默认候选覆盖与 digest 校验后的源码读取完成率均为 1.00。4 条中文任务的 Recall@5 与默认覆盖均为 1.00。6 个直接 caller 和 depth=1 impact 金标的 precision、recall 分别均为 1.00。固定门槛为 MRR ≥ 0.60、Recall@5 ≥ 0.90，评测通过。查询和目标是单仓人工选取，指标可能受该仓结构、重复插件实现和目标选择偏差影响；这不是外部仓泛化、真实 Agent 任务成功率或 Serena/GitNexus/CodeGraph 同条件比较。

真实 Craft 自索引回执为 488 文件、34,311 节点、121,714 条边，状态仍明确为 `partial`；冷索引约 6.45 秒，前三次同进程热符号搜索约 105/108/120 毫秒。5 轮 TS/JS 单文件变更基准覆盖 472 个模块；每轮增量图摘要与独立 clean rebuild 完全一致，中位增量 5.04 秒、全量 6.96 秒，约 1.38 倍。Python 7 文件夹具修改 1 个模块、复用 6 个，增量图与 clean rebuild 节点/边一致。Craft Codebase 与 Craft Context DSH MCP 均通过超过 10,000 节点、20,000 条边的大图 smoke。Codex/Claude 面向 Agent 的入口仍是任务式符号探索、快照源码读取、关系/影响查询；没有引入编辑器光标或代码写入能力。

Codebase 专项 139 项测试和全仓 `tsc --noEmit` 通过；纳入 `craft-codebase` 门禁的全部文件行/分支/函数覆盖为 100%，检索排序模块也为 100%。保留既有只读 checkpoint、digest 校验、预算及明确 `partial` 覆盖状态；查询上下文不持久化源代码正文。语言差距仍明显：自动语义主要是 TS/JS 与 Python，其他语言依赖用户显式信任的 LSP adapter，真实跨语言仓、跨仓 Agent 任务完成率和与三个参照项目的同条件准确率尚未验证；下一轮应扩展外部仓、多语言 caller/impact 金标，并单独量测冷/热内存与变更关系局部重算。

### 2026-10-15 外仓评测与 Python 导入关系修复

检索评测器新增 `--suite <json>`，可将人工审核的任务查询、精确符号目标与 caller 金标绑定到任意真实仓库；不传 suite 时沿用 Craft 自仓默认集合。首个外仓集为 `d-simu` 的 12 条 Python 任务查询（其中 2 条中文）、2 个调用图目标与 3 个 caller 金标。运行命令：`node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts /Users/didi/Documents/project/d-simu --suite scripts/eval/suites/d-simu.json`。

首次运行发现该仓库把 `path/to/venv` 提交进 Git，依赖源码参与符号检索并污染关系图。仓库发现现在将目录名为 `venv`、`.venv` 和 `virtualenv` 的文件夹视为生成/环境目录，包括被 Git 跟踪的内容；`repository-context.test.ts` 加入 tracked `path/to/venv` 回归用例。索引文件数从 415 降至 64。进一步发现 Python 分析器把嵌套文件里的绝对导入错误解析为相对导入；`service/http_server.py` 中 `from scheduler.conversation_scheduler import ConversationScheduler` 因此漏掉 caller。修复后增加嵌套绝对导入调用边断言，并确认 d-simu 两处 `ConversationScheduler` 实例化都进入调用图。

修复并加入面向中文 Agent 任务的“并发对话/启动仿真接口”有限别名后，d-simu 检索 MRR 为 0.878、Recall@5 为 1.00；两条中文任务 Recall@5 为 1.00，默认 `symbol_explore` 候选覆盖、digest 校验源码读取均为 1.00；3 个 caller 金标和相同的 depth=1 impact 金标 precision/recall 均为 1.00，评测通过。索引确定性地报告 `partial`，未解析外部依赖及其他静态关系仍不作为已完成语义。本地 `tests/repository-context.test.ts` 38 项和 `tests/codebase-context-search.test.ts` 8 项通过；两个新增/修改生产模块各自的 c8 行、分支、函数覆盖均为 100%。Craft 自仓 488 文件、15 条检索目标的复测 MRR/Recall@5 为 0.824/1.00 并通过；第一次复测遇到一次 digest mismatch 后，立即重跑通过，原严格校验保持 fail-closed。全仓 `tsc --noEmit` 本轮被 `tests/scenario-evaluation.test.ts:32-33` 两处 spread 类型错误拦截；它们不在本轮改动范围。

该结果只覆盖一个 Python 仓库和手工选定的 10 条查询，不能外推到 Java/多语言仓、真实 Codex/Claude Host 任务成功率或 Serena/GitNexus/CodeGraph parity。Craft 自仓评测、持续集成 TypeScript 构建及 Host MCP 初始化仍需分别验证。

### 2026-10-15 Java 快照分析与 d-forge 外仓验收

Java semantic analyzer 使用 JDK 自带 Compiler Tree API，只解析当前摘要校验后的 checkpoint 文档镜像；通过 `-proc:none` 禁止注解处理器，不加载项目构建文件或仓库外源码，也不保存源码正文。索引 Java 的类、方法、字段与构造器声明，并在编译器可绑定到本快照符号时记录 calls、imports、extends 边；缺失第三方依赖会计入 `compiler_errors` / unresolved 计数，图仍为 `partial`。节点进入现有 `file`/`symbol` 合约，类通过 `declaration_kind=class` 区分。

外仓源码评测发现 500 文件快照上限在 d-forge 里截掉 `DataWorkflowServiceImpl` 和 `SimuTaskServiceImpl` 两个调用方，导致图不能验证真实跨模块调用。Java 源码共 1,028 个、约 3.79 MiB；因此将有界快照文件上限调为 1,200，仍保留 8 MiB 总字节、512 KiB 单文件限额和语言轮转选择。随后 1,045 个入选文件形成 1,045 个内容分片，暴露读取路径遗留的 512 分片清单上限；将其提升到 2,048，仍由图节点/边、输入与持久化字节预算共同限制。

复现命令：`node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts /Users/didi/Documents/project/d-forge --suite scripts/eval/suites/d-forge-java.json`。当前结果：3 条 Java 任务查询（含 1 条中英混合）MRR 0.667、Recall@5 1.00、默认 `symbol_explore` 目标覆盖和 digest 校验源码读取均为 1.00；`getDataWorkflow` 的 2 个调用方金标准，直接 caller 和 depth=1 impact 的 precision/recall 均为 1.00。d-forge 1,045 文件索引仍标记 `partial`：JDK 8 对缺失外部依赖产生 100 个 compiler errors、35,440 个 unresolved calls、6,100 个 unresolved imports；未把这些关系计作已解析事实。该小型人工评测只验证所列 Java 目标，不代表完整仓库召回率、完整调用覆盖、真实 Agent 成功率或与 Serena/GitNexus/CodeGraph 同条件比较。

本轮受影响覆盖率组通过：`craft-codebase` 144 项及 `repository-context-products` 141 项，纳入组内模块行/分支/函数均为 100%；`node node_modules/typescript/bin/tsc --noEmit` 通过。`craft-codebase` 与 `craft-context` 组件包各自用 MCP 对 Java fixture 返回 ready，验证打包相对路径能够找到 helper。外部 d-forge 工作树 `git status --short` 为空，验证过程未修改该仓库。桌面当前安装的旧插件 Host 仍不是此次构建产物，未据此声称线上 Host 已更新。

### 2026-10-15 d-simu 多跳影响评测

之前的评测器把 depth=1 impact 与直接 callers 使用同一组期望节点，无法单独证明多跳影响链。本轮新增独立 `impact_cases` 金标与多跳 precision/recall、目标命中和截断指标；评测继续从 Craft 只读 checkpoint 索引出发，不写入外部仓库。d-simu 的 `CustomerServiceAgent` 两跳 incoming calls 金标覆盖 `_create_customer_service_agent` 与其生产调用方 `__init__`。复现：`node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts /Users/didi/Documents/project/eval-all/d-simu --suite scripts/eval/suites/d-simu.json`。结果：12 条检索任务 MRR 0.753、Recall@5 1.00；直接 call graph precision/recall 1.00；独立两跳 impact precision/recall 1.00、目标命中、无截断，评测通过。d-simu 索引仍为 `partial`，有降级语言及未解析 call/import/relation，故该结果只证实标注链路，不证明全仓图完整。

再在 d-forge Java 集加入 `dataDetail` 的 outgoing/calls depth=2 金标：源文件中 `dataDetail` 调用 `JsonUtils.string2Obj`，后者调用 `getObjectMapper`；depth=1/2 图差分及两处源码均确认第二跳。该闭包的 10 个唯一 path/name 目标 precision/recall 均为 1.00、无截断、目标命中；全仓索引 1,112 文件仍为 `partial`。3 条 Java 检索任务 MRR 0.667、Recall@5 1.00，直接调用金标 precision/recall 1.00。新增 impact 评测指标模块的行/分支/函数覆盖均为 100%，全仓 TypeScript 编译器直接检查通过；pnpm 包装命令因 registry 不可达和 no-TTY 安装状态检查中止。Python 入向与 Java 出向两个真实仓库方向的样本改善了语言/方向覆盖，但数量仍不足以证明全仓图完整、真实 Codex/Claude Host 行为或与参照项目同条件 parity。

对 impact 边预算做边界审查后，发现旧实现把 `selected_edges.length === limit` 当成必然截断，即使查询深度内没有剩余边也会误报。现改为仅在发现第 `limit+1` 条唯一可达边时标记截断，并在有剩余深度时探测下一层。回归覆盖：最终请求深度恰好填满预算但没有更多边时 `truncated=false`；相同预算若下一请求层仍有边，或预算少一条，则 `truncated=true`。149 项 `craft-codebase` 覆盖门禁全过，受门禁文件行/分支/函数覆盖均为 100%；`node node_modules/typescript/bin/tsc --noEmit` 通过。修复后 d-simu 与 d-forge 外仓套件均复跑通过，直接调用和两跳 impact 金标保持 1.00，且均未截断；两个外部仓库工作树未被修改。

### 2026-10-15 多语言检索分层与参照现状复核

检索报告过去只给跨语言汇总，容易让单一语言的高分遮住另一语言回归。新增按源扩展名分层的 MRR、Recall@5、`symbol_explore` MRR/Recall@5、默认候选覆盖和 checkpoint 摘要校验读取率，指标本身行/分支/函数覆盖均为 100%。d-simu 加入两条基于 `eval_platform_frontend/src/pages/ConversationViewer.jsx` 源码审核的 JavaScript Agent 任务，与 12 条 Python 查询同批评测：Python 12 条、JavaScript 2 条，各自 Recall@5、默认候选覆盖、源码读取验证率均为 1.00；汇总 MRR 0.752、Recall@5 1.00，索引仍为 `partial`。d-forge 3 条 Java 任务单独报告 MRR 0.667、Recall@5 1.00，默认候选覆盖和源码读取验证均为 1.00；图仍为 `partial`。这证明所列 Python/JavaScript/Java 任务的分层表现，不证明语言总体性能或跨仓泛化。

2026-10-15 再核对官方主分支资料：Serena v2.0（2026-10-13）加入供 Agent 调用的 REPL 接口，同时强调可信项目边界；GitNexus 当前 changelog 描述 opt-in 多语言 PDG/CFG、跨过程 impact 与 mutation-oracle 校验；CodeGraph 文档提供 intent-aware `get_ai_context` 与 `core`/`graph` MCP 工具 profile，以控制 Agent 上下文工具面。上述是维护者功能声明，不是统一精度比较。Craft 可借鉴的在范围实践是按任务控制工具上下文、增加跨语言语义与 PDG 深度、为模型路径做端到端任务评测；其产品边界仍保持只读 checkpoint、用户明确授权的 LSP、摘要与 `partial` 证据披露，不因 REPL/IDE 产品形态引入代码编辑执行。[Serena v2.0 changelog](https://github.com/oraios/serena/blob/main/CHANGELOG.md)、[GitNexus changelog](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/CHANGELOG.md)、[CodeGraph tool guide](https://github.com/codegraph-ai/CodeGraph/blob/main/docs/tool-calling-guide.md)。

本机真实 Go 仓库 `inte/is-manager` 有 825 个 `.go` 文件，但系统没有 `go`/`gopls`；当前可访问项目树没有 Swift 源文件，C/C++ 候选只落在已排除的 vendored Python venv 中。因此本轮没有把环境无法提供工具链的语言记为通过。下一步应准备可审计的 Go LSP 实际仓库验证（或建立明确的工具链可用条件），并继续补充按语言分层的 callers/impact 与增量一致性金标，再验证实际 Codex/Claude MCP Host 分发产物。

### 2026-10-15 Go LSP 调用图外仓验证

在 `/private/tmp` 临时提供经校验的 Go 1.27.2 与 gopls 0.23.0，没有全局安装工具；使用用户显式提供的 trusted LSP adapter，只向服务器发送 Craft 已选取并写入临时目录的只读 checkpoint。`relation_symbol_limit` 新增 1–500 配置（默认 100）；采样按文件轮转，并在请求 calls 时优先函数/方法，避免前置大文件耗尽关系查询预算。排序查询增加 `constructor -> new/create/make` 代码术语别名。

`scripts/eval/suites/is-manager-go.json` 对真实仓库 `inte/is-manager` 固定两个任务式检索目标、一个直接调用金标和一个 depth=1 incoming impact 金标。可复跑命令：`node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts <repo-root> --suite scripts/eval/suites/is-manager-go.json --lsp-config <trusted-lsp-config>`；本次 adapter 显式限定 `relations: ["calls"]`、`max_documents: 500`、`relation_symbol_limit: 500`、120 秒单请求超时，并令 Go/gopls 所需工具链目录进入进程 PATH。评测通过：485 个源文件、MRR 0.75、Recall@5 1.00、symbol_explore MRR 0.75/Recall@5 1.00、默认候选覆盖和摘要校验后的源码读取均为 1.00；`NewDelegateAuthChecker` 的两个真实调用方 `SsoAuth`、`SsoLoginAuth` 均命中，直接调用与 depth=1 impact 的 precision/recall 均为 1.00。导入 1,608 条 calls 边，整体关系状态仍为 `partial`，诊断包含未查询符号和请求失败；不代表 825 个 Go 文件的完整关系覆盖。外仓未被修改。此前“无 Go 工具链”的记录只描述当时默认环境，本次临时工具链验证更新了这一状态。

新增 Go LSP 快照边界回归：超出 512 KiB 的 `go.sum` 不会写入临时分析目录，索引回执会在 `degraded_languages` 明确给出 `workspace_context_file_omitted` 和省略数；分析回调期间修改 `go.mod` 会在索引发布前报 `Go workspace context changed during snapshot analysis`，确认没有生成索引，随后使用新快照可正常重试。另增加缓存证据测试：伪造持久化 `cached_symbols_digest` 会使该文档缓存被拒并重算，Java 与 LSP 删除源文件后各自清理陈旧文件单元；不完整 TS 增量单元会全量回退，Java 预算受限图会保持 `partial` 且不写缓存，并发 ensure 会复用竞争者已发布的索引。LSP worker 入口缺失现在明确报告 `worker_unavailable`，另以 CommonJS fixture 验证非 `.ts` worker 启动路径。

将临时 LSP 快照写入及 Go 上下文摘要校验抽为 `lsp-snapshot-files.ts`，越界文件路径和摘要不匹配都有直接用例，并新增独立覆盖组。`tests/repository-context.test.ts` 52 项全部通过；`repository-onboarding.ts` 行、分支、函数覆盖均为 100%，LSP 快照写入模块单独门禁行、分支、函数覆盖也均为 100%。`tsc --noEmit` 和 `git diff --check` 通过。工作区全局 Coverage Inventory 仍标记 incomplete，缺口包含此前已有的模块；该状态不改变本轮两个 Codebase 模块的定向覆盖结果。以上用例证明快照、降级及增量缓存边界，不扩大真实 Go 仓全量关系完整性的结论。

### 2026-10-15 Codex Context MCP 主机版本差异

通过当前连接的 Craft Context MCP `craft_info` 实测，桌面主机运行 Craft 0.12.42，数据根为 `~/.craft_data`；该主机对当前 checkout 调用 `craft_codebase_repository_ensure` 返回 `TypeScript graph exceeds import budget`，`craft_context_open` 将 Codebase 标为 `unavailable / repository_index_failed`。同一 checkout 当前源码/插件清单为 0.12.43。隔离临时 `CRAFT_DATA_DIR` 后，以 checkout 内 0.12.43 `plugins/craft-context/dist/plugin/craft-mcp.cjs` 经 MCP `initialize → tools/list → craft_context_open` 对完整仓库验证，返回 Codebase `ready`、一个 Codebase 引用；索引为 763 个支持文件、50,560 个节点、87,129 条边，未变仓库的后续 ensure 在 442 ms 复用原索引。图仍是 `partial`，并明确报告不支持语言、快照文件省略、图预算和查询预算状态。

该对照证明当前 checkout 的 0.12.43 打包 MCP 能在本仓库完成 Agent Context 路径；它没有证明桌面主机 0.12.42 的失败只由版本差异造成，因为桌面主机还使用独立的既有数据根。尚未更新安装中的 MCP，也未确认桌面 Host 更新后通过；需在发布/安装边界单独完成复验。

### 2026-10-15 Go LSP 结果复核与工具链缓存边界

复跑前序 `is-manager-go` 套件时发现，临时工具目录中的 Go 可执行文件实际位于 `/private/tmp/craft-go-toolchain/go/bin/go`，且宿主默认 `GOPATH=/Users/didi/go`、`GOMODCACHE=/Users/didi/go/pkg/mod`、`GOCACHE=/Users/didi/Library/Caches/go-build` 指向本机不存在且沙箱不可创建的目录。只把 gopls 的 `bin` 放进 `PATH` 时，gopls 返回 `no views`，索引把 Go 标成 `analysis_failed`。同时提供 Go 与 gopls 路径但仍使用默认缓存目录时，符号索引可产出 485 个 Go 文件，然而 500 个 call hierarchy 准备请求均报告无 package metadata，关系边为 0，caller/impact 金标失败。

为 Go 构建缓存和模块缓存指定可写的临时目录（`GOCACHE=/private/tmp/craft-go-cache`、`GOPATH=/private/tmp/craft-go-gopath`），并将 Go 与 gopls 两个目录都加入 `PATH` 后，从全新临时 CraftStore 复跑原套件，历史结果得以复现：485 个源文件、MRR 0.75、Recall@5 1.00、默认候选覆盖和摘要校验源码读取均为 1.00；`NewDelegateAuthChecker` 的两个真实调用方 `SsoAuth`、`SsoLoginAuth` 均命中，直接调用及 depth=1 impact precision/recall 均为 1.00，导入 1,608 条 calls 边，评测通过。此次复跑不需要改动产品代码或外部仓库。

整体关系状态仍为 `partial`，因为受预算未查询符号及部分 LSP 请求失败仍有诊断。另用同一临时 GOPATH 执行 `go list ./...` 时，私有模块下载仍因沙箱 DNS 无法连接 `proxy.golang.org` 而失败；这说明包列表全量加载不完整，但不妨碍本套件的局部 caller/impact 金标在可写缓存配置下通过。复现命令必须同时记录 `PATH`、`GOCACHE`、`GOPATH`、`GOPROXY` 和 adapter 配置；仅记录 gopls 二进制版本不足以保证关系评测可复现。

### 2026-10-15 大图摘要的流式摘要计算

当前 Craft 自索引 2 轮基准复现 737 个 TS/JS 文件、49,310 个节点和 89,930 条边。CPU 采样显示，Codebase import 会为 analyzer 输入、邻接路由反复构造完整 canonical JSON 字符串，形成主要 CPU/GC 热点。新增 `stableDigestStreaming`，逐块输出与现有 `canonicalJson` 字节完全相同的 UTF-8 序列；将它用于大 analyzer 输入身份和内容寻址邻接路由。索引格式、digest 结果和外部查询契约不变。

摘要模块金标（含未定义值、嵌套数组、中文/emoji 与 257 种对象形状）通过，`digest.ts` 行/分支/函数覆盖均为 100%；Codebase 索引专项 162 项测试通过，`codebase-index.ts` 行/分支/函数覆盖均为 100%，`tsc --noEmit` 通过。更新后两轮 clean rebuild 的图 digest 均与增量索引完全相同；单文件更新中位 5.52 秒、全量 10.27 秒，提速约 1.86 倍；索引持久层每轮新增 16/50 条记录，而全量分别新增 1,003 条。

两轮耗时受本机负载和被测文件集影响，不能据此声称流式摘要提升了更新时间；上轮 735 文件基准提速 1.95 倍，本轮文件集有变化且耗时未改善。该改动避免为摘要再保留整份 canonical 表示，但本轮未测量真实峰值内存；后续应加入相同快照下的可重复峰值 RSS/heap 评测，并继续定位图导入、路由生成和索引持久化中仍占主导的成本。源代码和图查询仍受只读 checkpoint、摘要校验及 `partial` 关系覆盖约束。

### 2026-10-15 多语言搜索上下文预算与评测来源锁定

新增 JavaScript `ConversationViewer.jsx` 两条真实仓库任务检索后发现，原始搜索上下文提取按路径顺序消费全局 2M 字符预算，后续文件的函数体标识符可能没有进入临时搜索语料。现将预算按可检索文件和主要声明（函数、方法、类、接口、类型、枚举）均分；仍只从摘要校验的 checkpoint 声明中提取代码标识符，临时用于 BM25，不保存或返回源码正文。TS checker 还把函数/箭头函数值声明标为 `function`，并将缓存 schema 从 `craft-ts-semantic-v4` 升到 v5，避免把 `const handler = () => ...` 误作普通变量。

外仓检索报告现在附带目标仓 Git revision/dirty 状态及改动摘要、评测集 SHA-256、checkpoint 清单摘要、图 manifest 摘要、analyzer 版本、可选 LSP 配置摘要和 Node 版本。摘要只包含 hash 与版本元数据，不含源码。外仓套件复跑发现 d-forge 原两跳 impact 金标把未被 `dataDetail` 调用的 `DForgeContextInfoHolder.getUserInfo` 记为期望节点，漏掉实际调用链 `JsonUtils.string2Obj -> JsonUtils.getObjectMapper`；对照当前只读源快照修正金标后，Java 两跳 precision/recall 恢复 1.00。三个外仓 Git 工作树保持干净；Craft checkout 本身 dirty，报告中的 `change_digest` 标识具体改动状态。

当前四语言评测复跑：TS 自仓 763 个入选源文件，14 条 TS 查询 MRR 0.943、Recall@5 1.00、默认候选覆盖和摘要校验源码读取 1.00；另有 1 条 Python 查询。d-simu 485 个入选文件，Python 12 条 MRR 0.753、JavaScript 2 条 MRR 0.267，二者 Recall@5、默认候选覆盖和源码读取均为 1.00；直接调用与两跳影响金标 precision/recall 均为 1.00。d-forge 1,117 个文件、3 条 Java 查询 MRR 0.667、Recall@5 1.00，直接调用和两跳 impact precision/recall 均为 1.00。`inte/is-manager` 485 个 Go 文件、2 条 Go 查询 MRR 0.75、Recall@5 1.00，调用方及 incoming impact precision/recall 均为 1.00；复跑显式固定 Go 1.27.2/gopls 0.23.0、`PATH`、临时 `GOCACHE`/`GOPATH`/`GOMODCACHE`、`GOPROXY=off` 和 LSP 配置摘要。四个索引的关系状态仍为 `partial`，小样本金标只证明列出的任务，不代表全仓关系完整或竞品同条件 parity。

复现：TS `node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts <craft-checkout>`；Python/JS `node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts <d-simu-checkout> --suite scripts/eval/suites/d-simu.json`；Java 对应 `d-forge-java.json`；Go 对应 `is-manager-go.json --lsp-config <trusted-config>`，并设置上述工具链变量。评测 JSON 中的 revision、suite、checkpoint 和 graph digest 用于逐次核对输入/输出身份。

### 2026-10-15 英文 Agent 动作词检索排序回归

四语言外仓复评发现新增的两条 d-simu JavaScript 任务查询排名偏后：`normalizeRow` 排名 3，`buildSimulatedDialogue` 排名 5，主要干扰项分别来自同文件的对话分组符号和 Python user-agent 符号。检索器现在在原 BM25、名称/路径权重之外，对查询动作词与函数/方法名中的动作词重合增加独立加分；对 `create/build/run/start/execute/call` 等泛化动作词，只有符号名同时覆盖至少两个非泛化任务词才给额外加分，降低“创建工作区”类动作词压过 `checkpoint` 等目标概念的风险。补充 `combine → build/merge`、`simulated → simulate/simulation`、`dialogue → conversation/chat` 有限别名。没有按语言过滤候选，也没有把依赖关系数量当作相关性分数。

在同一 485 源文件 d-simu checkpoint 和原 14 条任务查询上复跑，JS 两条金标由 3/5 升至 1/2，JS MRR 从 0.267 升至 0.75；Python MRR 保持 0.753。总 MRR 从 0.683 升至 0.752，Recall@5 保持 1.00，默认候选覆盖、摘要校验源码读取均为 1.00；直接调用及两跳影响金标 precision/recall 均为 1.00，评测通过。泛化动作词精确重合须同时覆盖至少两个非泛化名称词，否则不额外加分；该约束避免了“workspace create immutable checkpoint”评测中无关 `create*` 函数抢占精确目标并导致门禁失败。对相邻查询短语加分的实验虽能把第二条 JS 金标推至第 1 位，却把 Python `extract_parameters` 从第 2 位降至第 6 位且未提高总 MRR，因此已撤回；当前实现保留动作词信号，不保留该短语加分。

检索上下文模块 10 项测试行/分支/函数覆盖均为 100%，`tsc --noEmit` 通过。结果只适用于这组 2 条 JS 和 12 条 Python 手工金标；关系图仍为 `partial`，不声称泛化或全仓完整性。当前桌面 Craft Context MCP 仍由 0.12.42 bundle 提供，真实 Host 调用可复现旧 10,000 节点/20,000 边限制；本地 0.12.43 源码包与该 Host 运行时不是同一分发物。

### 2026-10-15 面向 Agent 的语言范围与复评

范围按产品使用者收敛为 Codex、Claude 等 Agent：本能力负责多语言符号语义、检索、调用图/影响查询、增量更新和 MCP/Skill 接入；不把 Cursor 等人工编辑器体验、代码编辑或重构列作目标验收项。当前真实仓库检索验收语言为 TS、Python、Java、Go。只读 checkpoint、摘要校验读取、来源回执、预算上限及关系完整性如实标记继续作为硬边界。

用 `scripts/eval/codebase-retrieval-evaluation.ts` 和固定 suite 对四个真实仓库复评，四份报告的目标仓库 revision 均干净；每次报告也固定了 suite、checkpoint 与 graph manifest 摘要。Craft checkout 在评测期间持续变化，因此四份 `craft_revision.change_digest` 不同，以下结果各自对应独立代码快照，不合并声称为同一源码版本：

| 语言/语料 | 文件数与查询 | 检索结果 | 关系金标 | Craft change digest |
|---|---:|---|---|---|
| TS：Craft 仓库 | 769 个文件；14 条 TS 查询，另 1 条 Python 查询 | TS MRR 0.943、Python MRR 1.00；Recall@5、候选覆盖、摘要校验读取均 1.00 | 调用、直接影响、两跳影响 P/R 均 1.00；图状态 `partial` | `429d1d61…` |
| Python：d-simu | 485 个文件；12 条 Python 查询 | MRR 0.753；Recall@5、候选覆盖、摘要校验读取均 1.00 | 调用、直接影响、两跳影响 P/R 均 1.00；图状态 `partial` | `1410280e…` |
| Java：d-forge | 1,117 个文件；3 条 Java 查询 | MRR 0.667；Recall@5、候选覆盖、摘要校验读取均 1.00 | 调用、直接影响、两跳影响 P/R 均 1.00；图状态 `partial` | `6da999a5…` |
| Go：inte/is-manager | 485 个文件；2 条 Go 查询 | MRR 0.75；Recall@5、候选覆盖、摘要校验读取均 1.00 | 调用、直接影响、两跳影响 P/R 均 1.00；图状态 `partial` | `e76f319e…` |

四份评测均 `evaluation_pass=true`。Go 使用固定配置摘要 `26aa8e11…`、`gopls 0.23.0` 和 Go `1.27.2`，并关闭模块代理下载。样本量分别只有 14、12、3、2 条检索金标；关系 P/R 只表示 suite 列出的边，不证明整个仓库完整或与 Serena/GitNexus/CodeGraph 同条件 parity。复跑入口见上文；应以报告中的 suite SHA-256、目标仓库 revision、checkpoint manifest digest、graph manifest digest、analyzer 版本和 Craft change digest 识别结果。

同日补齐索引边界专项覆盖：将独立 `codebase-context-projection.test.ts` 与 Codebase、仓库增量及语言分析相关用例纳入覆盖命令，共 163 项通过；`capability/craft-codebase/codebase-index.ts` 行、分支、函数覆盖均为 100%。新增导入边界用例验证格式/体积/节点边数量限制、分析器身份、最新 checkpoint、快照路径、摘要、span、节点 ID 与关系端点校验，失败输入不发布索引。

### 2026-10-15 检索排序同快照 A/B

为消除工作树并发编辑对比较的影响，将同一冻结源码树复制成排序基线与候选快照；两边除 `capability/craft-codebase/context-search.ts` 外字节相同。基线撤销本轮完整标识符/构造器加权与 `authentication → auth` 别名；候选 commit 为 `7758d2884ec1e5734643589265498db21873cd56`。四个候选报告均记录该 commit、`dirty=false`；suite SHA、目标仓库 revision、checkpoint manifest 与 graph manifest 固定。基线报告记录合成 Git revision `ef89ed5ceb1c73cb49893a5164641975ceb7f54e` 和工作树 patch digest `c32b6823…`。TS 的两套查询分别是 Craft 自仓 14 条 TS + 1 条 Python，以及 d-simu 12 条 Python + 2 条 JavaScript；用户确认的产品目标 TS/JS、Python、Java、Go 均有覆盖。

| 真实仓库与指标 | 基线 | 候选 | 具体变化 |
|---|---:|---:|---|
| Craft TS 自仓，15 条查询 | MRR 0.947，Recall@5 1.00 | MRR 1.00，Recall@5 1.00 | `checkpoint` 第 5 → 第 1；15/15 金标均第 1 |
| d-simu Python/JavaScript，14 条查询 | MRR 0.752，Recall@5 1.00 | MRR 0.752，Recall@5 1.00 | Python 与 JS 排名不变；`run_task` 仍第 5 |
| d-forge Java，3 条查询 | MRR 0.667，Recall@5 1.00 | MRR 0.833，Recall@5 1.00 | `dataDetail` 英文查询第 2 → 第 1；中文查询仍第 2 |
| inte/is-manager Go，2 条查询 | MRR 0.75，Recall@5 1.00 | MRR 1.00，Recall@5 1.00 | `NewDelegateAuthChecker` 第 2 → 第 1 |

候选四份报告均 `evaluation_pass=true`；直接调用、直接影响与两跳影响金标 precision/recall 均为 1.00，索引关系覆盖继续报告 `partial`。检索改动只带来 TS 自仓、Java 和 Go 的小样本排序增益，d-simu 保持原样；不能据此宣称普遍准确率提升。完整标识符加权只识别查询中的 camelCase/PascalCase 名称；普通词命中受常见代码词表抑制。构造器加分需要显式出现 `constructor`，符号为 `New…` 函数，并匹配至少两个查询实体词。

本轮 `context-search.ts` 专项 11 项测试行/分支/函数覆盖均为 100%，`tsc --noEmit` 通过。重跑命令：`node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts <repository> [--suite scripts/eval/suites/<suite>.json]`；Go 另带 `--lsp-config <trusted-config>` 和固定工具链环境。套件 SHA-256 依次为 TS `e849ac60…`、d-simu `07b03ad1…`、Java `cf85eab2…`、Go `26a4d845…`；复跑应比较源码 revision、suite、目标仓库 revision 与图摘要，不以编辑器或 Host 版本替代源码评测。

### 2026-10-15 显式类名与方法名的混合查询

上一轮四语同快照评测中，Java 查询 `DataWorkflowServiceImpl dataDetail 工作流详情按 key 和版本查询` 把实现类排在 `dataDetail` 方法之前；英文查询因更多词汇上下文碰巧将方法排第 1。增加窄排序信号：当查询同时包含 PascalCase 容器标识符和 lowerCamelCase 方法标识符时，精确命中的方法获得 48 分；只查询类名时仍由精确类名优先。合成单测覆盖两种输入，检索模块行、分支、函数覆盖保持 100%。

同一固定 suite 重跑四个真实仓库。评测器此前在工作树 Git diff 超过 Node `execFileSync` 默认 1 MiB 缓冲区时会吞掉异常并把 Craft revision 记成 `null`；现在 Git revision/status/diff 调用共用 32 MiB 上限，且回归测试以 2 MiB tracked diff 证明 dirty digest 可继续产出。四份新报告的 Craft revision 均为 `646e55e32add6188d2f054be272646056701ac2a`、dirty change digest 均为 `4822e4c7e278e87938a79e23a7093b872cfa3fed2ff1d3904d41b296c375e01b`，并记录目标仓库 revision、suite SHA、checkpoint manifest 与 graph manifest：

| 语料 | 文件数/查询 | MRR / Recall@5 | 变化与关系金标 |
|---|---:|---:|---|
| Craft TS/JS 自仓（另含 1 条 Python 查询） | 766 / 15 | 1.00 / 1.00 | 15/15 金标第 1；直接调用及两跳影响 P/R 均 1.00 |
| d-simu Python/JS | 485 / 14 | 0.752 / 1.00 | 与上轮排名一致；直接调用及两跳影响 P/R 均 1.00 |
| d-forge Java | 1,117 / 3 | 1.00 / 1.00 | 中英混合 `dataDetail` 第 2 → 第 1，3/3 金标第 1；直接调用及两跳影响 P/R 均 1.00 |
| inte/is-manager Go | 485 / 2 | 1.00 / 1.00 | 2/2 金标第 1；直接调用及影响 P/R 均 1.00 |

四份报告均 `evaluation_pass=true`。suite SHA-256 分别为 TS `e849ac60…`、d-simu `07b03ad1…`、Java `cf85eab2…`、Go `26a4d845…`；Go 使用固定 LSP 配置 SHA `26aa8e11…`、gopls 0.23.0、Go 1.27.2 和关闭模块代理的临时工具链环境。报告 JSON 保存在本次运行的 `/private/tmp/craft-eval-rerank9-{typescript,d-simu,d-forge,go}.json`。索引关系覆盖在四个仓库仍均为 `partial`，人工金标样本仍小，不据此推断完整仓库覆盖或竞品同条件 parity。

评测 provenance 修复专项 2 项测试全过，行、分支、函数覆盖 100%；检索模块 11 项测试全过，行、分支、函数覆盖 100%；`tsc --noEmit` 通过。用更新源码重新打包 `craft-mcp.cjs` 后，所有发布组件均完成 MCP initialize、tools/list、tools/call smoke。当前桌面 Host 对该仓库的 Codebase 仍返回 `unavailable / repository_index_failed`；本地发布组件 smoke 不替代安装后的 Host 复验。

### Codex Host 旧 MCP 的图预算故障复核

本轮经连接中的 `craft_info` 再次确认 Codex 桌面 MCP 为 0.12.42，数据根 `~/.craft_data`。同一 Host 对当前仓库的 `craft_context_open` 仍返回 `codebase=unavailable / repository_index_failed`，直接 ensure 返回 `TypeScript graph exceeds import budget`。只读检查该 Host 缓存的 0.12.42 bundle，确认其导入边界仍是 10,000 节点或 20,000 条边；当前源码 0.12.43 使用 60,000 节点、150,000 边与 64 MiB 持久化预算，并将图分片。因此这个现场错误来自正在运行的旧 bundle，当前证据不支持把它归因于本轮 TypeScript analyzer。

验证 0.12.43 Agent 发布路径：`scripts/smoke/dsh-codebase-smoke.ts` 在 `craft-codebase` 和 `craft-context` 两个 MCP 面上均成功导入超过 10,000 节点、20,000 条边的测试图；Codex/Claude Context 发布 bundle 对当前完整 Craft checkout 的隔离数据目录实测返回 `serverInfo.version=0.12.43`、Codebase `ready` 和 checkpoint 回执，同时报告 68 个 omitted files。该成功不代表完整文件覆盖或关系完整；评测与图覆盖状态仍应保持 `partial`。已安装的 0.12.42 插件缓存未修改，桌面 Host 升级后的真实调用仍待复验。

### 2026-10-15 四语言真实仓库增量复核

为把增量验收从合成 fixture 推到真实源码快照，本轮在隔离副本中只追加注释，不改写 TS/Python/Go 外部仓库；以更新图摘要与 clean rebuild 一致作为正确性条件。

- **TS/JS：** Craft 自仓 736 个入选文件，2 轮分别重算 1 个和 8 个文件单元，复用 735 个和 728 个。两轮图均与 clean rebuild digest 完全一致；本次 2 轮中位更新时间 17.89 秒，对比 clean rebuild 24.19 秒，约 1.35 倍。此前同脚本同仓观察过更大的加速，因此这组时间受本机负载和样本选择影响，不当作稳定性能承诺。耗时拆分显示文件分析只用 69/231 ms，图导入为 14.84/9.20 秒、checkpoint 源校验扫描 736 个文件；后续性能工作应优先查看图导入/持久化。
- **Python：** d-simu 64 个 Python 文件中，单文件变更重算 3 个（变更文件及两个动态模块/已知导入闭包成员），复用 61 个；分析 201 ms，clean rebuild 1.424 秒，合并后的节点和边与 clean rebuild 完全一致。此前只要缓存内存在一个 `eval`、动态导入或星号导入模块就全仓回退。现在 planner 每个新 checkpoint 都把不安全模块及已知反向导入者放进重算集合，只对其余安全模块复用；动态图行为仍可能无法静态解析，关系完整性仍按实际 analyzer diagnostics 标为 partial。
- **Java：** d-forge 1,028 个 Java 单元均 `incremental_safe=false`；总计 914 个未解析调用和 461 个未解析导入。单文件变更计划因此返回 `unresolved_or_partial_java_graph` 并全量回退。当前证据说明 Java 增量缓存的保守门槛在该仓库没有实际节省，不应把测试 fixture 中的增量通过外推为真实仓库性能。
- **Go：** `inte/is-manager` 在隔离副本上使用固定 gopls 0.23.0/Go 1.27.2 与可写临时缓存。当前 adapter 配置最多分析 500 个文档，仍有 325 个 Go 文档明确省略。单文件更新命中 499 个文档符号缓存、1 个 miss；关系则按新 checkpoint 重查 993 个符号，关系结果保留 `partial`（11,300 次省略、471 次请求失败）。增量图 digest 与相同更新后 clean rebuild 一致。更新耗时约 16.61 秒，首建约 20.33 秒；这证明符号缓存和图正确性，不证明 Go 关系查询已增量化或全仓覆盖。

实现变更只涉及 Python planner：对动态模块用每 checkpoint 重分析替代全仓禁用增量；单元测试行/分支/函数覆盖均为 100%，仓库 Context 测试 53 项和 TypeScript 类型检查通过。TS、Python、Java、Go 的本次关系覆盖均不作全量保证；d-forge 的全量回退和 Go 的文档/关系省略仍是待优化项。

### 2026-10-16 四语言检索复评与 Go 文档上限

产品验收语言固定为 TypeScript/JavaScript、Python、Java、Go，使用者是 Codex、Claude 等 AI Agent。没有加入面向人工编辑器的 Cursor 工作流。下面的检索结果来自各自固定的真实仓库与 suite；Craft 工作树在多次运行间继续演进，所以每份报告各自绑定自己的 `craft_revision.change_digest`，不能把四份结果当成同一份 Craft 构建的联合指标。

| 语言与真实仓库 | 查询数 | MRR / Recall@5 | 调用与影响金标 P/R | 关系状态 |
|---|---:|---:|---:|---|
| TypeScript：Craft 自仓（另有 1 条 Python 查询） | TS 14 / Python 1 | TS 1.00 / 1.00；Python 1.00 / 1.00 | 直接调用、直接影响、两跳影响均 1.00 / 1.00 | `partial`，86,658 条边 |
| JavaScript + Python：`all-d-forge/d-simu` | JS 2 / Python 12 | JS 1.00 / 1.00；Python 0.7875 / 1.00 | 直接调用、直接影响、两跳影响均 1.00 / 1.00 | `partial`，13,272 条边 |
| Java：`d-forge` | 3 | 1.00 / 1.00 | 直接调用、直接影响、两跳影响均 1.00 / 1.00 | `partial`，10,844 条边 |
| Go：`inte/is-manager` | 2 | 1.00 / 1.00 | 直接调用、直接影响、两跳影响均 1.00 / 1.00 | `partial`，8,167 条边 |

四份报告均 `evaluation_pass=true`，但检索 gold 数量很小，只能作为固定样本的回归验收。Java analyzer 仍报告 100 个 compiler errors、914 个未解析调用和 461 个未解析导入；d-simu 的 Python analyzer 报告 24,277 个未解析调用和 1,451 个未解析导入。关系 P/R 仅衡量 suite 明确列出的金标边，不证明仓库完整覆盖，也不构成对 Serena、GitNexus 或 CodeGraph 的同条件比较。

Go 配置将 `max_documents` 从 500 提高到 1,000，与 stdio 客户端上限统一。使用 gopls 0.23.0、Go 1.27.2 和离线工具链，在 `is-manager` 实际观察到 825 个文档，没有 `document_limit` 省略；关系图从先前 7,429 条边增加至 8,167 条。该索引仍有 17,382 项关系省略和 435 次 relation 请求失败，所以保持 `partial`。Suite SHA-256 为 `26a4d84595c6c5cf9affcbe9ec8dd8ecd07f6d3210a765df7713a1e98bc712be`，Go LSP 配置 SHA-256 为 `632eba63290e868c47faddfde847c7d055edbc3fc7989e6ff244ba54b3da88f9`。

可复跑入口：

```sh
node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts \
  /Users/didi/Documents/work/my-craft/craft

node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts \
  /Users/didi/Documents/project/all-d-forge/d-simu \
  --suite scripts/eval/suites/d-simu.json

node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts \
  /Users/didi/Documents/project/d-forge \
  --suite scripts/eval/suites/d-forge-java.json

PATH="/private/tmp/craft-go-toolchain/go/bin:/private/tmp/craft-go-gopath/bin:$PATH" \
GOPATH=/private/tmp/craft-go-gopath \
GOROOT=/private/tmp/craft-go-toolchain/go \
GOMODCACHE=/private/tmp/craft-go-gopath/pkg/mod \
GOCACHE=/private/tmp/craft-gocache \
GOPROXY=off GOTOOLCHAIN=local \
node --experimental-strip-types scripts/eval/codebase-retrieval-evaluation.ts \
  /Users/didi/Documents/project/inte/is-manager \
  --suite scripts/eval/suites/is-manager-go.json \
  --lsp-config /private/tmp/craft-gopls-config-900.json
```

每次复跑都应留存 JSON 报告，检查 `provenance` 中的目标仓库 revision、Craft change digest、suite SHA、checkpoint/graph manifest digest、analyzer 版本和关系 coverage。Go 报告中 `observed_document_count=825`；图状态仍 partial。当前桌面 Host 的 `craft_context_open` 对该 checkout 返回 `codebase=unavailable / repository_index_failed`，因此本地源码评测不代表已安装 Codex/Claude Host 的集成验收；Host 使用的旧组件与源码发布包仍需分别验证。

### 2026-10-16 Java 单元级增量复核

修正 Java 增量缓存把仓库级 javac 错误应用到所有文件的问题。分析器按诊断来源路径记录编译/语法错误；来源无法映射回 checkpoint 文件时仍将所有单元标为 unsafe。规划器每个新 checkpoint 都重算 unsafe 单元及已知反向依赖和同包闭包，其他单元只有在 checkpoint digest、unit digest 和本地安全状态均通过时才复用。增量结果需返回完整 affected 单元且未超预算；局部编译错误可保留为 partial 事实，不再触发全仓第二次分析。`compiler_errors` 和 `syntax_errors` 现在会使 relation summary 明确为 `partial`。

在干净 d-forge commit `a545bdab10a1ea1516161054de581535b5a43aaa` 的 1,028 个 Java 文件隔离副本上运行真实增量验证：首建得到 705 个 safe 单元、323 个 unsafe 单元以及 100 个 javac compiler errors。对 safe 文件 `d-forge-api-server/src/main/java/com/xiaoju/uemc/dforge/aspect/OperatorMetric.java` 追加注释后，增量图重建 795 个单元、复用 233 个单元；原仓库未被修改。增量与同一变更快照的 clean rebuild 图摘要完全一致：`sha256:9e144fce25b704941024a89d2c0e74869d677b1b6abd8c3aca796041ce975185`。关系状态仍 `partial`，包含 `compiler_errors`、`unresolved_calls` 和 `unresolved_imports` 原因。

计数口径显式区分：`compiler_input_file_count=1028`，而 `graph_unit_rebuild_count=795`、`graph_unit_reuse_count=233`。javac 仍对全快照执行 parse/attribution，故本次只证明减少图单元关系提取与持久化范围，不声称 javac 全快照编译成本已随之下降，也没有测量性能加速比。

复跑命令：

```sh
node --experimental-strip-types scripts/smoke/codebase-java-incremental-real-repo.ts \
  /Users/didi/Documents/project/d-forge
```

该 smoke 会把 Java checkpoint 文件复制到临时 Git 工作树，使用临时 Craft 数据目录，追加一次受控注释，检查重建范围、safe/unsafe 分布和 clean rebuild 图摘要。最终复跑报告的源 revision 为上述 d-forge commit，源仓库干净；Craft revision 为 `646e55e32add6188d2f054be272646056701ac2a`，工作树 change digest `377334709c8d1d7a3b73c591d84dde3864b099ef9391b735cae9c031fa249cad`，checkpoint ID 为 `workspace_checkpoint_1989f76aecb54f228ec97e67ace55474`，checkpoint manifest digest `sha256:3320d252a960ac07d8fcfa7df31bf73d629860c3ad0c2c041d7fcded508d1b7b`。机器可读结果暂存于 `/private/tmp/craft-java-incremental-real-repo-final3.json`。若增量响应含无法归属的 javac 错误，接入层会全量重建；该故障路径也纳入集成回归。

同一 Craft 代码状态另用 `scripts/eval/suites/d-forge-java.json` 在原 d-forge 仓库复跑检索：3 条查询 MRR/Recall@5=1.00，直接调用、直接影响、两跳影响 P/R 均为 1.00，`evaluation_pass=true`。关系图保持 `partial`，并把 `compiler_errors` 列入原因。Suite SHA-256 为 `bad61553168147bfc78e00f5951711a963e2dc4025756a82a826d53ed00e458c`，graph manifest digest 为 `sha256:d91586095b5c2212f970be2f7c1657d2610e61203732d98098244f965e17e52f`，Craft change digest 为 `fc85ddb8f192044be60065ea11521b4b7c6ab83718300eb7c4cf965bb4afbe0f`；JSON 报告暂存于 `/private/tmp/craft-java-retrieval-eval-final3.json`。

Java analysis、Java incremental、repository onboarding 与关系 coverage 回归共 62 项通过；`java-incremental.ts` 和 `repository-onboarding.ts` 行、分支、函数覆盖均为 100%。`tsc --noEmit` 和 `git diff --check` 通过。Javac 对全快照的归属仍是后续性能工作；真实 Java 调用/导入关系目前也未达到完整状态。

### 2026-10-16 Codex/Claude MCP 包级多语言验收

扩充 `scripts/smoke/plugin-component-smoke.ts` 的隔离 Git 仓库夹具，使其同时包含 Python、TypeScript、Java。Codex/Claude 组件 MCP smoke 对 `craft-codebase` 与 `craft-context` 两个独立包执行 initialize、tools/list、tools/call，验证只读标记、checkpoint 回执、Python caller/impact 查询，以及 TypeScript 和 Java 专属符号的调用边检索；独立 Codebase 包还验证三个内建语言 analyzer 均由随包内容加载。整套组件 smoke 通过。`scripts/release/check-plugin-package.ts` 和 `scripts/release/check-plugin-version.ts` 也通过，包清单版本一致为 0.12.43。

可复跑命令：

```sh
node --experimental-strip-types scripts/smoke/plugin-component-smoke.ts
node --experimental-strip-types scripts/release/check-plugin-package.ts
node --experimental-strip-types scripts/release/check-plugin-version.ts
```

与源码包分开核对的当前桌面 MCP 现场仍是 0.12.42（`craft_info`，数据根 `~/.craft_data`）。该 Host 的工具目录未暴露包级 smoke 中验证的 `craft_codebase_symbol_explore` 等新入口；对当前仓库的 `craft_context_open` 返回 `codebase=unavailable / repository_index_failed`，直接 `craft_codebase_repository_ensure` 返回 `INTERNAL_ERROR / stage=dispatch`。因此目前证据证明 0.12.43 Codex/Claude 包可独立启动并完成多语言 Agent 查询，不证明当前已安装桌面 Host 已升级或接通；安装后需再用该 Host 重做现场 smoke。Go 由固定 gopls 真实仓库评测覆盖，未要求这组本地 MCP smoke 自带 gopls。

### 2026-10-16 Java 静态关系语义扩展

Java `jdk-compiler-tree` 分析器现在区分 `implements` 与 `extends`，并从 javac 已绑定的源码树符号补充 `references` 和 `type_definition`。类型关系包括方法返回类型、变量/参数类型与可解析类型标识符；引用边只在目标属于当前快照声明集合时生成，不把外部库猜成仓库内符号。Java 增量反向依赖闭包现覆盖 `imports`、`calls`、`references`、`implements`、`extends`、`type_definition` 六类边。新增测试也证明无关的 `contains` 边不会扩大失效闭包。

在干净 d-forge revision `a545bdab10a1ea1516161054de581535b5a43aaa` 上复跑固定 Java suite：3 条查询 MRR、Recall@5、symbol explore MRR/Recall@5 均为 1.00；直接调用图 P/R、直接影响 P/R 和两跳影响 P/R 均为 1.00，`evaluation_pass=true`。索引包含 1,045 个选中源文件、62,396 条边，关系种类为 `calls`、`extends`、`implements`、`imports`、`references`、`type_definition`。关系状态仍为 `partial`：javac 报告 100 个 compiler errors，另有 914 个未解析调用和 461 个未解析导入；报告也标记其他未支持语言及 unresolved relations。套件 SHA-256 为 `bad61553168147bfc78e00f5951711a963e2dc4025756a82a826d53ed00e458c`，graph manifest digest 为 `sha256:945b45e896ec127252a229378e0eee17167567ff35e57ea45dadeca3deb988d3`，Craft change digest 为 `271bdfd0e6874d0a44f9b43edc1aa31949092991976fc71b75ee2ad068b4489e`。机器报告位于 `/private/tmp/craft-java-retrieval-relations-final.json`。

真实仓库增量 smoke 在同一 1,028 个 Java 文件上确认：705 个安全单元、323 个不安全单元；改动一文件后重算 795 个图单元、复用 233 个，javac 输入仍为全部 1,028 个文件。增量图与 clean rebuild 的摘要均为 `sha256:1b2aa15e714fad7b86790f57852d6993c9d1bf4c8341bf533271af4c4dc44a83`。关系种类已包含上述六类，状态因 compiler errors 与未解析调用/导入继续为 `partial`。这证明关系图正确性与图单元复用，不证明 javac 全快照执行成本下降。报告位于 `/private/tmp/craft-java-incremental-relations-final.json`。

Java analyzer 源文件 SHA-256 为 `ab38e8f81a3d03bc239955d3df4220a9cac227f2de94735a544655fddfb093f7`；`craft-codebase` 与 `craft-context` 随包 analyzer 副本均与源码一致，两个 Codex/Claude 组件 MCP 的 initialize/tools-list/tools-call smoke 通过。Java analysis、incremental 与 repository context 共 62 项测试通过；`java-incremental.ts` 与 `repository-onboarding.ts` 的行、分支、函数覆盖均为 100%，`tsc --noEmit`、包完整性、插件版本和 `git diff --check` 均通过。桌面 Host 版本此前现场仍为 0.12.42，以上包级 smoke 不替代 Host 升级后的复验。

### 2026-10-16 四语言索引预算、评测修正与回归复跑

将单文件分析上限从 8 MiB 调到 12 MiB，并同步提升多语言合并、持久图和路由容量，策略版本升到 12。此前 Craft 自索引在旧预算下漏选 83 个 TS/JS 文件并丢弃 138,129 条关系；本轮重建选入 848 个文件、产生 257,273 条边、861 个图分片及 256 个路由分片，文件 omissions、unresolved-endpoint edge omissions、预算节点/边 omissions 均为 0。关系分析仍为 `partial`：831 个 TS 文件报告 74,494 个 unresolved relations；Python 报告 1,432 个 unresolved calls、64 个 unresolved imports；6 个 Java 文件报告 4 个 compiler errors 和 1,366 个 unresolved calls；另外少量 PS1、Shell、YAML 缺少语义 adapter。容量增加不等于支持仓库无上限；策略预算仍有界，超过预算须保留 partial 与省略计数。

入库分析和 checkpoint 发布之间若源摘要或 Go workspace 上下文发生变化，现在有一次有界重试，重试后仍不匹配则失败关闭。多语言诊断拆开 `unresolved_endpoint_edges` 与 `budget_omitted_edges`，避免把解析缺口误报为容量截断。评测也将直接调用图与影响遍历分开设金标，允许递归符号自身出现在直接调用边中、但不要求循环影响查询重复返回起点。

固定真实仓库 suite 的本轮结果如下。检索集是人工挑选的任务 query：15、14、3、2 条，因此只说明这些可复现样例通过，不代表大规模统计或与 Serena/GitNexus/CodeGraph 的同条件对比。

| 语料 | 选入源文件 / 查询 | MRR / Recall@5 | 关系边 / 状态 | suite SHA-256 前缀；graph manifest |
|---|---:|---:|---|---|
| Craft 自仓 TS/JS（另含一条 Python 查询） | 848 / 15 | 1.00 / 1.00 | 257,273 / `partial` | `5f90d042…`；`sha256:bce334984a9abb7d94f8561bd5239b67dfcc4201cc47636d119f8f43d54e596a` |
| `d-simu` Python/JS | 221 / 14 | Python 0.8542/1.00；JS 1.00/1.00 | 13,272 / `partial` | `5aa3791e…`；`sha256:1e71319f2aaf902688f27d50e7e94082492f1bab544e5db0f692160f88b53e57` |
| `d-forge` Java | 1,045 / 3 | 1.00 / 1.00 | 62,396 / `partial` | `bad61553…`；`sha256:945b45e896ec127252a229378e0eee17167567ff35e57ea45dadeca3deb988d3` |
| `inte/is-manager` Go + gopls 0.23.0 | 809 / 2 | 1.00 / 1.00 | 7,556 / `partial` | `26a4d845…`；`sha256:2a6157aa8aea9722a23cef8c549d3737b297aba12a8be5ff467eb33be6ee2086` |

四套 `evaluation_pass=true`；直接调用、直接影响和多跳影响金标的 precision/recall 均为 1.00。关系图仍不可宣称完整：TS/JS/Python/Java 有编译/分析降级或未解析调用、导入；Go provider 报告 partial，包含关系省略和查询失败。Go 报告还绑定 `lsp_config_sha256=632eba63290e868c47faddfde847c7d055edbc3fc7989e6ff244ba54b3da88f9`。机器结果在 `/private/tmp/craft-final9-ts.json`、`/private/tmp/craft-final6-dsimu.json`、`/private/tmp/craft-final6-java.json`、`/private/tmp/craft-final6-go.json`；其中每份 provenance 都记录目标 revision、suite digest、checkpoint/graph manifest、analyzer 和 Craft change digest。Go 用本地固定 Go toolchain/module cache 与 gopls 配置、`GOPROXY=off` 复跑。

验证：`multi-language-analysis.test.ts`、`craft-codebase.test.ts`、`repository-context.test.ts` 合计 102 项通过；对 `repository-onboarding.ts` 单独用 c8 测 `repository-context.test.ts`，语句、分支、函数、行覆盖均 100%。插件包完整性和版本检查通过，包版本为 0.12.43；Codex/Claude 组件 MCP smoke 随后复跑。桌面当前安装的 Craft Context MCP 此前仍为 0.12.42，且真实 Host 现场的 repository ensure 失败，因此包级通过不证明 Host 已升级。此次仅覆盖 AI Agent 的检索/图查询与 MCP 接口，不增加面向人工编辑器的 Cursor 类能力；只读 checkpoint、摘要与关系证据边界保持不变。

### 2026-10-16 Go LSP 关系省略可解释性与四语言 MCP 接入复核

Go 真实仓库固定评测使用 is-manager revision `febe297648986e85293ea6dab8d3a798812cab7f`、809 个 Go 文件和 suite SHA-256 `26a4d84595c6c5cf9affcbe9ec8dd8ecd07f6d3210a765df7713a1e98bc712be`。本轮复跑发现符号检索仍为 MRR/Recall@5=1.00，但调用边在环境未指向本地 Go module cache 时缺失；已有 `go list` 错误记录显示依赖下载因网络不可达失败。设置 `GOMODCACHE=/private/tmp/craft-go-modcache`、`GOPROXY=off` 后，同一只读 checkpoint、同一 gopls 0.23.0 和评测集通过，MRR/Recall@5 与直接调用、影响分析 Precision/Recall 均为 1.00。关系采样现在跨文件均匀铺开，并允许可信用户配置最多 1,000 个候选，默认预算仍为 100；超过预算的关系仍明确省略。

带完整关系请求的复评生成 12,488 条边，仍标 `partial`：642 次请求失败主要来自 Go 仓库上大范围调用 `implementation`/`typeDefinition` 的服务器错误，另有 17 条语言错误诊断；直接 calls/impact 金标仍为 P/R=1.00。Call-only 配置也独立通过目标调用/影响金标。关系 partial 代表提供商失败或预算省略，不应解释为空图或完整关系证明。复跑结果：`/private/tmp/craft-go-all-relations-cache-eval.json`；该固定 suite 仅含两条任务查询，不代表跨仓库准确率或 Serena/GitNexus/CodeGraph 同条件对比。

扩充 `scripts/smoke/plugin-component-smoke.ts` 的隔离仓库，新增有效 Go module 与源文件，通过用户数据目录中的显式可信 LSP 配置接入仅用于协议集成的 fixture；`craft-codebase` 和 `craft-context` MCP 均完成 Go symbol explore 与 `goAgentEntry -> goAgentTarget` 调用边查询，并保持只读标记及 checkpoint 收据。该 fixture 只证明 MCP/配置/回执接线，不证明 Go 语义正确性；后者由上面的真实 is-manager/gopls 评测验证。两个组件 MCP smoke、包完整性和版本一致性检查通过。`craft-mcp.cjs` 按仓库 build 命令参数构建后仅同步至这两个工作区插件包；没有改动已安装 Host 缓存。

四语言固定 suite 在同一工作树状态下复跑；每份结果都包含 Craft change digest、仓库 revision、suite 摘要和 graph manifest。目标仓库版本、suite 摘要、manifest 和指标如下。MRR/Recall 是固定的小型人工 query set，关系金标 precision/recall=1 不等于全图完整或与竞品同条件 parity：

| 语料 | 源文件/查询 | MRR / Recall@5 | 关系边 / 状态 | suite SHA-256 前缀；graph manifest |
|---|---:|---:|---|---|
| Craft 自仓 TS/JS（另 1 条 Python 查询） | 764 / 15 | 1.00 / 1.00 | 86,335 / `partial` | `e849ac60…`；`sha256:60828bdb45e479d0f393e268003e5c596a92f8452ded199b9ab5f0acfaf9b3c3` |
| `d-simu` JS/Python | 221 / 14 | JS 1.00/1.00；Python 0.8542/1.00 | 13,272 / `partial` | `5aa3791e…`；`sha256:1e71319f2aaf902688f27d50e7e94082492f1bab544e5db0f692160f88b53e57` |
| `d-forge` Java | 1,045 / 3 | 1.00 / 1.00 | 62,396 / `partial` | `bad61553…`；`sha256:945b45e896ec127252a229378e0eee17167567ff35e57ea45dadeca3deb988d3` |
| `inte/is-manager` Go | 809 / 2 | 1.00 / 1.00 | 12,488 / `partial` | `26a4d845…`；`sha256:fa235f3bed95af7dee808ae33ba127fd92503a78435c3d86169356553a025486` |

四份 `evaluation_pass` 均为 true；各 suite 的直接调用图、直接影响、两跳影响金标 P/R 均为 1.00。d-simu 检索新增动作冲突惩罚：查询包含明确动作意图，而符号名包含不匹配动作（如 `get` 与 `start`）时降低排序；未带动作名的目标不受罚。测试路径惩罚从 64 调至 88。d-simu Python MRR 从 0.7875 升到 0.8542，整套 MRR 从 0.8179 升到 0.875，Recall@5 保持 1.00；“启动仿真任务的 HTTP 接口”目标从第 5 升至第 1。剩余低排名包括同路径 method/class 候选与多个同名 decoder，后者应保留歧义，不按金标文件路径过拟合。所有真实仓库的关系状态仍为 `partial`：Craft 自仓图含 `analysis_budget_limited`、`omitted_edges` 和未解析关系等原因；d-simu Python 报告 24,277 个未解析调用及 1,451 个未解析导入；d-forge Java 有 100 个 javac 错误、914 个未解析调用和 461 个未解析导入。最终 JSON 位于 `/private/tmp/craft-goal-final-{ts,dsimu,java,go}.json`，四份记录同一个 Craft change digest 与各自的 checkpoint/graph manifest。

### 2026-10-16 Python checkpoint control-flow MCP

将 `craft_codebase_control_flow_query` 扩展到 Python 索引函数。`python-control-flow.py` 只接收一个 digest 校验过的 checkpoint 文档与符号身份，输出 bounded CFG 的块、边和 UTF-16 源位置，不回传源码，也不持久化源码衍生图。当前建模顺序、if、for/while、return、raise；try/with/match/break/continue、await/yield、短路/条件表达式和语法错误会显式标 `partial`，不推断路径可行性或异步调度。

验证证据：真实 `/Users/didi/Documents/project/all-d-forge/d-simu` 的 `scheduler/conversation_scheduler.py::start_multiple_conversations` 经 semantic checkpoint 索引后得到 14 blocks、15 edges，含循环回边；因函数包含 `await`，状态为 `partial`，原因 `Await`。复跑命令：`node --experimental-strip-types scripts/smoke/codebase-python-control-flow-real-repo.ts`。隔离 MCP 包 smoke 对 Codex/Claude 共用的 `craft-codebase` 与 `craft-context` 两包调用 Python CFG，分支/回边均可读且 source-free；单测另覆盖快照 digest、UTF-16 偏移、预算/失败、partial 构造与 MCP 回执。新增 Python CFG 模块的 statement/branch coverage 为 100%，`python-analysis.ts` wrapper 的行/分支/函数覆盖均为 100%。尚未支持 Python data-flow，Java/Go CFG/DFG 也未支持；不据此宣称四语言语义分析达成。

### 2026-10-16 Java checkpoint control-flow MCP

将 `craft_codebase_control_flow_query` 扩展到 Java 索引函数。独立 `AnalyzeJavaControlFlow.java` 只解析单个 digest-verified checkpoint 文件，使用 JDK Compiler Tree API 定位索引符号并生成 bounded、source-free CFG；建模 if、while/do/for/enhanced-for、return、throw、break/continue，try/switch/synchronized、短路条件、lambda 和语法错误显式标记 partial。JDK 8 通过 `tools.jar` 编译并运行，JDK 17/21 使用模块化 JDK，不落盘长期源码或 CFG。

验证证据：真实 `/Users/didi/Documents/project/d-forge` 的 `DataWorkflowServiceImpl.java::linkDatasetDependency` semantic checkpoint 查询得到 29 blocks、38 edges，包含分支与循环回边；因短路表达式未建模标为 `partial`，源码摘要 `bfd102768c5ef093e9a96c5469fbaa3818929ec377447c14627390d4e0a82e68`，回执 `codebase_receipt_f929544bc06819580b08`。复跑命令：`node --experimental-strip-types scripts/smoke/codebase-java-control-flow-real-repo.ts`。JDK 8/17/21 均运行真实编译器冒烟；Java adapter 行/分支/函数覆盖均为 100%，Java analyzer 单测 12 项与 Codebase MCP/快照集成测试 42 项通过。测试还确认显式 throw 连接到异常出口，try/switch/synchronized 会产生明确的 partial 原因。此能力仍不包含 Java 数据流；各语言的 CFG/DFG 语法支持不均衡，关系索引 coverage 仍可能为 partial。
