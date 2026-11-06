# 理想态再评估（第二轮）：业界的真实纹理

调研日期：2026-09-19 · 承接 `ideal-state-2026-09-19.md`

## 0. 本轮的方法差异，以及为什么它更重要

上一轮我做的是**能力清单对标**（业界有 A/B/C，craft 有没有）。这一轮我改做**反向验证**：去找能推翻我自己上一轮结论的证据。

结果：**推翻了三条，其中两条是我上一轮刚刚写下的。** 这比新增缺口更值得记录，因为它说明上一轮的方法有系统性偏差——我在拿"业界有 vs craft 没有"做对比，而**没有检查 craft 的声明与 craft 的实现是否一致**。

**证据可用性说明**：本轮 `web_search` 报 `provider "web-search-free" is registered but unavailable`（上一轮还能用，说明是外部服务不稳）。但拿到了**规范权威原文**（`modelcontextprotocol.io`），这比二手报道更强。以下凡标 [规范] 者为规范原文。

## 1. 推翻上一轮结论之一：MCP 迁移被我严重低估

上一轮我写："spec 变化要点：核心转为无状态 HTTP，移除 session 与 initialize……"——把它描述成**一组协议头 + 握手替换**，并建议列为 C 级、可缓办。

读到 [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)（**规范原文**）后，这是 **9 项 major breaking change**，且其中数项**直接击中 craft 的现有实现**：

| # | 规范变化 | craft 现状（已实测） | 影响 |
|---|---|---|---|
| 1 | 移除 `Mcp-Session-Id` | `mcp-http.ts` 无 session 处理 | **已兼容**（意外地好） |
| 2 | 移除 `initialize`/`initialized`，版本走 `_meta`；不匹配返回 `UnsupportedProtocolVersionError` | `mcp-server.ts:1605` 白名单仅 `2025-03-26/06-18/11-25` | **不兼容** |
| 3 | `server/discover` **MUST** 实现 | 不存在（grep 零命中） | **不兼容** |
| 5 | **移除 `ping`**、`logging/setLevel`、`notifications/roots/list_changed` | `mcp-server.ts:1610` 仍实现 `ping` | **将被移除** |
| 6 | tasks 移入 `io.modelcontextprotocol/tasks` 扩展，`tasks/result` → `tasks/get`+`tasks/update` | v0.12.33 已把"durable task 未映射到 tasks 扩展"列为 blocking | 与评估一致 |
| 7 | MRTR 取代 server-initiated 请求 | 同上，已列为 blocking | 与评估一致 |
| 8 | **所有 result 必须带 `resultType`**（`"complete"`/`"input_required"`） | 无 `resultType`（grep 零命中） | **不兼容** |
| 9 | 移除 SSE 可恢复性（`Last-Event-ID`、event id） | 无相关实现 | 已兼容 |

**关键发现（新的、上一轮没看到的）**：

`v01233-runtime.ts:109` 定义 `MCP_PROTOCOL_VERSIONS = ["2025-03-26","2025-06-18","2025-11-25"]`，而 `MCP_ASSESSED_REVISION = "2026-07-28"`（:111）。于是出现一个**声明与实现自相矛盾**的状态：

- `negotiateProtocolVersion` 会正确报告"requested_version_unsupported"（行为是对的）
- 但 `MCP_ASSESSED_REVISION` 这个名字暗示了"已评估过 2026-07-28"，而**实现层面完全不识别它**
- 一个说 `2026-07-28` 的客户端会被**静默降级**到 `2025-11-25`，按规范第 2 条这本该返回 `UnsupportedProtocolVersionError`

**这不是 bug，是"评估"与"实现"的边界没有被诚实地表达出来。** craft 的诚实文化（`enforced: false` 那套）在这里漏了一处：`MCP_MIGRATION_STATUS = "assessed_deferred"` 是诚实措辞，但**没有任何测试断言"我们确实说不出 2026-07-28"**，所以这个状态可以无声漂移。

**这修正了我的优先级判断**：规范给了**至少 12 个月**的弃用窗口（[feature lifecycle](https://modelcontextprotocol.io/community/feature-lifecycle)），所以**不急**，但它不是 C 级可缓办——它是**有明确外部时钟的兼容性债**，且 `ping`/`resultType`/`server/discover` 三项是**确定的**未来不兼容。

## 2. 推翻上一轮结论之二：`resultType` 与"我们已有 receipt 文化"的关系

上一轮我写 craft 的"receipt / 授权分层文化强于那些论文系统"。**在 MCP 层面这即将变成负资产**：规范要求所有 result 带 `resultType`，而 craft 的 receipt 是**自定义信封**，不是协议级字段。也就是说：

- craft 的强项（丰富的内部 receipt）**不能**替它满足协议要求
- 反倒是"最小合规字段"缺失
- 迁移时要在**不破坏内部 receipt 语义**的前提下加协议层字段——这正是 Oracle 那篇 [Java 迁移实践](https://inside.java/2026/08/12/java-mcp-migration/) 的**适配器置于路由边界**做法（`McpRequestLoggingFeature` 拦截，按 `MCP-Protocol-Version` 分流，两条路径调同一个 domain 代码）

这是一个**具体的、有参考实现的**工程路径，不再是"要不要做"的哲学问题。

## 3. 上一轮结论经复核**成立**的部分

为免只报坏消息，以下经本轮独立复核仍然成立：

- **G1 跨轨迹抽象缺失**：[ACL 2026 Findings 2069](https://aclanthology.org/2026.findings-acl.2069/) 的三阶段（Storage→Reflection→Experience）与 [MUSE](https://aclanthology.org/2026.findings-acl.1522/) 的 post-execution critique，指向同一能力。craft 的 `decideExperienceCapture` 确实是单轨迹内打分。**成立**
- **G2 治理护栏缺失**：Governance Decay 的机制（压缩会丢弃非 system 通道的约束）与 craft"治理约束存于 memory/tool output 通道"叠加，风险真实。**成立**
- **G3 失败分类学**：Eywa 的 8 类。**成立**
- **纠正 1（A1 双时态已存在）**：本轮未发现反例。**成立**

## 4. 本轮新增的、上一轮完全没看到的缺口

### G7 MCP 协议合规缺口（有外部时钟，确定会到期）

见第 1 节表格。**三项确定的未来不兼容**：`server/discover` 必须实现、`resultType` 必须出现、`ping` 将被移除。

**可验证判据**：能否对一个携带 `MCP-Protocol-Version: 2026-07-28` 的请求作出正确响应（要么合规应答，要么按规范返回 `UnsupportedProtocolVersionError`，而不是静默降级）。

### G8 "声明与实现一致性"没有自检机制

第 1 节那个矛盾（`MCP_ASSESSED_REVISION` 声明 vs 白名单实现）不是孤立笔误，它暴露了一类**结构性风险**：craft 有大量"能力声明"基础设施（`MCP_MIGRATION_STATUS`、`enforced: false`、`execution_authority: false`、`requires_approval`），**但没有一个机制去验证"声明是否与实现一致"**。

这类声明如果漂移，比没有声明更危险——因为它会让读者以为某件事已被处理。**这是我认为本轮最重要的发现**，且它与具体版本无关。

**可验证判据**：能否写出一条测试，断言"当我们声称不识别某协议版本时，实现确实不识别"。这需要一个**从声明生成断言**的模式，而不是手写两处。

## 5. 优先级重排（含理由变更）

| 序 | 缺口 | 上轮排序 | 变化与理由 |
|---|---|---|---|
| 1 | **G8 声明/实现一致性自检** | 未识别 | **新增且置顶**：它是元问题，防止其他所有结论漂移。成本低（一个测试模式），收益是让 G1–G7 的判断都变得可证伪 |
| 2 | **G1 跨轨迹抽象** | 1 | 保持。A 级证据、最结构性 |
| 3 | **G3 失败归因分类学** | 3 | 升位：它是 G1 的**证伪前提**（没有归因，抽象无法验证） |
| 4 | **G2 治理护栏** | 2 | 略降：craft 尚无 compaction 触发路径，但方向已在走 |
| 5 | **G7 MCP 合规** | 5(C) | 升为**有明确 deadline 的工程债**，但 12 个月窗口内不急 |
| — | G4 多跳检索、G6 删除语义 | — | 不变，非紧急 |

## 6. 结论

两轮调研合起来，我给出的判断是：

**craft 的核心能力缺口只有两条（G1 抽象、G3 归因），其余都是护栏与合规问题。而这两轮里我最该记住的教训不是任何一条缺口，是我自己反复在"声明层"下结论而没查"实现层"（A1 双时态、MCP 迁移两次都是这个毛病）。**

所以本轮的结论不是"再补三个能力"，而是：**先建立 G8——让每一处能力声明都能被一条测试证伪。** 没有它，我下一轮还会犯同样的错，而你无法提前发现。

如果你要我继续，我建议的顺序是：**G8（小、元问题）→ G3（让失败可归因）→ G1（跨轨迹抽象）**。G7 可以在任一阶段并行处理，因为它有明确规范和参考实现，属于确定性工作。

## 附：本轮来源

| 来源 | 类型 | 用于 |
|---|---|---|
| [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) | **规范原文** | 9 项 breaking change、弃用清单 |
| [MCP 2026-07-28 发布说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/) | 官方博客 | 迁移指导、生态状态 |
| [MCP feature lifecycle](https://modelcontextprotocol.io/community/feature-lifecycle) | **规范原文** | 12 个月弃用窗口 |
| [Oracle Java MCP 迁移](https://inside.java/2026/08/12/java-mcp-migration/) | 工程实践 | 适配器置于路由边界的参考实现 |
| [ACL 2026 Findings 2069](https://aclanthology.org/2026.findings-acl.2069/) / [1522](https://aclanthology.org/2026.findings-acl.1522/) | 同行评审 | G1 复核 |
| [Governance Decay](https://ar5iv.labs.arxiv.org/html/2606.22528) / [Eywa](https://ar5iv.labs.arxiv.org/html/2605.30771) | 预印本 | G2 / G3 复核 |
