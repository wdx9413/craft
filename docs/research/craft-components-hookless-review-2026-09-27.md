# Craft 四子能力缺口与无宿主 Hook 接入评估

日期：2026-09-27。范围：Knowledge、Memory、Experience、Codebase，以及多编程工具接入。

> 本文保留实施前的研究基线；后续修复、验证结果与剩余边界见[实施记录](craft-components-hookless-implementation-2026-09-27.md)。

## 结论

**可以不用宿主 Hook；建议把 Skill + MCP 设为正式默认接入契约，把宿主 Hook 设为可选增强。当前实现已有这个基础，但四个独立产品尚未形成完整、可移植的操作闭环。** 去掉 Hook 本身不会修复这些断点，应先解决公开工具与 Skill 不一致、参数 Schema 错误、scope/证据边界和空环境启动问题。

Skill 决定何时调用，MCP 提供可调用接口，Runtime 执行校验和状态转换。纯 Skill + MCP 可以覆盖按需检索、明确授权的记忆写入、经验观察/候选程序管理、代码索引查询；不能保证宿主每轮必定调用，不能天然看见宿主自己的编辑与终端执行，也不能阻断宿主绕过 Craft 的工具。严格的自动触发或完整执行观测需要宿主集成、扩展、受控执行入口或可选 Hook；它们不应成为四个子能力的安装前提。

这里的“无 Hook”指**无 Codex/Claude 等宿主生命周期 Hook**。Craft 内部 `HookPlane` 是另一层流程扩展机制，参与 `tool_before` 等治理阶段。不能为了取消宿主依赖顺便移除服务器内部校验/门禁。[McpServer](../../core/interfaces/mcp-server.ts)、[ADR 0017](../adr/0017-a-hook-belongs-to-the-flow.md)

## 证据范围与验收

- 源码基线：`craft` HEAD `9ada1c7a92dfc3847837b063081176696ca9f463`，版本声明 `0.12.37`，**包含本次开始前已有的未提交改动**。本报告评价当前工作区；不宣称同版本安装包、marketplace bundle 或线上部署已一致。
- 对照两类既有实现：`plugins/craft-*/skills` 与独立 MCP product；兄弟目录 `craft-common-use` 的 Skill + MCP 安装器。沿用 `docs/research/` 研究文档约定。
- 验收：每项“已证实”附当前源码或隔离复现；区分已有能力、接口缺口、架构建议；给出不依赖 Hook 的调用链和跨宿主验收标准。
- 非目标：本次不修功能代码、不改宿主配置、不发布插件、不将研究判断写成长期记忆、不声称提高了模型效果。
- 实测方式：临时目录创建 `CraftStore`，通过现有 `CraftService` / `McpServer.handle` 和 Hook Bridge 运行脱敏 fixture，结束删除临时数据。没有使用真实业务数据验证跨 scope 行为。

## 已证实的产品断点

### 1. Skill 所要求的工具，在独立 MCP 产品中不可达（P0）

| 产品 | Skill/使用流程要求 | 当前公开面 | 影响与最小修复方向 |
|---|---|---|---|
| Knowledge | 审阅 exact semantic review packet 后提交 Host review | daily 有 `craft_knowledge_host_review`，没有 `craft_knowledge_semantic_review_packet` | 无法按 Skill 完成标准审核链；公开 packet 获取或提供一个返回 packet 的稳定准备入口，保留 digest 校验。 |
| Memory | 重要决策前调用 `craft_decision_context_gate_open` | daily 没有该工具 | Skill 要求无法执行；公开最小决策入口，或明确何种产品支持该步骤，不要指向隐藏工具。 |
| Experience | 无 Hook 时 `craft_context_resolution_resolve`，选 `members: ["experience"]` | daily 没有 resolve；该调用返回 `Unknown tool` | 观察与 Procedure 操作存在，但按 Skill 的开始检索链断裂；需受限 Experience resolve。 |
| Codebase | 声明 workspace，创建/选择 checkpoint，再 build | 独立面仅 `craft_info` + 8 个 codebase 工具；缺 Workspace 建立/checkpoint 操作 | 空数据空间不能只按独立 Skill 完成首跑；增加受限 bootstrap 或 snapshot manifest 导入，不能要求临时切到 full。 |

来源：[daily surface registry](../../core/interfaces/mcp/surface-registry.ts)、[product mapping](../../core/interfaces/mcp/product-launch.ts)、[Knowledge Skill](../../skills/craft-knowledge/SKILL.md)、[Memory Skill](../../skills/craft-memory/SKILL.md)、[Experience Skill](../../skills/craft-experience/SKILL.md)、[Codebase Skill](../../skills/craft-codebase/SKILL.md)。隔离枚举 tools/list：Knowledge 16、Memory 16、Experience 13、Codebase 9。

Codebase 现有测试在 fixture 中直接调用 `service.workspaceOpen` 和 `workspaceCheckpoint`，然后测 Codebase；这证明内核可用，未证明独立插件从空环境可用。[现有 Codebase 测试](../../tests/craft-codebase.test.ts)

### 2. 参数 Schema 与实现冲突，换一个严格宿主就会失败（P0）

- `craft_experience_procedure_draft.design_axes` 声明为 object，`WorkflowEvolutionKernel.propose` 要求 array。隔离调用按 Schema 传 `{axis:"orchestration"}`，返回 `design_axes must be an array`。
- `craft_context_resolution_resolve` 的公开 Schema 没有 `members`，且 `additionalProperties: false`；内核和 Experience Skill 却依赖此字段。`include_working_notes` 等内核支持字段也未完整映射。
- `craft_codebase_context_slice.node_ids` 被通用推断声明为 string，内核要求非空 array。这类问题应按每个工具的真实契约修正，不能按参数名字为全部工具猜类型。

来源：[tool-schema](../../core/mcp/tool-schema.ts)、[tool-catalog](../../core/mcp/tool-catalog.ts)、[Workflow Evolution](../../capability/craft-experience/workflow-evolution.ts)、[Context Resolution](../../core/context-resolution.ts)、[Codebase index](../../capability/craft-codebase/codebase-index.ts)。现有 standalone 测试大量直接调用 `handlers`，绕过了宿主按 `inputSchema` 构造参数的过程。[standalone 测试](../../tests/component-standalone-readiness.test.ts)

最小修复：每工具显式类型/必要 override；由同一契约生成公开 Schema 和运行时校验；对“符合 Schema 的输入能够完成该路径”增加真实 MCP 边界测试。不能只断言工具名存在或总数不超过 16。

### 3. 无 Hook 路径的 scope 与组件选择不完整（P0）

- `craft_knowledge_search` 公开参数只有 `query, limit`；实现默认不限定 scope，默认包含 candidate。隔离创建 `project:a` / `project:b` 两条匹配 Claim 后，一次普通 search 返回两者。它也没有采用 ContextContribution 的同一套来源可信度与访问筛选。**这是默认检索范围与治理接口缺口；本次没有做跨租户攻击验证。**
- Memory 产品的 resolve handler 直接绑定通用 `contextResolutionResolve`，没有绑定 `members:["memory"]`。同 scope fixture 中，仅调用 Memory MCP 已返回 Knowledge contribution。Hook 路径却显式限制 member，导致两种接入语义不一致。
- scope identity 内核已有 Git remote canonical identity / path alias；daily 产品没有公开相应解析工具。跨宿主依赖 Agent 自己猜 `scope_id`，容易发生同仓库记忆不命中或多目录混用。
- Memory daily 缺少直接 ledger revoke/transition 入口；已有冲突 supersede 能力不等于任意用户请求“忘掉这条”的完整独立入口。

来源：[knowledgeSearch](../../core/application/craft-service.ts)（3322 行起）、[action handlers](../../core/application/actions/action-handlers.ts)、[Knowledge contribution](../../capability/craft-knowledge/contribution.ts)、[scope identity](../../core/scope-identity.ts)、[Memory governance](../../core/memory-governance.ts)。

最小修复：默认先解析明确 scope；检索输出显式标 candidate/reviewed 与排除原因；组件 MCP 在服务端固定本组件，组合模式显式声明成员；公开受控 scope 解析与记忆撤销。保留高级诊断的跨 scope 搜索，但必须明确选择和授权，不能成为日常默认值。

### 4. Hook 当前也不能提供可靠的“验证通过”事实（P0）

隔离复现序列：`Edit` → `npm --version` exit 0 → `npm test` exit 1 → `Stop`。

结果：`npm --version` 被归为 `verification`；journal 最终仍为 `passed`；生成 Observation `passed`，Evidence 为 `confirmed`，Claim 为 `Codex local verification passed.`。

原因：`VERIFY` 只识别 npm/pnpm 等命令前缀；journal 只要任何一次 verification passed 就优先返回 passed，不绑定最终修改版本，也不要求通过的是实际验收命令。turn 缺失时还回退为 session identity，不能把这一兜底等同于独立任务观测。[HookSignalSanitizer / HookTurnJournal / HookLearningCoordinator](../../core/interfaces/codex-hook-bridge.ts)（29、75、96、126 行附近）

应补：受控的 verification receipt，包含执行来源、验收器/命令契约引用、工作区 revision、开始结束顺序、exit status 和证据 digest；失败、通过、未观测分别记录。后续编辑会使旧通过证据失效。模型报告与独立执行结果分级，不能由一条 `passed` 字符串或命令正则直接晋升为已证实成功。这个契约同时供显式 MCP 提交、CI/运行器和可选 Hook 使用。

## 四个子能力分别需要补什么

| 子能力 | 已有基础，应保留 | 补齐顺序 |
|---|---|---|
| Knowledge | Source/revision/evidence、candidate/reviewed、packet-bound review、过期/来源撤销筛选；Markdown 投影与检索 | 先修 scoped search 和 packet 审阅闭环；再统一检索路径、来源更新后的重新验证、中文/术语/别名召回评测。 |
| Memory | 显式用户同意、topic 冲突、supersede、TTL、scope stack、portable bundle、可选 hybrid retrieval | 先让 scope resolve / recall / correction / revoke 在独立产品可完成；再增加“为什么召回/未召回”、决策时使用反馈、跨宿主同项目一致性与并发验证。 |
| Experience | 独立观察、最多两条设计轴、Procedure candidate、shadow/held-out/signoff/canary、disabled Skill export | 先修观察真实性、Schema 和无 Hook recall；再用任务类型/失败机制而非泛化的本地命令成功划分场景；建立固定 baseline 对照、退化检测与撤销。 |
| Codebase | checkpoint 固定、显式激活、只存路径/span/digest、候选影响、stale 检查 | 先补独立 bootstrap、Schema；再加可插拔 AST/LSP/SCIP 分析器，覆盖 Java/Python/Go 等实际语言；补 changed-path 刷新和 working-tree drift 提示。 |

检索现状并非“完全没有 BM25/向量”：Markdown `KnowledgeIndex` 用 token LIKE 候选 + BM25 排序；Memory resolver 有 keyword/vector/hybrid 与故障回退；reviewed Knowledge contribution 仍是词项包含计分。短板是路径与输出契约不统一，且中文自然语言中的连续字符通常被当作整段词项；应先用人工标注查询评估，再决定是否引入分词、别名或向量，不能直接堆新数据库。[KnowledgeIndex](../../core/knowledge-index.ts)、[Knowledge contribution](../../capability/craft-knowledge/contribution.ts)、[Context Resolution](../../core/context-resolution.ts)

Codebase 目前 `ANALYZER = builtin-regex-static-v1`，只处理 TS/JS 家族；call edge 是文件到候选符号，带 `heuristic/partial`。未解析 import 与同名调用有诊断，但无目标声明的调用不会逐一产生 unresolved_call 诊断。查询只能说明指定 checkpoint；没有新 checkpoint 时，当前工作目录发生变化不会仅凭 `indexStatus` 自动被判 stale。它适合作为有限结构辅助，不能定位成完整多语言语义分析或运行时影响证明。[Codebase 实现](../../capability/craft-codebase/codebase-index.ts)

## 无宿主 Hook 的最小使用协议

以下是**目标契约**，不是宣称现在已经全部具备。优先复用既有 Runtime；只在现有原语过长或缺口明确时增加轻量组合入口。

```text
用户任务 / Skill 被选中
  -> 探测实际可调用 MCP、server release/artifact、data space
  -> 解析项目 identity、scope 与宿主能力
  -> 按任务需要 resolve Knowledge / Memory / routeable Experience
  -> 收到统一预算的 context + 来源 + 版本 + receipt
  -> 宿主使用自己的编辑、终端、测试工具执行工作
  -> 如有可核验结果，通过 MCP 提交有来源的 outcome/evidence
  -> 需要时形成 Knowledge / Memory / Experience 候选
  -> 明确用户同意和各域校验决定是否持久化/晋级

需要代码结构时：workspace bootstrap -> checkpoint -> codebase index/query
可选 Hook/IDE 扩展/运行器：提供同样的输入与证据，省去显式步骤
```

无需每轮调用三个 readiness 再做空写入。没有记忆授权就不写 Memory；没有独立结果就不伪造 Experience；没有可靠知识证据就不晋升 Knowledge。报告 `unused / unavailable / no_match / observed` 等具体原因，不用“调用过状态接口”代替有效使用。

建议四个逻辑域保持独立；部署可以四插件，也可以一个选择性组合 MCP。默认不要求用户安装 full Craft，也不要求再配置第二个模型 API key：正常摘要/审核由现有宿主完成；无人值守提炼才选择独立模型服务，并受预算和证据约束。`host_kind` 当前仅接受 codex/claude/independent，可保留 independent 兼容，逐步用 host id/version/capabilities 表达宿主差异。[Host review](../../core/knowledge-auto-review.ts)

Context 应有跨组件总预算和去重。本地 resolver 当前分别给 Memory 与各 contributor 同样的 max_items/max_chars，receipt.used_chars 只统计 Memory；因此传 3000 并不等于聚合结果最多 3000。可以保留分配权独立，但对 Host 返回一个总量、截断与各组件占用的可检查契约。[Context Resolution](../../core/context-resolution.ts)（185–207 行）

## 多工具接入：复用已有 common-use，扩展能力矩阵

仓库已经有无 Hook 方案：[craft-common-use README](../../../craft-common-use/README.md)、[agents.mjs](../../../craft-common-use/agents.mjs)、[init.mjs](../../../craft-common-use/init.mjs)。Cline、Qoder、Trae、WorkBuddy、DSH 的 MCP/Skill 配置差异已被集中在安装适配层；本次未运行安装、未修改这些工具的配置。README 中历史安装记录不是本次宿主执行证据。

建议将接入分成四种可核验等级，避免简单写“支持某某工具”：

1. **配置可生成**：位置、产品、node 路径、权限提示、卸载归属明确。
2. **协议可达**：实际安装命令可启动；按所支持 MCP 版本完成发现和工具调用；Schema 一致。
3. **功能可用**：关闭宿主 Hook 后，在该宿主从空数据空间完成实际用例。
4. **增强已验证**：可选自动触发、独立执行证据、断线恢复、receipt 关联都有该宿主/版本的实测。

安装适配层只处理路径、配置、信任、版本与生命周期映射。业务检索、审核、scope、去重和状态转换放在统一服务端。对不支持标准 Skill 的宿主，提供显式命令或短规则入口；不能把粘贴说明当成可靠执行。stdio 是本地基线；远程/云端使用独立验证的 HTTP、认证与数据隔离部署，不假设云宿主能读取本机 `~/.craft_data`。

四插件共享数据时需核验 `data_space_id`、产品版本和 artifact digest；原始 SQLite 文件复制不能替代受控迁移。已有 bundle export/verify/import_plan/import_apply 应继续复用，避免另建同步协议。[Knowledge/Memory bundle](../../core/knowledge-memory-bundle.ts)

## 建议落地顺序与验收标准

| 优先级 | 交付 | 可验证验收 |
|---|---|---|
| P0 | 修工具面/Skill/Schema 一致性 | 逐条 Skill 所需操作在其独立产品可达；严格 JSON Schema client 可完成 Knowledge review、Memory recall/revoke、Experience draft/recall、Codebase 首次建立索引。 |
| P0 | 默认 scope 与组件隔离 | 两项目、两个成员、撤销来源、candidate、restricted fixture 都按明确契约筛选；Memory 独立产品不意外返回其他成员。 |
| P0 | 真实结果证据 | `npm --version` 不产生测试成功；成功后失败不留成功结论；编辑后旧测试证据失效；unknown 和重复 receipt 不增加独立观察。 |
| P1 | 无 Hook conformance suite | 在 Codex/Claude 及至少一个通用宿主关闭 Hook，执行空环境首跑、恢复、纠正/撤销、scope 切换；记录 Host/model/plugin/artifact/version。 |
| P1 | 检索/Codebase 质量 | 中文与别名 query 的 recall/precision；跨项目泄漏 0；静态解析覆盖与 unresolved 显式输出；工作区变化明确要求刷新或声明 snapshot 限制。 |
| P1 | 可诊断的安装与并发 | installed/advertised/callable/used 分开；完整首跑记录；两个宿主同时操作同数据空间的冲突、幂等、过期更新测试。 |
| P2 | 可选自动化/团队服务 | 同一任务 fixture 比较有无 Hook；需要远程时再验证认证、租户边界、并发和部署，不因“支持 HTTP”跳过。 |

不要先扩大工具数量、加自动学习 Agent、全仓图数据库或多套宿主业务实现。先证明现有四域通过标准工具边界独立可用，然后以检索与任务效果评测决定新增复杂度。

## 本次验证与限制

执行：`node --test --test-concurrency=1 tests/codex-hook-bridge.test.ts tests/component-standalone-readiness.test.ts tests/craft-codebase.test.ts tests/knowledge-index.test.ts`。

结果：**26 tests，26 pass，0 fail**。日志：`/tmp/craft-components-research-tests-20260927.log`。另用两组隔离 Node probe 复现上面的缺失工具、Schema 冲突、跨 project search、Memory resolve 混入 Knowledge、Hook 错误成功证据；临时 Store 已清理。

这些是有针对性的本地核验，不是全量测试、分支覆盖报告、发布包回归或多宿主 live 认证。本次只新增研究 Markdown，没有生产逻辑增量，因此不声称达成“增量代码覆盖率 100%”。

当前会话：Memory readiness 实际返回 ready；完成了限定 project 的真实 context resolve，receipt `context_resolution_ffc8718e762c4873b757132f76a67a35`。Knowledge/Experience 名字出现在工具目录中，但实际函数未挂载；已读取并应用对应 Skill 的不可用回退约定，未伪造这两个插件已成功调用，也未写入 Knowledge/Memory/Experience 新事实。独立能力挂载状态与代码实现完整性是两项不同证据。

## 外部一手资料与宿主兼容性

### 协议边界

| 机制 | 官方合同 | 对 Craft 的设计含义（推论） |
| --- | --- | --- |
| MCP tools | 提供发现、输入 schema、调用和结果；由模型控制调用，协议不强制交互方式。[Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | 适合作为四组件最小公共接口；不能保证模型一定调用某工具。校验、授权和幂等必须在服务端。 |
| MCP resources | 通过 URI 暴露上下文，是否及如何加入上下文由应用控制，订阅是可选能力。[Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources) | 可用于证据、索引摘要、长文按需读取；不能用它冒充强制上下文注入。对只支持 tools 的宿主保留工具读取入口。 |
| MCP prompts | 模板由服务端定义，主要给用户选择和触发。[Prompts 原文](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/prompts.mdx) | 可提供显式“开始任务/结束复盘”命令，但不能替代总会运行的 Hook。 |
| MCP lifecycle / versioning | 2025-11-25 是连接初始化、能力协商、运行、关闭；2026-07-28 改为逐请求版本和能力元数据，并定义新旧协议兼容方式。[旧版 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[现行 versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) | MCP 连接生命周期不是编程任务生命周期；共享连接、重连或进程退出都不能直接等价于用户任务开始/成功/结束。 |
| MCP sampling | 2026-07-28 已弃用，仍保留至少 12 个月；官方建议新实现不要采用，现有实现迁移到直接 LLM Provider API。[Sampling](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling) | 不宜把 sampling 作为四组件或跨宿主的必要兜底；也不能用它补出宿主全量对话或真实工具结果。 |
| Agent Skills | 定义 SKILL.md 及资源结构；allowed-tools 仍属实验性，支持程度因实现而异。[Specification](https://agentskills.io/specification) | 核心指令使用标准字段，避免依赖某宿主特有动态 shell、变量、fork 或工具授权语法。 |
| Skills 加载 | 推荐目录扫描、元数据披露、按需读取；`.agents/skills` 是广泛使用的约定，不是格式标准强制目录。[Client implementation](https://github.com/agentskills/agentskills/blob/main/docs/client-implementation/adding-skills-support.mdx) | 同一个 Skill 内容可移植，不代表任意目录、重名规则、加载时机都可移植。安装适配和加载验收仍必需。 |
| Agent Plugins 1.0 | 已发布的分发标准；允许客户端仅实现部分组件，未支持的组件必须忽略。[Specification](https://agent-plugins.org/specification) | 可复用 portable skills + MCP 包格式，不能凭“插件安装成功”推断 MCP 和 Hook 都启用。 |

版本状态已复核：2026-09-27 打开官方 `/specification/latest`，实际跳转至 `/specification/2026-07-28`；官方维护者的发布公告明确发表于 2026-07-28，并写明该版本已经发布。因此本文引用的是当日官方现行发布版本，不是搜索结果里的早期 Release Candidate。[Latest 入口](https://modelcontextprotocol.io/specification/latest)、[正式发布公告](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

版本提醒：上述现行 MCP 规范不代表所有编程工具已经采用 2026-07-28。Craft 应记录实际协商版本、transport 和客户端能力，按支持范围服务；不能以规范升级为由直接删除旧版兼容，也不能因某个客户端支持 MCP 就推断其支持 sampling、resources、MRTR 或扩展。

另一个可选方向是 **Skills over MCP**：官方将 `io.modelcontextprotocol/skills` 标为已发布扩展、SEP-2640 为 Final，但明确 SDK/Host 支持仍在推进；读取 SKILL.md 资源也不自动等价于激活 Skill。它适合后续远程分发探索，目前不应替代本地 Skill + tools 的最低兼容档位。[Skills extension](https://modelcontextprotocol.io/extensions/skills/overview)

### 官方文档支持矩阵

下表全部是 **documented**，不是 **live_verified**。即使同一品牌，也需区分 CLI、IDE、Desktop、云端、远程开发以及具体 Harness。未列出的客户端表示本轮未查证，不表示不支持。

| 宿主 | Skill | MCP | Hook / 等价事件 | 可移植接入建议及主要差异 |
| --- | --- | --- | --- | --- |
| Claude Code | Agent Skills；主要原生目录 `.claude/skills`，支持用户显式及模型按需调用。[Skills](https://code.claude.com/docs/en/skills) | 本地 stdio、远程 HTTP 等。[MCP](https://code.claude.com/docs/en/mcp) | 有 SessionStart、PreToolUse 等运行时事件。[Hooks](https://code.claude.com/docs/en/hooks) | Skill + MCP 可独立使用；Hook 加成单独配置。不要把 Claude 专属 frontmatter、动态上下文语法带入公共核心。 |
| Codex | 仓库及用户 `.agents/skills`，支持符号链接。[Skills](https://learn.chatgpt.com/docs/build-skills) | stdio、Streamable HTTP，配置和活动连接状态分别查看。[MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | 当前文档支持 command、mcp_tool；prompt/agent handlers 被解析但跳过。[Hooks](https://learn.chatgpt.com/docs/hooks) | Skill + MCP 是基线；不要沿用“Codex 没有 Hooks”的过时判断，也不要推断 Claude Hook 文件全兼容。 |
| Cursor | 自动发现，模型按相关性加载，可显式调用。[Skills](https://cursor.com/docs/skills) | stdio 与远程服务器，支持程序化注册。[MCP](https://cursor.com/docs/mcp) | 独立 hooks 配置及事件载荷。[Hooks](https://cursor.com/docs/hooks) | 官方支持 Agent Plugins 与 Cursor Plugins；标准变量仍有实现差异，官文提示使用 CURSOR_PLUGIN_ROOT。[Plugins](https://cursor.com/docs/plugins) |
| VS Code / Copilot | 原生 Agent Skills，支持自动或 slash 调用。[Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills) | 本地/远程，配置、信任、工具启用有独立流程。[MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers) | VS Code Hooks UI 仍标 Preview；Local/Copilot/Claude/Codex 由不同 Harness 实现。[Hooks](https://code.visualstudio.com/docs/agent-customization/hooks) | 以 session target 为兼容粒度，不能只记录“VS Code 支持”。文件格式兼容不等于 matcher、payload、阻断行为一致。 |
| Gemini CLI | 原生 Agent Skills；`.gemini/skills` 与 `.agents/skills` 别名有优先级。[Skills](https://geminicli.com/docs/cli/skills/) | 工具发现、执行、资源访问。[MCP](https://geminicli.com/docs/tools/mcp-server/) | BeforeTool/AfterTool、SessionStart/End、PreCompress 等，命令通过 JSON stdin/stdout 通讯。[Hooks](https://geminicli.com/docs/hooks/reference/) | 可以从 Skill + MCP 入手；事件名、退出码、工具名前缀和超时单位必须经独立适配。 |
| OpenCode | 原生 skill 工具按需读取；识别 `.opencode`、`.claude`、`.agents` 路径，未知 frontmatter 忽略。[Skills](https://opencode.ai/docs/skills/) | 本地与远程，包含 OAuth 配置。[MCP](https://opencode.ai/docs/mcp-servers/) | TS/JS 插件暴露 tool.execute.before/after、session 等事件。[Plugins](https://opencode.ai/docs/plugins/) | Skill + MCP 作为基线；增强层是 OpenCode 插件 API，不能直接分发 Claude/Codex hooks.json。 |

**分发标准是值得补齐的新机会。** OpenAI、VS Code 与 Cursor 的当前官方文档均已描述 Agent Plugins 可移植包；VS Code 明确把 skills/MCP 列为 portable，把 hooks/agents 等放进客户端命名空间。建议先做标准包和少量生成适配器，再保留已有宿主包作为兼容产物。标准变量及组件支持仍需实测。[OpenAI packaging](https://developers.openai.com/plugins/build/plugins)、[VS Code plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)、[Cursor plugins](https://cursor.com/docs/plugins)

### 通用脚手架核验补充

同级 `craft-common-use` 已实现无 Hook 的 Skill + MCP 安装入口，不应重新造一个安装器。其 README 明确不承诺每个任务自动开始/结束各调用一次；`agents.mjs` 已有以下五个适配声明。本轮只读检查代码与 README，未重新安装或进入宿主验证；README 记载的历史安装结果不升级为本轮 live_verified。[README](../../../craft-common-use/README.md)、[agents.mjs](../../../craft-common-use/agents.mjs)

| 宿主 | 已存在的仓库适配 | 本轮证据级别 |
| --- | --- | --- |
| Cline | 用户级 MCP JSON，用户/项目 Skill 目录 | source_inspected；未测真实会话 |
| Qoder | 用户/项目 settings.json 与 Skill 目录 | source_inspected；未测真实会话 |
| Trae | 项目 MCP 与 Skill，空格路径兼容说明 | source_inspected；未测真实会话 |
| WorkBuddy | 用户级 MCP 与 Skill，command/args 绑定 Trust 提示 | source_inspected；未测真实会话 |
| DSH | cordis.patch.yml loader 块与 tool-management/skills | source_inspected；未测真实会话 |

脚手架当前探针确实执行 `initialize` + `tools/list`，其中声明协议版本为 `2024-11-05`；该探针验证子进程与工具列表，不能验证宿主是否信任加载、Skill 是否生效或完整四组件工作流。建议在现有探针上增加协议版本适配及独立的宿主工作流验收，而不是取消现有有用的进程检查。[init.mjs](../../../craft-common-use/init.mjs)


Craft 当前源码的 MCP preferred revision 为 `2025-11-25`，`2026-07-28` 仅列为 assessed revision，不能宣称已实现新版本。服务端协议升级、common-use 探针与客户端兼容矩阵应一起验收；当前使用旧版不是自动判定为故障。[当前协议实现](../../core/distribution-and-first-run.ts)（106–167 行）
