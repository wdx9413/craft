# Assured Pilot：真实运行闭环证据（v0.12.17）

> 状态：本地机制已实现并通过脱敏测试。它把已接入 Host 的事实收束成可复核 Pilot；不宣称已接入企业生产环境、密封数据存储或 OS 沙箱。

## 要解决的问题

此前 Craft 已分别具备 Host Bridge、Verified Work Loop、Runtime Assurance、Runtime Readiness、Capability Connector 与 Eval Campaign。但这些记录单独成立，不能自动说明“这次运行可以安全作为受限评测样本”。

`AssuredPilotKernel` 是它们之间的深 Module：调用方只需密封 Case、签发并消费引用、记录恢复演练、准备 Pilot、再观察或读取。复杂的版本、信任、漂移与证据约束留在 Module 内部。

```text
Task Contract → Activation Profile → Host Receipt → Runtime Assurance
       ↓                                      ↓
可信 Capability 版本                   Recovery Drill
       ↓                                      ↓
密封 held-out Case ──一次性引用──→ Assured Pilot
                                             ↓
                           Workbench / Eval Campaign / Signoff
```

## 事实和限制

- `sealed_evaluation_case` 只保存 Case 的精确版本、定义摘要、保管方与不透明定位摘要；不保存 Case 正文。
- `sealed_evaluation_access` 只允许绑定一个 Task Run、一个收件 Adapter、一个用途和到期时间，并且只能消费一次。Craft 不能绕过外部密封存储直接读取它。
- `runtime_recovery_drill` 要求已验证 Attestation、`ready` Runtime Readiness、相同环境摘要、确认级 Evidence，以及 rehydration / receipt revalidation / state re-observation 三项明确检查。
- `assured_work_pilot` 只有在 Task、Task Run、Attestation、Readiness、Drill、Activation Profile 和已消费访问引用全都匹配时才创建。它的状态是 `evidence_bound`，不是“业务已成功”。
- Pilot 再观察时，只要 Task Run/环境、Capability Profile、密封 Case 或 Work Loop 的人工/工作区失效发生变化，就进入 `needs_replan`；旧回执不能继续作为当前事实。

Capability Asset 必须是精确版本、`trusted` 或 `verified`、`healthy`、无需凭据，且 effect 位于 Profile 的允许范围。版本升级即使看起来兼容，也要求重新规划，以免把旧测试的结果错误归因到新能力。

## 运行和平台边界

读任务可以跨 macOS、Windows、Linux 使用已有 portable read 路径；它不需要伪造本地沙箱。`local_write` 与外部写入仍须由 `PlatformExecution`、企业 Binding/审批、实际 Host Adapter 和可观察回执分别证明。Recovery Drill 与 Ready Assessment 都是事实登记，不替代真实隔离器、凭据 Broker、网络策略或生产事故演练。

## MCP 面

`craft-mcp` 核心面只暴露 `craft_assured_pilot_get` 与 `craft_assured_pilot_reassess`，便于 Host 在恢复或上下文漂移时读取最小事实。密封 Case、访问签发/消费、Recovery Drill 与 Pilot prepare 属于 Full MCP 的显式治理动作。

这延续了“默认单 Agent、按需增加能力”的原则：Pilot 不自动创建 evaluator、sub-agent 或远端 A2A；这些拓扑只能在相同环境、预算与 held-out Case 的 Campaign 中证明确有净收益后才候选启用。

关联：[Runtime Assurance](runtime-assurance-evidence-loop.md) · [Capability Connector](capability-connectors.md) · [Verified Work Loop](verified-work-loop.md) · [产品介绍](../../introduction.zh-CN.md)
