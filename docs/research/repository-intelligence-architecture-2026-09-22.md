# Repository Intelligence：给 Craft 增加“代码结构理解”能力的调研与架构建议（2026-09-22）

## 结论

Serena、GitNexus、Graphify、CodeGraphContext、Repomix、Understand Anything 看似都在做“代码知识”，实际共同补的是另一类东西：**可由某个工作区快照确定性重建的结构模型**。它的单位是文件、符号、调用、导入、配置、测试和它们之间带来源的关系；不是经审核的业务断言、用户偏好或从任务中提炼出的可复用 Procedure。

因此建议 Craft 增加一个内部、显式启用的第四成员：**Repository Intelligence（仓库智能，简称 RI）**。它是 `WorkspaceState` 的分析性投影和 Context 的候选供给者，首期只读、项目限定、可重建、不可自动执行。它不应塞入 `craft-knowledge`、`craft-memory` 或 `craft-experience`，也不应在 v0.12.37 成为外发第四个插件；对外发布仍维持 Knowledge / Memory / Experience 三个产品。完整 `craft` 可先提供 CLI/MCP 的受控预览面。

最小可交付不是“做一个漂亮图”，而是：给一个固定 Workspace Snapshot，生成可追溯的 `RepositoryIndexRevision`，并能以同一 revision 回答 `symbol`、`callers`、`impact`、`slice` 四类受限查询；每个回答都返回来源文件 span、关系置信度、未解析项与 Context Receipt。图、摘要、LLM 解释和自动 reindex 都是后续 Projection/Adapter，不能替代结构事实。

## 研究范围与方法

只采用项目拥有者的 README、源码/官方文档和官方发布页面；链接均为一手来源。本报告不接受 README 中未经可复现评测支持的性能数字为 Craft 的产品结论。调研对象是：符号检索、静态调用/依赖图、repo map、上下文压缩、增量刷新、宿主集成及其失败边界。

## 外部实现：值得借鉴的模式与不应复制的行为

| 项目 | 官方实现信号 | 最值得借的部分 | 对 Craft 的限制 |
|---|---|---|---|
| [Serena](https://github.com/oraios/serena) | 以 LSP（默认）或 JetBrains 后端提供 symbol、reference、definition、diagnostics 等 IDE 级语义工具，并通过 MCP 接给不同 Host；主应用为 GPL-3.0-or-later，SolidLSP 才是 MIT。可预热 document-symbol 缓存，但跨文件精度由语言服务器决定。 | “符号优先”查询与 Host 无关 MCP 边界。Craft 已有只读的 Serena 项目记忆桥，适合扩展为**外部 RI Adapter**。 | 不嵌入/复制 Serena 主应用，不把其编辑、shell、调试工具纳入 Craft；其 GPL 边界、语言服务安装及真实执行仍是外部 Adapter 的责任。Serena 也明确指出 REPL 的 `read_only` 不能约束被执行代码的写入，不能把它当 sandbox。 |
| [GitNexus](https://github.com/digitalapplied/gitnexus) | Tree-sitter 原生解析 + LadybugDB 持久图；仓库内 `.gitnexus/` 索引，注册表供 MCP 查询；有 `analyze`/强制重建/状态/清理与 Claude hooks。 | 图 revision 与查询分开；预先计算 impact/cluster，查询只带小的结构化子图；本地持久、可状态检查。 | 其 `analyze` 会安装技能、写 Host 配置/Hook/`AGENTS.md`，与 Craft 的“显式授权、Host 不被自动改写”冲突，不能照搬。Hook 只能由 Craft Host Adapter 显式安装并留下 activation proof。 |
| [Graphify](https://github.com/Graphify-Labs/graphify) | 本地 Tree-sitter AST 图，`graph.json` + HTML + report；边显式标为 `EXTRACTED` 或 `INFERRED`，提供 query/path/explain；支持 MCP。 | **边的来源等级**是最重要的契约：直接抽取、静态解析、以后才可能加入运行观察，不能混为“事实”。子图查询优于把全仓 markdown 塞入 Prompt。 | 它以指令文件/Hook 劝导 Agent 先查图；这不是可靠强制机制。Craft 只能将“决策点有无 RI receipt”记录为证据，不能宣称 Host 一定使用了图。 |
| [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) | CLI + MCP，Tree-sitter/可选 SCIP 建图，嵌入或外部图数据库，可做 callers/calls/tree/dead-code 查询。 | 将解析器、存储后端与 MCP 展示分层；SCIP/LSP 是增强解析器而非核心事实来源。 | Python、数据库、watcher/SCIP 依赖面很大；不符合 v0.12.37 “不新增依赖”的首期约束，也不应把运行 watcher 伪装成本地安全能力。 |
| [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | 持久本地图、Tree-sitter + 自定义 Hybrid LSP，MCP 结构查询、索引覆盖检查、跨服务链接与 UI。 | `index-coverage`/未解析结果应成为一等输出：查询命中不等于图完整。发布物与安装所有权检查也值得参考。 | 项目自述的速度/语言数量不是 Craft 的证据；自定义 C 解析器或守护进程不应成为 Craft P0。其“自动配置众多客户端”的安装风格也超出 Craft 当前发布边界。 |
| [Repomix](https://github.com/yamadashy/repomix) | 将仓库或指定文件打包为单文件，支持 ignore、`--stdin` 文件选择、`--compress`、git log/diff 和 MCP/Skill。 | 将“按明确文件列表导出上下文”做成独立工具；输出始终附带 source manifest 与压缩/过滤说明。 | 它是**有损的上下文运输**，不是语义索引或事实库。全仓打包会超预算、携带敏感内容并迅速过期；不能进入 Craft Evidence、Memory 或默认 Context。 |
| [Understand Anything](https://github.com/Egonex-AI/Understand-Anything) | Tree-sitter 先抽取结构，再由多 Agent/LLM 产出说明、层次、领域映射与导览；图输出为 `.ua/knowledge-graph.json`（兼容旧 `.understand-anything/`）。 | 图作为人类 onboarding/架构浏览 Projection；把“解释/导览”与底层图分开。 | 多 Agent/LLM 派生的 domain/summary 是 Candidate，不是结构事实；默认启动多 Agent 与 Craft 的单 Agent 默认、显式预算和评测门禁不兼容。其自动更新会添加 post-commit hook，同样不能自动套用。 |

补充观察：

- [Serena 官方文档](https://oraios.github.io/serena/01-about/035_tools.html)明确其 LLM 负责编排工具，不是 Serena 自己完成编码；Craft 也应只把 RI 定义成受限分析供给，不定义新的编码 Agent。
- [GitNexus 的架构说明](https://github.com/digitalapplied/gitnexus#how-it-works)把项目内索引和全局注册表分开；Craft 应采用同一原则，但全局注册表只能保存项目 identity、revision 和摘要，不保存工作区原文。
- [Graphify 的边证据说明](https://github.com/Graphify-Labs/graphify#see-it-in-action)区分 `EXTRACTED` 与 `INFERRED`；这比“图谱问答正确率”更基础，因为它让每个下游回答可复核。
- [Repomix 的 `--stdin` 文件清单](https://github.com/yamadashy/repomix#advanced-usage)证明包装可以是被 RI query 选择后的**短寿命派生产物**，而不是反过来让打包文件成为索引输入。

同类项目中，两个实现尤其值得作为后续 PoC 的对照，而不是现在引入：

- [CodeWiki](https://github.com/0xsyncroot/codewiki)采用 Tree-sitter 到本地 SQLite typed graph，并公开 file watcher + post-commit/merge/checkout hook 的增量策略；它说明“增量”的工程成本包括元数据、watcher 平台差异和 hook 所有权。
- [repo-map](https://github.com/noambinabout-boop/repo-map)则是更小的 repo map：symbol/reference 图用 PageRank 选出预算化 outline，mtime cache 放在用户缓存目录且需要显式 refresh。它适合验证 `context_slice`，不是完整影响分析。
- [codesight-mcp](https://github.com/cmillstead/codesight-mcp)把 allowed roots、符号链接检查、untrusted-output 与 read-only tool annotation 作为产品契约；这与 Craft 的 Scope/Policy/Receipt 方向一致，但其 Python/uv 运行时不是本次可直接引入的依赖。

### GitHub 实现清单：机制、许可/成熟度与采用边界

下表的“成熟度”只是从维护形态、测试/发布物、依赖面和已声明限制得到的**调研判断**，不是安全认证或稳定性承诺；任何 Adapter 引入前都必须对锁定 commit 重做 license、SBOM、安全和契约审查。

| 实现 | 主机制 | 许可/成熟度信号（以官方仓库当前声明为准） | Craft 采用边界 |
|---|---|---|---|
| Serena | LSP/JetBrains 的实时 symbol/reference/diagnostic | Serena 应用 GPL-3.0-or-later，SolidLSP MIT；长期维护且有官方评测/安全文档，但语言能力依赖外部 LSP。 | 仅外部进程/MCP Adapter，绝不内嵌或复制。 |
| GitNexus | Tree-sitter + LadybugDB、持久图、FTS/可选 embedding | PolyForm Noncommercial 1.0.0；有 CLI/MCP/Web 三面，但自动安装/Hook 写入策略与 Craft 冲突。 | 只可做隔离 PoC 参照，不能作为可再分发依赖。 |
| Graphify | 本地 AST graph、`EXTRACTED/INFERRED` 边、子图/MCP | 仓库标示 Apache-2.0 与 MIT；公开 benchmark 与多宿主安装面，但性能结论需 Craft 自测。 | 借鉴 provenance/revision/query 契约；首期不引入其 Python runtime。 |
| CodeGraphContext | Tree-sitter/可选 SCIP 到嵌入或外部 graph DB | MIT；有 CLI/MCP 和数据库后端，但依赖面/运行服务面大。 | 作为 graph-store 分层的研究样本，不作为 v0.12.37 依赖。 |
| codebase-memory-mcp | 原生 Tree-sitter + Hybrid LSP、本地持久图、MCP | 项目有多平台 release/大测试套件等成熟信号；具体许可证与供应链仍须在 pinned release 上复核。 | 作为 query coverage/发布物完整性 benchmark，不直接接入守护进程。 |
| Repomix | 文件选择、pack、Tree-sitter compression、MCP | MIT；成熟的打包工具，但不是语义图或增量索引。 | 只作 RI 选出文件后的短寿命 context export，不能当事实库。 |
| Understand Anything | Tree-sitter 结构 + 多 Agent/LLM 解释、dashboard | MIT；功能面广但首跑模型成本和 LLM 派生层很高。 | 只借鉴 human projection；其模型摘要一律 Candidate。 |
| CodeWiki / repo-map / codesight-mcp | 分别为 SQLite 增量图、PageRank map、安全约束索引 | 都有明确局限和运行时前提；在固定 commit 做 PoC 前不判断可用性。 | 作为“真增量”“预算化 map”“allowed-root”三种设计对照。 |

## 为什么不能归入 Knowledge、Memory 或 Experience

| 领域 | 它保存的真相 | 生命周期/失效方式 | RI 与它的关系 |
|---|---|---|---|
| Knowledge | 经 Evidence、来源、scope、review 管理的 Claim/文档事实 | 来源 revision、撤销、重新审核 | RI 的图节点可引用 README/ADR，但不会把 AST 边提升为 reviewed Claim。知识可解释图，不能替代图。 |
| Memory | 用户/项目偏好、事件、程序性记忆及冲突替代链 | TTL、topic、supersede/revoke | RI 不记“以前查过什么”；它从当前 snapshot 重建。若记录查询偏好，只能作为 Memory 的显式候选。 |
| Experience | Observation → Pattern → Procedure Candidate 的可评测过程改进 | Eval、Shadow、Signoff、Canary | RI 可作为某次 Procedure 的受控输入或评测 subject，但不从一次 query 自动演化为 Procedure。 |
| Repository Intelligence | 文件/符号/关系的派生结构，带 snapshot 和解析器版本 | 任一输入文件、构建/配置、解析器或 policy 变化即 stale/rebuild | 是第四类“物化分析投影”，默认只读、可丢弃、可重建。 |

这与现有 Craft 边界一致：`WorkspaceState` 已是受控工作区状态源，`Context Resolution` 是核心读取控制面，Capability Kit 负责外部供给生命周期；三者都不应被新的图数据库或 Agent loop 绕开。当前架构也已明确 Serena 仅为 project knowledge 的只读桥，而非 Runtime 执行权。[`agent-native-workspace.md`](../technical/modules/agent-native-workspace.md) 与 [`knowledge-memory-context.md`](../technical/modules/knowledge-memory-context.md) 是该定位的直接依据。

## 建议的最小能力模型

```text
Workspace Snapshot / allowed paths / project identity
  -> RepositoryIndexBuild (read_only, explicit)
  -> RepositoryIndexRevision (immutable, digest-pinned)
      -> Node / Edge / ResolutionDiagnostic
      -> RepositoryQuery (symbol | callers | impact | slice)
      -> RepositoryContextContribution (references only)
  -> Context Resolution / Decision Context Gate / Verification
```

### 1. 核心对象（新的深模块，而非大而全 graph runtime）

- `RepositoryTarget`：`project_id`、规范化 root identity、允许相对路径、ignore policy digest、语言/解析器策略、最大文件数/大小。拒绝绝对路径、`..`、符号链接和未授权根；跨项目永不默认合图。
- `RepositorySnapshot`：冻结的 `WorkspaceState` checkpoint 或 Host 提供、可校验的 file manifest；每个文件仅保存路径、大小、内容 digest、语言与状态。不能把 Git 分支名当 snapshot 身份。
- `RepositoryIndexRevision`：`target + snapshot + parser/resolver/policy fingerprint` 的不可变 digest；状态仅为 `building | ready | stale | failed | revoked`。失败或输入漂移不得继续返回旧图而不标注。
- `RepositoryNode`：`file | module | symbol | test | config | document`，有稳定 source span、kind、源 digest 和可见性；正文仍留在工作区，由 Host/Workspace 读。
- `RepositoryEdge`：`imports | declares | references | calls | implements | tests | configures`，每条携带 `provenance = extracted | resolved | observed`、解析器版本、confidence、原始 span；`observed` 仅来自未来受控 runtime adapter，绝不由模型文字写入。
- `ResolutionDiagnostic`：未解析 import/call、循环、超出预算、被排除文件、解析失败；是 query 的必带部分，不能藏在日志里。
- `RepositoryQueryReceipt`：query digest、index revision、选择的 node/edge refs、截断、解析覆盖、时延、输入/输出 token 估计；不保存代码正文或模型回答。

### 2. 最小查询面

首期只提供确定性、无模型的四项：

1. `find_symbol`：精确/受限模糊名，返回定义、source span 和歧义。
2. `find_callers`：只返回证据级别满足阈值的 caller，并显式列未解析调用。
3. `impact`：从输入 Node/路径按已声明的 relation kinds、最大深度和最大节点数返回可解释子图；结果是“静态候选影响”，不是发布安全结论。
4. `context_slice`：依 Task 和明确 symbols/paths 输出预算化 references，供 Context Resolution 决定是否 materialize；不直接注入全仓正文。

不做的事：自然语言自由图问答、LLM 自动摘要、自动修复、shell、网络、graph database、长驻 watcher、跨仓关联、PR/Forge 操作、UI、embedding、自动 Host 配置。它们要么是 Projection，要么是 Adapter，要么需要单独的质量和 effect 证明。

### 3. 解析与增量路线

P0 先复用一个现有的、已安装且显式授权的外部适配器（优先 Serena 的 symbol/reference 能力），而非把其实现拷入 Craft：

- `RepositoryAnalyzerAdapter` 是 Capability Kit 管理的外部供给，Manifest 钉死 adapter/version/digest/支持语言/允许 effect；只允许 `read_only` 和受控 `local_write` 的索引缓存。
- Craft 读取其**摘要化、可复现的结果**，以本地 snapshot span 重新核验后生成 RI revision；adapter 不可用时返回 `unavailable`，不以 grep 假装语义图。
- 对 TypeScript/JavaScript 首个本地解析器，只在已有依赖已能提供 AST/LSP 时再实现。若没有，不为了首期引入 Tree-sitter、数据库或语言服务依赖。

P1 再实现增量：Host 显式给出 changed-path manifest，RI 重新 fingerprint 受影响文件、importers 和配置根；若 alias/config/生成物变化使闭包无法可靠确定，则 revision 进入 `stale`，要求全量 rebuild。增量只是一种优化，**不能改变同一 snapshot 下的查询语义**。

P2 才评估 `observed` runtime edges；必须由独立的 Host/Verification receipt 证明，且与静态 edge 分层显示。静态图不能证明 HTTP、MQ、反射、配置路由或运行时 feature flag 的真实传播。

## 在 Craft 里的落点与调用边界

推荐代码落点如下，避免把业务塞回 `CraftService` facade：

```text
src/application/repository-intelligence-coordinator.ts     # 应用编排：Task/Policy/Receipt 绑定
src/repository-intelligence/                                # 深模块：Target、Snapshot、Revision、Query、Receipt
src/adapters/repository-analyzers/serena.ts                 # 可选外部 Adapter；不链接 Serena 代码
capability/repository-intelligence-kit.ts                   # Kit Manifest/Conformance/Activation 投影
src/interfaces/mcp-server.ts                                # 只暴露 full-craft 的受限 read/query/doctor 面
scripts/repository-index.ts                                 # 显式 CLI，非 daemon
```

依赖方向应为：`interfaces -> application coordinator -> repository-intelligence domain -> infrastructure/adapter port`。RI 可读取由 `WorkspaceState`/Host 固定的 snapshot，向核心 `Context Resolution` 贡献**引用**，由 Policy/Task-bound Activation 决定何时可用；它不能反向读写 Memory、Knowledge、Experience、Task State 或 Host 配置。

`Capability Kit` 的职责是外部 Serena/GitNexus/SCIP 等分析器的发现、版本、授权与撤销，不是承载 RI 的核心数据模型。这样既能接现有生态，也避免“装了 Skill 就多了一套平行真实图”。

对外形态建议：

- 完整内部 `craft`：显式 CLI 和 full MCP 的 `repository_index_*` / `repository_query_*`；默认只读，先由 `craft doctor` 显示 index 的 snapshot、解析器、stale/unavailable 原因。
- `craft-knowledge` / `craft-memory` / `craft-experience`：不直接暴露 RI 工具，不自动载入图；它们可在 Context Receipt 中看到 RI reference，但不能写 RI revision。
- Codex/Claude：只通过现有 Host adapter 在显式 Task Activation 下调用；Hook 只能提示或记录“决策前已解析 RI”，不能改 Host 配置、更不能阻断所有搜索来强制使用图。
- Marketplace/common-use：继续只分发三个既有组件。RI 到达独立可评测、可安装和可撤销的产品门槛前，不能把 `craft` full surface 伪装成第四个外部插件。

## 信任、隐私和 Evidence 边界

1. **代码不是自动 Evidence。** `EXTRACTED` 仅表示“在某 snapshot 的某 span 可复现”，不表示业务正确、安全或当前生产行为；所有 impact 输出均为候选检查范围。
2. **输出必须可复现。** `RepositoryQueryReceipt` 绑定 revision、path/span、edge provenance 和预算；后续若要引用到 Knowledge/Experience，必须另建 Evidence 并接受其自身审核。
3. **无跨项目泄漏。** project identity、root fingerprint、scope 和 index data-space 必须同 query 一起校验；未指定项目的查询失败关闭，不能“从所有索引搜一下”。
4. **内容最小化。** index 持久化结构、digest、span 和诊断；正文按需从 snapshot 读取。任何 `context_slice` 均有文件 allowlist、字符/节点预算、敏感路径拒绝和 content-free receipt。
5. **无隐式执行。** build/query 都是显式、`read_only` 分析；缓存写入是 Craft 受控 local data path。外部 CLI/MCP、LSP、watcher、HTTP、UI、代码写入均需独立 Capability/Host Adapter 和 Policy。
6. **不可把 local process isolation 宣称为 sandbox。** 外部分析器或 LSP 的隔离、凭据与网络状态属于 Host/Sandbox broker 的部署事实，RI 只能记录其 Environment/Adapter receipt。

## 评测与晋级路线

### P0：结构正确性与安全闭环

- 建立 12--20 个脱敏小仓库 fixture，至少覆盖 TS/JS 主路径、循环 import、重载/同名符号、barrel export、alias 配置变化、动态调用不可解析、测试/生产 caller、符号链接与路径逃逸。
- 每个 fixture 同时保留人工标注的 node/edge ground truth、允许解析范围和 expected unresolved；对每次 build 做 snapshot/revision digest 可重放测试。
- 检查：source span replay 100%、跨项目泄漏 0、路径/符号链接拒绝 100%、stale 不静默查询、被截断/未解析项必回执、P0 query 不产生外部 effect。
- 全新增/修改分支维持项目要求的 100% 单元测试覆盖率；这是机制门禁，不是“Agent 更会编码”的证据。

### P1：Context 价值而非图的自嗨

在既有 Engineering Evaluation Runner 的冻结 `bug-fix-shared-caller` Case 中增加 RI arm；同一 Host、模型、项目 snapshot、预算、验收器下执行 baseline/RI 配对 5 次。除确定性验收、sibling caller、越权 effect blocker 外，记录：

- 目标 symbol/caller/impact 的 recall、precision、unresolved disclosure；
- 根因证据是否引用同一 revision 的 source span；
- 为任务实际 materialize 的输入 token、工具调用数、时延和成本；
- sibling caller 漏检、错误扩大变更、陈旧 revision 注入和跨项目泄漏。

结论规则：只有完整配对不弱于 baseline、无 blocker、信息召回不下降且 token/成本/时延不恶化，RI 才能从 `candidate` 进入 Shadow。三次实验仅诊断，不能路由。

### P2：真实宿主与增量

- 先做 Codex/Claude 的真实、显式 Host 安装诊断：adapter 是否已钉版本、MCP 是否真挂载、Hook 是否受信任、真实会话是否产生 RI receipt；`doctor` 不得将配置存在误报为已执行。
- 以同一 commit 的全量 build 为 oracle，验证增量 revision 与全量 revision 对可解析子图等价；配置根变动、遗漏路径、解析失败则必须 stale/rebuild。
- UI/导览是对同一 revision 的 read-only projection；其可用性、可访问性、刷新延迟另行测量，不可拿视觉展示冒充结构正确性。

## 推荐实施顺序

1. 先写 ADR：命名为 `Repository Intelligence / Structural Context`，锁定上述数据域、effects、四类查询、三插件发布边界和“不把代码自动当 Evidence”的规则。
2. 实现 core revision/receipt/fixture verifier，先接一个 `SerenaRepositoryAnalyzerAdapter` 的只读 contract；无 adapter 时明确 `unavailable`。
3. 接入 Context Resolution 的 references-only contribution 与 Decision Context Gate，新增 doctor，完成 P0 机制/覆盖率门禁。
4. 使用现有 Codex Engineering Eval Runner 做 P1 成对真实评测；未达标保持 candidate，绝不默认注入。
5. 评测通过后再考虑本地解析器、增量、可视化以及更多 Adapter；它们都沿同一 revision/receipt/eval 契约扩展。

## 明确不建议的捷径

- 不把 `graph.json`、Repomix 单文件或生成 wiki 直接写入 Knowledge/Memory；它们是快照派生产物，过期与敏感面都不同。
- 不默认自动安装外部 MCP、写 `AGENTS.md`、注入 Hook、启动 watcher 或下载语言服务。外部项目的便利安装不能绕开 Craft 的 Activation/Policy/Proof。
- 不先做图数据库、向量检索或多 Agent dashboard。没有确定性 source span/provenance/revision/stale 语义时，它们只会放大幻觉和维护成本。
- 不把静态 `impact` 描述为运行时完整影响或安全审计；MQ、反射、远程配置、feature flag、生成代码均应以未解析或外部 observed Evidence 呈现。
- 不因出现第四数据域而扩大外部发布面：Repository Intelligence 首期是完整 Craft 的内部、显式 Analysis capability，而非新的默认人格或运行时。

## 一手来源

- Serena： [README](https://github.com/oraios/serena/blob/main/README.md)、[工具文档](https://oraios.github.io/serena/01-about/035_tools.html)、[许可说明](https://github.com/oraios/serena/blob/main/LICENSE)。
- GitNexus： [README / CLI、存储、MCP 与 hooks](https://github.com/digitalapplied/gitnexus)、[源码仓库](https://github.com/digitalapplied/gitnexus)。
- Graphify： [README / graph contract 与 MCP](https://github.com/Graphify-Labs/graphify)、[官方介绍](https://graphify.com/blog/introducing-graphify)。
- CodeGraphContext： [README](https://github.com/CodeGraphContext/CodeGraphContext)、[Wiki](https://github.com/CodeGraphContext/CodeGraphContext/wiki)。
- codebase-memory-mcp： [README](https://github.com/DeusData/codebase-memory-mcp)、[Hybrid LSP 文档](https://github.com/DeusData/codebase-memory-mcp#hybrid-lsp)。
- Repomix： [README](https://github.com/yamadashy/repomix)、[CLI package configuration](https://github.com/yamadashy/repomix/blob/main/repomix.config.json)。
- Understand Anything： [README](https://github.com/Egonex-AI/Understand-Anything)、[底层流水线](https://github.com/Egonex-AI/Understand-Anything#under-the-hood)。
- 增量/安全对照： [CodeWiki maintenance](https://github.com/0xsyncroot/codewiki#maintenance-and-incremental-sync)、[repo-map limitations](https://github.com/noambinabout-boop/repo-map#limitations-honest)、[codesight-mcp features](https://github.com/cmillstead/codesight-mcp#features)。
- Craft 当前边界： [`current-capability-matrix.md`](../technical/current-capability-matrix.md)、[`agent-native-workspace.md`](../technical/modules/agent-native-workspace.md)、[`knowledge-memory-context.md`](../technical/modules/knowledge-memory-context.md)、[`capability-kit-runtime.md`](../technical/modules/capability-kit-runtime.md)。
