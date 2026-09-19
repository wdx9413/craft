# Capability 扩展协议：进程内的能力契约

> 状态：`src/capability-protocol.ts` 已实现并有 100% 分支覆盖测试；`capability/craft-experience` 与 `capability/craft-knowledge` 是两个完整形态的能力包，`craft-memory` 尚未成为能力包（原因见末节）。基线 v0.12.33。

## 为什么需要它：MCP 是对外协议，不是内部协议

Craft 通过 MCP 触达外部宿主，这是对的：稳定的产品名、有界的工具面、一套 syscall 词汇。但**进程内的组件之间不该用 MCP 互相寻找**。那样做意味着用字符串命名能力、用正则发现它、到调用时才知道它的形状——这正是 `SURFACE_RULES` 与 `service-foundation.ts` 今天在做的事，而两者都被实测出会误导：

- `service-foundation.ts` 曾经内联构造 30+ 个内核，其中 9 个属于 knowledge 与 memory，因此**能力既无法被添加也无法被省略**——删掉一行只会留下 `undefined` 属性，等到调用时才暴露。
- `SURFACE_RULES` 用**工具名**判断归属，**重排规则就能把四个工具在域之间搬家**，而没有任何东西会报出来。

所以有第二层：一个**进程内、由编译器检查**的契约，由能力声明它装配什么、拥有什么、向上下文贡献什么、在任务结算时做什么。

## 能力是什么

`CraftCapability` 有五个成员，各自替换一种此前只靠约定的东西：

| 成员 | 替换了什么 | 被实测出的问题 |
| --- | --- | --- |
| `register` | `service-foundation.ts` 内联构造 30+ 内核 | 9 个属于 knowledge 与 memory，两者都无法被省略 |
| `owns` | `SURFACE_RULES` 按**名字**判断归属 | 重排规则让四个工具换了域 |
| `contributes` | 上下文 surface 正则暗示谁在上下文里 | 决策只读 `intents.has("knowledge")`，于是 memory 在 surface 里却不在决策里 |
| `hooks` | 由宿主提交的 turn proposal | 无内容且不被编排，因此没有东西自动累积 |
| `product` | — | 有界 MCP 产品名，与能力一一对应 |

## 装配：core 是参数，因为能力不能拥有它运行的环境

`buildCapabilityRegistry(capabilities, core)` 中 `core` 是宿主进程自己贡献的内核（store、由设置推导出的模型目录），在**任何能力之前**注册。存在这个参数是因为能力只能 `require` 环境、不可能 `provide` 它：store 与模型目录在能力集确定之前就已决定。

由此得到两条**有测试**而不是只有注释的性质：

- **删掉一个能力，`require` 报出它欠下的内核名**（`kernel is not registered: experience.ledger`），而不是留下 `undefined` 属性。这是整个契约存在的理由。
- **能力无法顶替环境**：声明 `core.store` 会与核心条目冲突并以 `kernel already registered: core.store` 失败，而不是"后注册者胜"。

`src/capability-catalog.ts` 是核心**唯一**点名能力的地方，且只点描述符、不点内核。它是静态清单而不是目录扫描：扫描会让"装配出哪个 Craft"取决于运行时的文件系统，于是打包产物、bundle 插件和 checkout 可能各自装出不同的 Craft 而没有 diff 可看。

## 归属（`owns`）不是投影（`component-*`）

这两个问题**故意不同**，而且这个差异本身是有用的信号：

| | 回答 | 约束 |
| --- | --- | --- |
| `owns` | **谁实现了它** | 必须为真，所以故意写窄 |
| `component-*` surface | **加载这个产品的宿主能看到什么** | 可以比归属更宽 |

实测出的两处不一致，都已修：

- `component-experience` 的旧字面量匹配不到任何 `craft_experience_ledger_*`——**经验账本是 experience 的写入侧**，却无法通过以它命名的产品访问。
- `component-knowledge` 匹配不到 `craft_project_*`，而 knowledge 包七个内核里有两个（`project-knowledge`、`project-brain`）服务这些工具。产品无法触达它自己能力包里的两个内核。

两处都因为没有东西可检查而长期无人发现：归属与投影之间原本没有任何关系。现在 `component-experience` 与 `component-knowledge` 的投影由能力声明的族推导（`ownership.ts`），并且有测试断言"`owns` 匹配到的每个工具都在投影里"。

`component-context` 仍组合**冻结的**旧名字空间：它是较旧、较窄的投影，其成员资格是**兼容面**，为与它无关的理由改变既有宿主看到的东西不是清理。`ownership.ts` 因此导出两个常量，差异是记录在案的**决定**而不是疏忽。

`context_resolution` 与 `retrieval_adapter` 由两个投影共享、**不属于任何能力**：宿主只装一个关注点时，仍然要能解析那个关注点持有的材料。

## hook：正交轴，以及它如何支撑单点能力埋点

hook **不是写后回调**。它是流程上的扩展点，而流程在工作的两侧都有要紧的阶段：某条规则需要**在工具调用之前**看到它才能拦住，某条经验需要**在任务结算之后**写才有价值。早期草案只定义了 `AccumulationHook` 并挂在任务完成上，这与它自己的框架矛盾——框架里 hook 是正交轴（**何时**），与 permission / tool / context（**什么**）并列。

八个阶段按流程顺序：`turn_start`、`context_resolve`、`capability_discover`、`permission_check`、`tool_before`、`tool_after`、`task_settle`、`turn_end`。

三条让 hook 可以安全挂在任何位置的规则：

1. **只有 gating 阶段可以拒绝。** 只有 `permission_check` 与 `tool_before`——两者都站在某个效果前面。在别处 `denied` 无物可拒（工具已经跑了，或回合已经结束），因此是**契约违反**而不是决定，在装配期就拒绝，而不是运行时静默忽略。
2. **一次拒绝停止该阶段。** gating 阶段里后续 hook 不再运行，因为它们要决定的效果已经不会发生。
3. **抛出的 hook 是 `unobserved`，不是失败。** 累积是侧信道；坏掉的 hook 不能改变它所观察的工作的结果。调用方以 outcome 形式收到它，可见但不承重。

### 埋点：三件已落地，以及它接在哪里

hook 的调用点是 **MCP `tools/call`**，实现在 `src/hook-plane.ts`（`HookPlane`）。这一层独立于 `capability-protocol.ts`，因为协议必须是第 1 层模块、不能知道工具表，而进入一个阶段需要知道工具的能力归属。

| 要体现的 | 实现 |
| --- | --- |
| 能力归属 | `buildCapabilityRegistry` 装配时把 `owned` 写到每个 hook 上（**注册表是唯一写者**，hook 自己声明的 owner 会被覆盖），`PhaseResult.outcomes` 同时给 `capability` 与 `hook` |
| 阶段可见性 | `HookContext.scope_kind` / `scope_id` 改为**可选**：MCP 边界上一次调用可能不属于任何任务，编一个 scope 会把未被观测的事实写进埋点记录 |
| 结果可观测 | `HookPlane.records` 每次进阶段记一条**无内容**记录：phase、跑了几个 hook、是否被拒、涉及哪些能力；不含工具名、参数与结果 |

`tool_before` 是 gating 阶段，所以"hook 能拦住一次工具调用"在这里从注释变成事实：被拒时**不派发**，`tool_after` 也不跑（它要决定的效果已经不会发生）。测试走 `McpServer.handle` 这条真实入口，让拒绝必须走完全程才算数。

`input_digest` 由工具名与参数的摘要导出——**摘要本身即无内容**，与 `prompt_digest` / `request_digest` 同一纪律。`capability.name` 取 `ownerOfTool(tool)`；**没有归属时该字段省略而不是填占位符**，否则记录会声称一个能力参与过，而它没有。

`ownerOfTool` 也让归属声明变成流程实际使用的东西：埋点按**能力**聚合，答案来自声明本身，而不是另一张可能与之矛盾的表。

`contributes` 只能贡献**累积型**成员，`buildCapabilityRegistry` 会拒绝其他情况（`context_resolution` 之前，这个约束只是文档里的一句话）。`history` 属于宿主、`state` 属于运行中的任务，两者永远不是能力的。

## 包布局与分层

```text
capability/
  craft-eval/               评测入口（suite / run / recurrence / abstraction / cases / model）
  craft-knowledge/          Knowledge 能力包：capability.ts + ownership.ts + 7 个内核 + package.json + tsconfig.json
  craft-experience/         Experience 能力包：capability.ts + ownership.ts + 3 个内核 + package.json + tsconfig.json
```

`audit-layering.ts` 覆盖 `capability/`，且**能力包按第 1 层计**：能力拥有内核、只装配自己拥有的内核，因此可以用 infrastructure 与领域内核，但**不得**导入 `application/` 或 `interfaces/`。理由是方向：能力由核心发现，若能力能反过来导入发现它的门面，依赖就双向成立，两边都无法单独替换。

这条规则是**扩展审计遍历范围**才成立的：此前审计只走 `src/`，把内核搬出 `src/` 就会让它静默脱离检查——正是该脚本被重写时要堵住的"换个位置就让规则失效"。扩展后用探针证伪过：`capability/_probe-upward.ts` 导入 `src/interfaces/mcp-server.ts` 时审计报出该边并退出 1。

## 三个累积成员都已落地，以及拆分是怎么做的

`craft-experience`、`craft-knowledge`、`craft-memory` 现在都是能力包。三者都能被声明，靠的是**沿上下文成员边界**切开一个类，而不是按代码量切：

| 原来 | 现在 | 归属 |
| --- | --- | --- |
| `knowledge-memory-runtime.ts` 的 Source 部分 | `capability/craft-knowledge/knowledge-source-registry.ts` | knowledge 包 |
| 同一类的 Ledger 部分 | `capability/craft-memory/memory-ledger.ts` | memory 包 |
| 同一类的读取部分 | `src/context-resolution.ts` | **核心** |

读取侧必须留在核心，理由由投影本身给出：`component-knowledge`、`component-memory`、`component-context` 三个产品都暴露 `craft_context_resolution_*` 与 `craft_retrieval_adapter_*`。只装一个关注点的宿主仍然要能解析那个关注点持有的材料，所以它不能属于任一成员的包。相应地两个包都**不**声明 `contributes`——同一成员有两个贡献者会被 `buildCapabilityRegistry` 直接拒绝。

memory 包另有一个 `memory.signals` 内核（`memory-signals.ts` + `memory-signals-kernel.ts`），承载 recall 历史的派生信号（衰减权重、融合排序、捕获策略、旧记录晋级计划、用量证据）。它原本是 `src/memory-wiring.ts` 的纯函数加门面薄包装，**搬进包里就能声明**——这正是"归属要是事实而不是愿望"的意思。

**memory 仍有未声明的部分，且是刻意记下的**：`MemoryConsolidationKernel`（`craft_memory_consolidate` / `_resolve` / `_search` / `_remember_episode`）是核心里的另一个内核，`craft_memory_remember` 与 `craft_memory_transition` 由 `WorkbenchKernel` 服务（旧的 `memory_item` 集合，不是 Ledger）。这些只被投影、不被声明。**这里有一处我自己犯过又修掉的错**：`MEMORY_OWNS` 一度把 `craft_memory_remember`/`_transition` 当作"Ledger 的旧名字"声明，而测试也这么断言了——直到读 handler 映射表才发现它们服务的是另一个内核。一个"看起来合理"的声明正是归属模式要拦住的东西。

## 共享助手的合并纪律

拆分的前置是给共享助手找归宿，而纪律是**只在行为一致处合并**：

| 助手 | 份数 | 不同写法 | 不同**行为** | 结论 |
| --- | --- | --- | --- | --- |
| `canonical` | 18 | 14 | **1** | 合并为 `digest.ts` 的 `canonicalJson` |
| `canonical` 型 `digest` | 17 | 1 | **1** | 合并为 `stableDigest` |
| `craft-service.ts` 的 `fingerprint` | 1 | 1 | 同算法但**公开形状不同**（裸 hex） | 保留 |
| `strings` | 30 | 6 种签名 | ≥3 | 只合并一致的那 2 份为 `sortedUniqueList` |
| `noSecret` | 4 | 4 | **3** | 只合并一致的 2 份为 `noCredentialAssignment` |
| `scope(args)` | 2 | 2 | **1** | 合并为 `parseScope` |

结论的形态值得记住：**按名字合并和按行为合并是两件事。** `digest` 有五种行为，所以它的副本在做不同的事；`canonical` 只有一种行为、14 种写法，副本只是写得不一样——两者对同一种测量给出相反结论。`strings` 的 `required` 变体里 `stateful-compute.ts` 多一道 `required && !result.length` 守卫，合并会让两个从不抛错的模块开始抛错，所以那道差异留在原处并由测试钉住（`tests/validation.test.ts`）。

## 关联

- [上下文的五个成员](context-members.md)：`contributes` 与 `hooks` 服务于哪些成员。
- [组件插件架构](component-plugin-architecture.md)：Runtime / MCP / Plugin / Skill 的分工与产品投影。
- [可插拔能力源](pluggable-capability-sources.md)：能力从哪些来源接入（与"进程内能力"是不同的问题）。
- [分层与目录地图](../../architecture/layer-map.md)：分层规则与 `capability/` 的层级。
- ADR：[归属不是投影](../../adr/0009-ownership-is-not-projection.md)、[hook 属于流程](../../adr/0010-a-hook-belongs-to-the-flow.md)、[共享助手只在行为一致处合并](../../adr/0011-merge-shared-helpers-only-where-behaviour-agrees.md)
