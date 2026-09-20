# Craft 分层与目录地图

本文记录当前代码的职责边界，不改变版本号或运行时协议。目录按“入口 → 应用 → 领域 → 基础设施”理解；历史导入路径仍由根目录兼容导出保留。

## 命名：路径里不写版本号

模块按**职责**命名，版本信息只存在于 `package.json`、`CHANGELOG.md` 与各 manifest。

此前每个版本会新增一个 `vNNNNN-*.ts` 模块并配一条 `test:vNNNNN` 脚本，于是文件名记录的是“哪个版本加的”而不是“这个模块做什么”，且版本号在发布后仍永久留在路径里。这些文件已按职责改名（例如 `v01236-verification.ts` → `verification-sensor.ts`、`v01211-runtime.ts` → `continuous-runtime.ts`）。

`scripts/check-version.ts` 现在会把任何形如 `src/vNNNNN-*.ts` 的新文件判为构建失败，所以约定由门禁维持，而不是靠记忆。

## 依赖方向由脚本强制

`scripts/audit-layering.ts`（`pnpm run audit:layering`，已接入 `test` 链与 CI）按层级排序检查导入方向：**内层不得导入外层**。它对每个文件判定其所在层，再与该次导入的目标层比较——因此把违规文件搬进 `application/` 无法让检查静默通过。

未在下列豁免清单中的向上导入会直接失败。清单中的条目一旦不再出现也会失败，避免豁免比它描述的问题活得更久。

当前豁免 1 处：`src/application/service-foundation.ts` 指向 `src/interfaces/canonical-tools.ts` 的依赖（后者转出 `mcp-server` 的工具表，需要先把该表移到中立模块）。

审计同时覆盖 `capability/`（能力包目录）。**能力包按第 1 层计**：能力拥有内核、只装配自己拥有的内核，因此可以用 infrastructure 与领域内核，但**不得**导入 `application/` 或 `interfaces/`。理由是方向：能力由核心发现，若能力能反过来导入发现它的门面，依赖就双向成立，两边都无法单独替换。此前这些文件在 `src/` 下时本来就在审计范围内，若搬迁时不扩展遍历，把内核移出 `src/` 就会让它静默脱离检查——正是该脚本被重写时要堵住的“换个位置就让规则失效”。扩展后已用探针证伪：`capability/_probe-upward.ts` 导入 `src/interfaces/mcp-server.ts` 时审计报出该边并退出 1。

此前豁免 5 处，其中 4 处已按清单自己写明的修法消除：`service-foundation.ts` 原先位于 `src/` 根，却导入 `application/coordinators/*` 四个 Coordinator。它只被 `src/application/craft-service.ts` 唯一导入，因此已迁入 `application/`；层级随之相等，那 4 条依赖不再构成向上导入，豁免条目也一并删除（而不是留到被报为 stale）。第 5 条指向 `interfaces/`，层级仍然更高，因此迁移后依然成立并保留。

```text
capability/                 能力包：拥有内核、声明归属、按协议被核心发现
  craft-eval/               评测入口（suite / run / recurrence / abstraction / cases / model）
  craft-knowledge/          Knowledge 能力包（有 package.json 与 tsconfig.json）
    ownership.ts            归属族、product 投影与冻结的 context 投影，不导入任何东西
    capability.ts           CraftCapability：name / product / owns / register
    knowledge-workbench.ts  有界只读 Workbench 投影与 Context Bundle 预览
    knowledge-bound-launch.ts   绑定某个精确 Context Bundle 的 Work Launch，宿主运行前重新校验
    knowledge-relation.ts   知识对象之间带 Evidence 的类型化关系
    wiki-candidate-governance.ts 证明、发布授权与可移植包准备
    local-candidate-import.ts   把已审核的包写入用户指定路径，不执行
    project-knowledge.ts    Markdown 索引投影、检索与 scope 过期
    project-brain.ts        项目目标、决策、绑定材料与结果记录
  craft-experience/         Experience 能力包（有 package.json 与 tsconfig.json）
    ownership.ts            归属族与 product 投影，不导入任何东西
    capability.ts           CraftCapability：name / product / owns / register
    experience-ledger.ts    内容无关的经验观察与诊断模式
    workflow-evolution.ts   脱敏执行观察与有界模型提案请求
    evaluation-model-profile.ts  评测所用的无凭据模型配置
interfaces/                 外部协议入口
  mcp-server.ts             MCP 工具定义、分发与错误映射
  mcp/surface-registry.ts   Domain / Component / Syscall surface 投影
  mcp/runtime-handlers.ts   Runtime 与 Adapter handler 注册
  mcp/work-handlers.ts      Work / Host / Task handler 注册
  mcp/evaluation-handlers.ts Evaluation / Acceptance handler 注册
  mcp/workspace-handlers.ts Workspace / Transaction handler 注册
application/                用例与应用门面
  craft-service.ts          CraftService 兼容门面与跨域编排
  service-foundation.ts     内核装配基座（原 src/ 根；迁入后 4 条 Coordinator 向上导入消失）
  coordinators/             Work / Runtime / Evaluation / Workspace 应用上下文
  use-cases/                按领域安装的用例组（Adapter、Trace、Knowledge、Memory 等）
domains/                    稳定业务内核的命名空间分组
  index.ts                  controlPlane / execution / evidence / knowledge / integration
infrastructure/             持久化、路径和运行环境
  index.ts                  CraftStore / CraftPaths 入口
  store.ts                  SQLite 存储内核（原 src/ 根）
  store-migrations.ts       迁移表与备份（原 src/ 根）
  paths.ts                  CraftPaths 布局（原 src/ 根）
mcp/                        共享协议契约
  tool-schema.ts            Tool 类型与参数 Schema 工厂（原 interfaces/mcp/ 下）
根 src/*.ts                 现有领域内核与基础设施原语
  capability-protocol.ts    进程内扩展协议（CraftCapability / Hook / runPhase）
  capability-catalog.ts     内置能力集，核心唯一命名能力的地方
```

## 能力包的装配规则

`src/capability-protocol.ts` 定义能力是什么（名字、归属、`register`、可选上下文贡献、生命周期 hook），
`src/capability-catalog.ts` 是核心**唯一**点名能力的地方，且只点 `CraftCapability` 描述符，不点内核。

`buildCapabilityRegistry(capabilities, core)` 里 `core` 是宿主进程自己贡献的内核（store、设置推导出的模型目录），
在任何能力之前注册。存在这个参数是因为**能力不能拥有它运行的环境**：store 与模型目录在能力集确定之前就已决定，
能力只能 `require`、不可能 `provide`。由此得到两条可测性质：

- 删掉一个能力，`require` 会报出它欠下的内核名（`kernel is not registered: experience.ledger`），而不是留下
  `undefined` 属性等到调用时才暴露。
- 能力无法顶替环境：声明 `core.store` 会与核心条目冲突并以 `kernel already registered: core.store` 失败，
  而不是“后注册者胜”。

`craft-experience`、`craft-knowledge`、`craft-memory` **三个累积成员都已落地为能力包**。`craft-memory`
曾经无法被声明，原因记在 `capability-catalog.ts` 里：`knowledge-memory-runtime.ts` 是**一个类同时服务两个成员的写入**
（knowledge 侧 `installBuiltins`/`sourceRegister`/`sourceList`/`sourceTransition`，memory 侧
`remember`/`transition`/`compatBind`/`get`），因此它既不属于 knowledge 包也不属于 memory 包。
v0.12.43 沿**成员边界**把它切成三块：Source 注册表进 knowledge 包、Ledger 进 memory 包、
`src/context-resolution.ts` 留在核心（读取侧被三个产品共同投影，所以不属于任一成员）。
memory 的派生信号原本是 `src/memory-wiring.ts` 的纯函数加门面薄包装，v0.12.43 一并搬进包里成为
`memory.signals` 内核，因此那些族现在**可以**被声明。仍未被声明的是 `MemoryConsolidationKernel` 的四个族，
以及由 `WorkbenchKernel` 服务的 `craft_memory_remember`/`_transition`——名字记在
`capability/craft-memory/capability.ts` 里。

这条推理与能力协议的完整说明见 [Capability 扩展协议](../technical/modules/capability-protocol.md)；
五个上下文成员各由谁持有见 [上下文的五个成员](../technical/modules/context-members.md)。

由此产生**归属与投影的区分**，两者故意不同，且这个差异本身是有用的信号：

- **`owns`（归属）** 回答“谁实现了它”。它必须为真，所以故意写窄：knowledge 包不声明
  `craft_knowledge_claim_save`，因为实现它的是 `craft-service.ts` 门面而不是本包装配的内核。
- **`component-*`（投影）** 回答“加载这个产品的宿主能看到什么”。它可以比归属更宽：宿主只装 Knowledge
  产品时仍然需要自己的 Source。

`component-knowledge` 因此**新增了 `craft_project_*`**：knowledge 包七个内核里有两个（`project-knowledge`、
`project-brain`）服务 `craft_project_knowledge_*` 与 `craft_project_brain_*`，而旧的名字空间一个都匹配不到——
产品无法触达它自己能力包里的两个内核，且没有任何东西会报出来，因为归属与投影之间原本没有任何可检查的关系。
`craft_project_*` 在 `SURFACE_RULES` 里本就属于 `knowledge` 域，所以这是让产品与域对齐，不是跨界。
`component-context` 仍组合**冻结的**旧名字空间（见 `craft-knowledge/ownership.ts` 与
`craft-memory/ownership.ts` 里各自两个常量的说明），避免为与它无关的理由改变既有宿主看到的东西。
`component-memory` 也修了一处同类不一致：`craft_knowledge_memory_install_builtins` 与
`craft_knowledge_bootstrap_install` 是同一个 handler 的两个名字，旧字面量只匹配后一个，于是
宿主能用一个名字 bootstrap 而不能用另一个。

**关于根目录的实情。** 上面的层目录目前主要是入口与再导出，绝大多数实现仍在 `src/` 根下（约 168 个模块，层目录内约 36 个）。因此上表的含义是“导入方向规则”，不是“文件已经在这些目录里”。逐步迁移才刚开始，尚无时间表。

`store.ts`、`paths.ts` 与 `store-migrations.ts` 已迁入 `infrastructure/`。此前 `infrastructure/index.ts` 因此被列为再导出豁免：它转出的 `store.ts`、`paths.ts` 本是基础设施实现却位于根目录，于是按层排序会读成“向上导入”。三者移入后该入口只导入本层，**豁免已删除**。移动 `store.ts` 还暴露出 `store-migrations.ts` 的同类问题——`infrastructure/store.ts` 反向依赖根目录的它，被审计判为向上导入；它同样是纯持久化模块，因此一并下移，而不是新增一条豁免。

## 依赖规则

- `interfaces` 只依赖 `application` 和共享类型，不直接拼接数据库或执行外部副作用。
- `application` 负责用例编排、权限和交付门，不承载协议格式细节。
- `domains` 保存可测试的策略和状态转移；同一领域内核不通过 MCP 互相调用。
- `infrastructure` 提供存储、路径、进程和平台适配；领域代码通过明确接口使用它。
- Trace/Evidence 是横切事实链：动作、工具、验收和结果必须带同一关联标识。

## v0.12.34 概念层与代码层收敛

代码分层应服从领域关系，而不是把每个 MCP 名字都当作一个内核：

```text
interfaces（MCP / CLI / plugin projection）
        ↓
application（commands / queries / coordinators）
        ↓
domains
  control      Goal / Task Contract / Policy / Budget / Lifecycle
  context      Knowledge / Memory / Experience / Resolution / Retrieval
  capability   Asset / Connector / Activation / Kit / Health
  execution    Runtime / Host / Action / Receipt / State / Recovery
  quality      Verification / Acceptance / Evaluation / Attribution
  evolution    Pattern / Candidate / Signoff / Canary / Rollback
        ↓
infrastructure（SQLite / Markdown / Trace archive / platform adapters）
```

这里的边界有三个硬规则：

1. `Agent = Model + Harness`；Harness 是一次工作的策略组合，使用 Runtime，不拥有 Runtime。`Context` 是可追溯投影，`State` 才是控制态和工作区态事实源，二者不能互换。
2. `craft-memory`、`craft-knowledge`、`craft-capability`、`craft-quality`、`craft-experience` 是能力投影，不应各自复制 Store、Policy、Trace 或 Eval。只读查询可以直接走组件 MCP；写入、发布和外部 effect 必须回到 Control Plane 与 Verified Work Loop。
3. Capability Adapter 负责外部差异（MCP、Serena、Codex、Claude、向量服务），Core Kernel 负责不可绕过的事实、策略和证据。把共享内核搬进能力包只会造成第二套账本，不能因为“可插拔”而移动。

当前仍需收敛的结构债务：`src/application/craft-service.ts` 约 4500 行，应按 commands/queries/coordinators 渐进拆成薄门面；`service-foundation.ts → interfaces/canonical-tools.ts` 的单向依赖豁免应通过把工具目录移到中立 `mcp/tool-catalog` 消除；`distribution-and-first-run.ts` 应拆为 credential/config、readiness、protocol negotiation、platform probe 和 release plan 五个职责。只在每次拆分都能保持现有契约和测试证据时迁移，不能为了目录整齐复制实现。

### 版本边界

发布版本、数据/Schema 版本和外部协议版本是三类不同身份：

| 类型 | 示例 | 规则 |
| --- | --- | --- |
| Product release | `package.json`、插件 manifest、Marketplace release | 只能有一个发布源，其他文件由门禁或构建生成 |
| Schema/adapter version | `compiler_version`、`RUNTIME_VERSION`、manifest schema | 与产品版本解耦，只有契约变化才升级 |
| Protocol version | MCP/A2A 的日期或协议号 | 由协议适配器声明，不能被当成 Craft 发布版本 |

v0.12.34 已将产品发布号集中到 `src/version.ts`，并由发布门禁校验 CraftService、组件 package、Codex/Claude manifest、MCP serverInfo、Marketplace 和插件 bundle。Adapter/Compiler 使用独立的 Schema 版本，MCP/A2A 继续使用协议版本；历史模块注释只作为变更记录，不参与当前能力宣称。

## 兼容与拆分策略

`src/service.ts` 与 `src/mcp.ts` 是稳定的薄兼容入口，真实实现分别位于 `src/application/craft-service.ts` 和 `src/interfaces/mcp-server.ts`。第三方继续使用旧路径不会失效；后续新增代码应从分层入口或具体领域模块导入，避免再把门面做成新的上帝模块。这两个文件，加上 `domains/index.ts`、`infrastructure/index.ts`，是审计脚本中按构造豁免的再导出入口。

大型实现文件仍会按领域边界渐进拆分，每次拆分都通过类型检查、完整测试和适配器 smoke test 验证。MCP 的工具 Schema、Surface Registry 和 Runtime / Work / Evaluation / Workspace Handler 已从协议服务器中抽出；应用层也已建立四个 Coordinator 上下文，先集中依赖再逐步迁移编排方法，仍由同一个兼容分发入口承接。

由版本号堆叠出来的模块（`v01211`、`v01213`、`v01233` 等）虽然已按职责改名，但其中数个仍是“一个文件装多个内核”的形态。改名解决了路径里的版本号，**没有**解决文件内部的职责内聚；真正的拆分是后续工作。

**已完成一处。** `continuous-runtime.ts` 曾同时装 8 个互不相关、彼此零耦合的内核：上下文平面、重放、本地服务生命周期、项目包、反馈学习、域评估、交接清单、成本账本。它已被拆成 8 个按职责命名的模块（`context-plane.ts`、`replay-runner.ts`、`local-runtime-service.ts`、`project-bundle.ts`、`feedback-learning.ts`、`domain-evaluator.ts`、`handoff-manifest.ts`、`cost-ledger.ts`），5 个引用者按内核归属重新分组 import。

拆分过程中两个助手的归宿不同，取决于被使用的方式而非名字：`positive` 只被一个内核调用，随 `project-bundle.ts` 一起搬走；而带唯一性检查的 `list` 被两个内核使用，因此提升为 `validation.ts` 的 `uniqueList`——它与那里的 `list` 契约不同：`list` 把 `undefined` 视为缺省且容忍重复，`uniqueList` 直接拒绝重复值。同名不同契约正是此前抽取时把它们分开的原因。

仍待拆分的是 `distribution-and-first-run.ts`：它同时含凭据解析、首次运行就绪、MCP 协议协商、隔离能力探测与分发计划五件事。

拆分的前置——抽出共享校验助手——已部分完成。`src/validation.ts` 提供 `text`、`object`、`list`，从 129 个文件里移除了 158 份逐字重复的定义（`text` 122、`object` 35、`list` 1）。

但“各文件的副本签名并不一致”经实测只对了一半，而剩下的一半**不能**按名字合并：

- `object(value, name)` 的 35 份函数体完全一致。
- `text(value, name)` 的 131 份里 122 份一致；其余 9 份是真的不同——`parser-process.ts` 返回未 trim 的值，`trajectory.ts` 额外做了 SECRET 检查，另 6 份有后续处理。它们各自保留实现。
- `list(value, name)` 的 8 份里只有 1 份一致；其余 7 份契约不同（含 `verification-plane.ts` 要求非空数组而非把 `undefined` 视为缺省），因此基本没有合并。
- `canonical` 有 18 份、**14 种写法但只有 1 种语义**（数组按序、对象键按 `localeCompare` 排序、其余走 `JSON.stringify`；差异只在参数名与折行）。因此**合并**为 `digest.ts` 的 `canonicalJson`——与 `digest` 的结论相反，差别本身就是结论：`digest` 有五种**行为**，`canonical` 只是一个书写问题。
- 依赖它的摘要 17 份写法一致（都带 `sha256:` 前缀），合并为 `stableDigest`。第 18 处不是它们之一：`craft-service.ts` 的 `fingerprint` 用同一套序列化但返回**裸 hex**，且调用方自己补 `sha256:`，因此保留原名——它有**不同的公开形状**，不是不同的算法。
- `strings` 有 30 份、至少 6 种签名，**不合并**。其中带 `required` 的 3 份里有 2 种行为：`stateful-compute.ts` 多一道 `required && !result.length` 守卫，合并会改变行为，所以这一道差异留在原处并记录在案。
- `noSecret` 有 4 份、**3 种行为**（守卫词表、长度下限、返回类型各不相同），**不合并**。

`digestJson` 与 `stableDigest` 不可互换：`digestJson({a:1,b:2})` 与 `digestJson({b:2,a:1})` 不同，而 `stableDigest` 相同。Craft 用摘要做内容寻址，**选错会静默改变记录身份**，所以两者必须分开命名并有各自的测试。

合并 18 份 `canonical` 时有一个陷阱被金标测试抓住：`undefined` 在**数组元素**位置被 `Array.join` 渲染成空串，在**对象值**位置被模板插值渲染成文本 `undefined`。位置不同、结果不同，所以 `canonicalJson` 内部的递归必须原样返回 `undefined`（类型 `string | undefined`，不导出），由外层保证返回字符串或**按名报错**。顶层 `undefined` 在原实现里会让 `Hash.update` 抛 `ERR_INVALID_ARG_TYPE`（错误信息指向 crypto 而不是入参），现在报 `canonicalJson cannot serialize undefined`——这是本次合并唯一的行为变化，且只影响原实现同样无法序列化的入参。
- `strings` 有 9 种签名、`integer` 有 9 种，同样各自保留。

`digest` 的命名分歧**已经决定并落地**：`digestJson`（键序敏感）与 `stableDigest`（键序无关）两个名字，前者 81 份、后者 17 份，各自的契约由 `tests/digest-canonical.test.ts` 钉住。那个模块此前**没有任何测试直接引用它**，而它的全部意义就是“选错会静默改变身份”——现在有 4 个测试，含一组从合并**之前**的实现取来的金标摘要，因为“合并没改变身份”这件事不能靠新实现自证。

因此内核拆分的前置已经就位，可以继续。


## Memory / Knowledge 的分发决策

Memory 和 Knowledge 的真实能力以 MCP component surface 为协议真相：`component-memory` 与 `component-knowledge` 可以被 Codex、Claude、WorkBuddy、Trae 或独立 CLI 直接接入。插件不是另一套实现，而是宿主分发外壳，负责 Skill、图标、默认提示、权限和安装元数据。

因此保留两种形态，但职责不同：

- 只需要调用能力时，优先使用 MCP，适配成本最低、跨宿主最好。
- 需要宿主内的路由提示、渐进式上下文和可见入口时，再用薄插件包装同一个 MCP surface。
- `craft-context`、`craft-capability`、`craft-quality` 可以独立安装；完整 `craft` 作为组合插件提供完整 MCP，不复制子插件代码，也不强制所有宿主安装一堆组件。`craft-memory`、`craft-knowledge` 与 `craft-skill-quality` 是兼容投影。

这避免把每个能力同时实现成多套插件协议。未来新增宿主只需做一个薄包装器，核心能力和安全边界仍由同一份 MCP/Service 实现提供。
