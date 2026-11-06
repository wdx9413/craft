# MCP 2026-07-28 迁移影响评估（v0.12.33）

日期：2026-09-18
状态：已评估，暂缓执行（assessed_deferred）
当前对外协议版本：`2025-11-25`

> **本文是 v0.12.33 的实现侧记录，不是迁移策略。** 完整的策略与影响面评估见
> [`mcp-2026-07-28-migration-strategy-2026-09-18.md`](mcp-2026-07-28-migration-strategy-2026-09-18.md)，
> 该文对受影响面的判断比本文初稿更准确，**以该文为准**。本文只记录 v0.12.33 实际落地的代码与暴露的工具。

## 一、初稿的一处错误（已修正）

本文初稿声称 Craft 的"人工审批 / 人在环场景正落在被 MRTR 取代的那组能力上"，并据此把迁移风险评为高。**这个判断是错的。**

对 `src/interfaces/mcp-server.ts`、`mcp-http.ts`、`mcp-stdio.ts` 逐项核实后确认，Craft **完全没有实现**以下能力：

| 能力 | 实际状态 |
|---|---|
| `Mcp-Session-Id` | 未实现 |
| `elicitation/create` | 未实现 |
| `sampling/createMessage` | 未实现 |
| `roots/list` | 未实现 |

Craft 对外只实现了 MCP 的最小请求面：`initialize` / `tools/list` / `tools/call` / `ping`。这意味着 Craft 恰好位于受影响最浅的位置——`Mcp-Session-Id` 废除对它反而有利（无需迁移），被 MRTR 取代的那组能力它本来就没有。

真正的风险不是"代码要改"，而是**设计意图被撞上**：Craft 自己的审批门禁与长任务模型在概念上与 `io.modelcontextprotocol/tasks` 和 MRTR 的 `input_required` 重叠，需要一次架构归属决策。这是决策成本，不是迁移成本。

## 二、受影响的真实范围

| 变更 | SEP | 对 Craft 的实际影响 |
|---|---|---|
| `initialize` / `initialized` 握手废弃 | SEP-2575 | **必须改**，但改动局限在 `mcp-server.ts` 的一个方法分支 |
| `Mcp-Session-Id` 废除 | SEP-2567 | 无影响（未实现） |
| `elicitation` / `sampling` / `roots` 被 MRTR 取代 | SEP-2322 | 无代码影响（未实现）；但审批语义需定归属 |
| Tasks 移出核心成为扩展 | SEP-2663 | 需一次架构决策，非代码迁移 |
| `roots` / `sampling` / `logging` 弃用（12 个月窗口） | — | 无影响（未实现） |
| DCR 转向 CIMD | — | 影响连接器注册，需评估 |

`mcp-stdio.ts` 中"在存储初始化期间缓冲 stdin"的逻辑（`pending[]` + `wake`，专为"宿主立即发 initialize 而握手丢失"设计）在无状态模型下会成为遗迹，这是唯一一处需要重写的既有路径。

## 三、v0.12.33 实际落地的部分

- `negotiateProtocolVersion()`：不再静默回退。请求了不支持的版本时记录 `downgraded: true` 与原因（`requested_version_unsupported` / `client_did_not_negotiate`），把"悄悄降级"变成可查询事实。
- `MCP_ASSESSED_REVISION = "2026-07-28"`、`MCP_MIGRATION_STATUS = "assessed_deferred"`：把"已评估并有意暂缓"变成机器可读状态。
- `assessMcpMigration()` 与 MCP 工具 `craft_mcp_migration_assess`：列出阻塞项——宿主是否实现 MRTR、durable task 模型是否已映射到 `io.modelcontextprotocol/tasks`；两项都满足才返回 `ready`。
- MCP 工具 `craft_mcp_protocol_negotiate`：暴露协商结果。

**未做**：`mcp-server.ts` 与 `mcp-stdio.ts` 的协议行为未变，仍对外声明 `2025-11-25`。

## 四、待决问题（迁移开工前必须回答）

1. Craft 自研 Tasks 模型是**映射**到 `io.modelcontextprotocol/tasks`，还是只保证传输层兼容？
2. 人工审批走 MRTR 的 `input_required`，还是保留 Craft 自己的 approval ticket 语义并只做传输适配？
3. Durable Wait 与 Tasks 扩展的生命周期谁持有权威？
4. 12 个月弃用窗口内维持双版本的具体策略。

## 五、结论

排在分发链路与首次运行凭据之后。先回答上述四个问题，再动协议代码。在此之前，任何"升级 MCP 版本"的提交都应当被拒绝。
