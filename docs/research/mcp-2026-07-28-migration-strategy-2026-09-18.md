# MCP 2026-07-28 迁移策略（2026-09-18）

范围：只处理 Craft 作为 MCP **实现方**与**消费方**如何跨越 2026-07-28 规范修订；
不重列 Trace、Verification、Eval、Capability Kit、Remote MCP Access 等既有能力。

本文是**策略与影响面评估**，不是实施记录。在本文被采纳并排期前，Craft 代码不应
发生任何协议行为变更。

## 结论

MCP 2026-07-28 是自协议诞生以来最大的一次修订，且**不向后兼容**。Craft 把
MCP-first 当作架构前提，因此这个前提本身正在变。

但结论不是“立刻全量迁移”。当前代码只实现了 MCP 的最小请求面
（`initialize` / `tools/list` / `tools/call` / `ping`），**恰好落在受影响最浅的位置**：

| 受影响能力 | Craft 当前状态 | 修订影响 | 结论 |
|---|---|---|---|
| `initialize` / `initialized` 握手 | 已实现（版本上限 2025-11-25） | 废弃 | 必须改，但改动局限在一个方法分支 |
| `Mcp-Session-Id` | **未实现** | 废除 | 无需迁移，反而是收益 |
| `elicitation` / `sampling` / `roots` | **完全未实现** | 被 MRTR 取代 | 无需迁移；但设计意图被撞上 |
| Tasks | **未实现** | 移出核心成为扩展 | 需要一次架构决策，不是代码迁移 |
| tools / resources / prompts | 仅 tools | 不变 | 无需迁移 |

真正的两个决策点不是“怎么改代码”，而是：

1. **Craft 的人机审批/长任务模型要不要映射到协议语义？** 若不要，就明确写下
   “Craft 只保证传输层兼容”；若要，`durable-action-loop`、`task-control`、
   `guided-work`、`acceptance` 的既有语义会与 `io.modelcontextprotocol/tasks`
   和 MRTR 的 `input_required` 产生概念重叠，必须先定归属。
2. **兼容窗口如何管理？** 修订版给旧能力 12 个月弃用窗口（最早 2027 年 7 月移除）。
   Craft 需要在窗口内维持双版本，而不是一次性切换。

建议：**做影响面评估 + 定策略 + 加协议版本/兼容矩阵，不做全量迁移。** 这与
[`industry-agent-harness-hotspots-2026-09-14.md`](industry-agent-harness-hotspots-2026-09-14.md)
已有的 P1 判断一致，但把“外部 task 应映射为 Adapter”从一条推论升级为需要排期的
架构决策。

## 行业事实（一手来源）

以下四组变更来自规范所有方，按它们对 Craft 的杀伤半径排序。

### 1. 握手废弃（SEP-2575）

`initialize` / `initialized` 握手被废弃。协议在该修订版转向**无状态**请求模型：
服务端不再依赖一次会话建立来维持上下文，请求自带解析所需信息。

来源：[The 2026-07-28 MCP Specification](https://modelcontextprotocol.io/specification/2026-07-28)。

### 2. 会话标识废除（SEP-2567）

`Mcp-Session-Id` 被废除。客户端的会话亲和不再由传输头承载。

来源：同上；[MCP spec changelog 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)。

### 3. 服务端发起能力被 MRTR 取代（SEP-2322）

服务端发起的 `elicitation/create`、`sampling/createMessage`、`roots/list`
全部由 **MRTR（Multi Round-Trip Requests）** 取代：工具不再在调用中途反向请求
客户端，而是直接返回 `resultType: "input_required"`；客户端补齐输入后**重试原调用**。

来源：同上；[What's new in the MCP 2026-07-28 specification (Appwrite)](https://appwrite.io/blog/post/mcp-2026-07-28)、
[MCP 2026-07-28: The Big Architectural Shift (Aembit)](https://aembit.io/blog/mcp-2026-07-28/)。

### 4. Tasks 移出核心（SEP-2663），roots/sampling/logging 标记弃用

Tasks 从核心协议移出、成为扩展；`roots`、`sampling`、`logging` 标记弃用，
带 12 个月移除窗口（最早 2027 年 7 月）。DCR 转向 CIMD。

来源：[The 2026-07-28 MCP Specification](https://modelcontextprotocol.io/specification/2026-07-28)。

### 5. 迁移是可控工程量，不是重写

官方 Go / C# SDK 已实现向下兼容 shim。

来源：[Announcing v2.0 of the official MCP C# SDK](https://devblogs.microsoft.com/dotnet/announcing-mcp-csharp-sdk-v2/)、
[Evolving a Java MCP Server During MCP Specification Upgrades](https://spring.io/blog/2026/07/28/evolving-a-java-mcp-server-during-mcp-specification-upgrades)。

> 待核：A2A 转入 AAIF 的具体日期（08-17 或 08-20）与 x402 Foundation 成立时间存在
> 来源冲突。本文不依赖这些日期，故不据此下结论。

## 当前 Craft 事实（代码）

### 协议版本是内联字面量，且没有协商矩阵

[`mcp-server.ts`](../../core/interfaces/mcp-server.ts#L1552-L1558)：

```ts
if (request.method === "initialize") {
  const requested = (request.params as JsonObject | undefined)?.protocolVersion;
  const version = ["2025-03-26", "2025-06-18", "2025-11-25"].includes(String(requested))
    ? requested : "2025-11-25";
  return this.ok(request.id, { protocolVersion: version, capabilities: { tools: {} },
    serverInfo: { name: "craft", version: VERSION } });
}
```

事实：

- 版本上限为 `2025-11-25`，且是**内联数组**；仓库内不存在 `LATEST_PROTOCOL_VERSION`
  之类的单一常量。
- 声明能力只有 `{ tools: {} }`，与“只实现 tools”一致。
- 请求一个不在列表里的版本时，**静默回落到 2025-11-25**，不报错、不提示客户端
  降级。这在双版本窗口内会让“服务端不支持”表现为“服务端假装支持”。

同一字面量被 esbuild 复制进 10 个 bundle（`plugins/*/dist/plugin/*.cjs` 第 37861 行），
因此版本事实有 11 份物理副本。消费方侧另有 4 处硬编码 `"2025-11-25"`
（[`adapters/deepseek-harness/index.ts`](../../adapters/deepseek-harness/index.ts#L57)、
`scripts/plugin-smoke.ts`、`scripts/plugin-full-smoke.ts`、`scripts/plugin-component-smoke.ts`）。

### 请求面只有 5 个方法

[`mcp-server.ts:1545-1585`](../../core/interfaces/mcp-server.ts#L1545-L1585) 的 `handle()`
处理集合是：`initialize`、`notifications/initialized`、`ping`、`tools/list`、
`tools/call`；其余一律 `-32601 Method not found`。

由此得出三条对本文重要的结论：

1. **不存在 `elicitation` / `sampling` / `roots` 实现**，因此没有需要迁移的服务端
   反向请求代码。这是当前最大的运气。
2. **不存在任何 session 概念**。`mcp-http.ts` 是无状态 POST 边界，没有 session 头
   解析；`mcp-stdio.ts` 也不维护会话。SEP-2567 对 Craft 是纯收益。
3. **`request.id === undefined` 直接返回 `undefined`**（第 1551 行），即 Craft 把
   “无 id”当作通知丢弃。如果未来需要支持 MRTR 的重试语义，这条短路必须重新审视。

### 关键风险：握手缓冲逻辑会变成遗迹

[`mcp-stdio.ts:19-44`](../../core/mcp-stdio.ts#L19-L44) 在 `await start()` **之前**就挂上
`line` 监听，把初始化期间到达的 stdin 行推入 `pending[]` 缓冲：

```ts
const pending: string[] = [];
input.on("line", (line) => { pending.push(line); wake?.(); });
const runtime = await (options.start ?? start)(options.mode);
```

这段代码存在的**唯一理由**是：宿主进程会立刻发出 `initialize`，而 Craft 的存储
（`CraftStore` SQLite + `CraftService`）尚未打开，若不缓冲就会丢握手。

在无状态协议下，客户端不再有“必须先握手”的预期，这段缓冲的语义前提消失。它不会
立刻出错（缓冲本身对任何输入都安全），但会变成一段**没有理由的复杂度**：后人无法
从代码判断它是否仍必要，也无人敢删。应当在新协议路径落地时明确它的去留，而不是
让它自然腐烂。

### 既有立场：Craft 已声明“与该修订版无关”

[`tool-plane.md:47`](../technical/modules/tool-plane.md#L47) 写道：

> 与 MCP 2026-07-28 修订版无关：该版本不处理 token 税，所以只能由服务端设计面。

该判断在 **token 税**这一议题上仍然成立（修订版确实未处理，相关提案 #2808 /
SEP-1576 已关闭，见 [`craft-v0.12.1-plan-2026-09-13.md`](craft-v0.12.1-plan-2026-09-13.md#L109-L118)）。
但它**不能推广为“整个修订版与 Craft 无关”**——握手、session、MRTR、Tasks 四项
都与 Craft 的传输层和任务语义直接相关。建议在该文档修订时收窄这句表述的适用范围，
避免未来的读者据此跳过迁移评估。

## 对 Craft 的推论

### 推论一：传输层迁移是低风险，但必须消掉 11 份版本副本

需要变更的物理位置集中在 `initialize` 分支，但版本事实散落在 11 个 bundle 与 4 处
消费方硬编码里。最小做法：

- 在 `mcp-server.ts` 引入单一版本常量与**协商表**（不是裸数组），导出供消费方复用；
- 服务端对不受支持的版本返回**显式错误或显式降级标记**，不再静默回落；
- 消费方（`plugin-*-smoke.ts`、deepseek adapter）从同一常量取版本，禁止再写字面量；
- 加一条测试钉住“版本常量只有一处定义”，与既有
  “syscall verb 穷尽性由测试钉住”的既有风格一致。

### 推论二：MRTR 撞上的不是代码，是 Craft 的人机审批模型

Craft 有一整套“人在环”语义：`durable-action-loop`、`guided-work`、
`acceptance` 的人工验收、`task-control` 的 handoff、
[`workbench-server.ts`](../../core/workbench-server.ts#L136-L142) 的
`guided-work/decide` 与 `acceptance-plans/human-review`。

MRTR 的 `input_required` 语义与这些能力**表面相似、归属不同**：

- MRTR 解决的是“**协议层**一次工具调用需要客户端补参数”；
- Craft 的审批解决的是“**治理层**一个 effect 需要人类授权”。

两者不能互相冒充。若把 Craft 的审批降格为 MRTR 的 `input_required`，Craft 就把
授权决策交给了对端客户端，违背 [`runtime-mcp-first-industry-gap-review-2026-09-15.md`](runtime-mcp-first-industry-gap-review-2026-09-15.md)
中“授权和效果由 Craft 拥有”的既有立场。

**建议**：Craft 的审批**不映射**到 MRTR。MRTR 只在 Craft 作为**客户端消费**远程
MCP Server 时才需要处理（对端返回 `input_required` 时，Craft 需要补齐并重试原调用）。
这是一个客户端侧 Adapter 问题，不是内核语义变更。

### 推论三：Tasks 需要一个明确的归属决策，且决定权在“要不要对外”

修订版把 Tasks 移出核心成为扩展，与 Craft 的 Durable Wait / 长任务模型高度重叠，
且明确不向后兼容。要让 Craft 的既有模型去对齐 `io.modelcontextprotocol/tasks`，
必须先回答：**Craft 的长任务是否打算通过 MCP 暴露给第三方客户端？**

- **不暴露**（Craft 自己跑，MCP 只做工具面）→ 只需保证传输层兼容；**不需要**映射
  Tasks。既有 `durable-action-loop` / `task-control` 保持内部模型，MCP 面上不出现
  task handle。这是最小、最自洽的选择，与“单一版本源”“单 Agent 默认”的既有取向一致。
- **暴露** → 需要 Task Binding：外部 task handle 与 Craft Run/Wait/Session 的一次性
  绑定，含 principal、scope、TTL、不可枚举 handle 与审计终态。这与
  [`runtime-mcp-first-industry-gap-review-2026-09-15.md`](runtime-mcp-first-industry-gap-review-2026-09-15.md)
  已定义的 `RemoteTaskBinding` **是同一块设计**，不应另造第二套。

**建议**：先选“不暴露”，把 Tasks 映射列为条件项而非当前缺口。若未来要做远程异步
任务，复用 `RemoteTaskBinding`，不要新开一条并行模型。

### 推论四：兼容窗口需要在插件分发层单独对待

Craft 的插件包把 MCP bundle 固化在 `plugins/craft/dist/plugin/`，宿主从缓存加载
（见 [`README.md`](../../README.md#L154-L156)）。这意味着版本兼容**不是一次 CI 成功
就能覆盖的**：已安装的宿主缓存里可能存在旧 bundle。

**建议**：协议兼容矩阵要作为插件 manifest 的一部分显式声明，让宿主能判断
“这个 bundle 是否支持我的协议版本”，而不是让运行时静默回落。

## 最小交付（建议排期，不在本文实施）

按成本从低到高，前两项是本文的直接产物。

### S0｜影响面评估与策略冻结（本文 + 一次评审）

产出：本文被采纳；明确写下 Tasks 是否映射、MRTR 只在客户端侧处理、兼容窗口长度。
完成标志：`tool-plane.md:47` 的表述被收窄；本文进入 `docs/README.md` 研究证据索引。

### S1｜版本单一来源与协商表

- 引入单一协议版本常量 + 协商表，替换内联数组；
- 不受支持版本返回显式降级/错误，去掉静默回落；
- 11 个 bundle 与 4 处消费方硬编码改为引用同一常量；
- 测试钉住“版本常量单一定义”与“协商行为”。
- 明确 [`mcp-stdio.ts`](../../core/mcp-stdio.ts#L19-L44) 缓冲逻辑在新协议下的去留。

### S2｜无状态传输路径与旧握手双轨

- 在保留 `initialize` 兼容的同时，支持无状态请求（请求自带解析所需信息）；
- 确认 `request.id === undefined` 的短路语义在新路径下是否正确；
- 加一次双版本 conformance：同一批 `tools/call` 在两种路径下结果一致。

### S3｜客户端侧 MRTR Adapter（仅当 Craft 消费远程 MCP Server）

- 处理对端 `resultType: "input_required"`：收集所需输入、补齐、重试原调用；
- 明确重试的幂等边界，复用既有 idempotency-key 做法；
- 不与 Craft 内部审批混淆，不把 `input_required` 当成授权结果。

### 条件项｜Tasks 映射（仅当决定对外暴露长任务）

复用 `RemoteTaskBinding`，不新造模型。本文建议**现在不做**。

## 取舍

1. **不因协议修订暂停当前 P0。** 桌面分发、凭据写入路径、真实 Reference Pilot
   与本次迁移不冲突，且它们的回报更早兑现。
2. **在 12 个月窗口内完成 S1 + S2，不追求全量迁移。** 窗口最早 2027 年 7 月关闭，
   有充裕余量；但 S1 应尽早做，因为它同时消除了 11 份版本副本这一**独立于协议
   修订的既有风险**。
3. **Tasks 与 MRTR 都不应导致 Craft 放弃“授权与效果由自己拥有”。** 协议层的人机
   往返（MRTR）与治理层的审批是两件事，本文明确不合并。
4. **不建议**为迁移引入第二套任务模型、默认多 Agent 或通用远程透传器。

## 相关

- [`runtime-mcp-first-industry-gap-review-2026-09-15.md`](runtime-mcp-first-industry-gap-review-2026-09-15.md)：Remote MCP、`RemoteTaskBinding` 与 A2A v1 的既有 P0/P1 划分。
- [`v01230-universal-work-runtime-gap-review-2026-09-15.md`](v01230-universal-work-runtime-gap-review-2026-09-15.md)：远程协作边界的整体取舍。
- [`industry-agent-harness-hotspots-2026-09-14.md`](industry-agent-harness-hotspots-2026-09-14.md#L24)：MCP Tasks RC 的第一条推论。
- [`agent-application-ideal-state-2026-09-14.md`](agent-application-ideal-state-2026-09-14.md#L28)：协议版本/兼容矩阵的最早动议。
- [`tool-plane.md`](../technical/modules/tool-plane.md#L47)：需要收窄适用范围的既有表述。
