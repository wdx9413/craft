# Closed-loop Runtime

## 职责

Runtime 是 Craft 的受控执行层，不是绕过 Codex、Claude 或其他 Host 的模型循环。它将一个 Task 拆成版本化 Policy 约束下的 Operation，并保存可恢复 RunState。

```text
Runtime Policy → Runtime Run → Operation DAG → Lease / Approval → Receipt / Trace
                                  │
                                  └── parent-child resource ledger
```

## 0.9.5 基础、0.9.6 可执行闭环

- Policy 限制允许 effect、审批 effect、最大并发和预算。
- Run 固定 Policy 精确版本、Policy 摘要和环境摘要；晋级前会检查三者是否仍匹配。
- Operation 支持 `agent`、`workflow`、`grader` 三种类型；父 Operation 通过后子 Operation 才能领取。
- 高风险 effect 会停在 `awaiting_approval`；批准、拒绝、领取和提交都会留 Trace。
- Lease、提交者和幂等键共同避免重复提交；费用累积在根 Run，预算超限后状态为 `paused_budget`。
- Runtime 不保存凭据或原始敏感 Payload；Artifact/Evidence 只保存必要引用和脱敏摘要。
- 0.9.6 的 `runtime_driver_tick` 仅在受信任 Host 上自动运行已签发的确定性 `workflow` Operation；每个执行参数必须显式给出 `inputs`，并经 effect、命令、路径白名单校验。
- Operation 可声明依赖 DAG、有限重试与 Lease 到期恢复；Driver 的结果、失败或暂停均写入 Artifact、Evidence、Trace 和持久 RunState。
- 外部写入、破坏性动作及未在 Driver 中实现的 `agent`/`grader` Operation 仍停留在 Host Adapter，不会被伪装成已自动执行。

## 边界

Craft 的白名单是执行前控制，不等同于容器隔离、网络拦截、短期凭据代理或补偿事务；部署方必须在 Host 外提供这些边界。Eval Runner 可自动执行确定性 Workflow；Runtime 中的通用 Agent/模型 Operation 必须由兼容 Host 领取并提交观察到的结果。Runtime 不声明任何 Host 私有子 Agent API 已被支持，也不允许 Proposal 绕过 Eval、Signoff 或 Publisher。

关联：[Runtime 与宿主接入](runtime-integration.md) · [Experience/Eval](experience-eval.md) · [Workflow/Signoff](workflow-signoff.md)
