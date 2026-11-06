# Closed-loop Runtime

## 职责

Runtime 是 Craft 的受控执行层，不是绕过 Codex、Claude 或其他 Host 的模型循环。它将一个 Task 拆成版本化 Policy 约束下的 Operation，并保存可恢复 RunState。

```text
Runtime Policy → Runtime Run → Operation DAG → Lease / Approval → Receipt / Trace
                                  │
                                  └── parent-child resource ledger
```

## 0.9.5 基础、0.9.6/0.9.7 可执行闭环

- Policy 限制允许 effect、审批 effect、最大并发和预算。
- Run 固定 Policy 精确版本、Policy 摘要和环境摘要；晋级前会检查三者是否仍匹配。
- Operation 支持 `agent`、`workflow`、`grader` 三种类型；父 Operation 通过后子 Operation 才能领取。
- 高风险 effect 会停在 `awaiting_approval`；批准、拒绝、领取和提交都会留 Trace。
- Lease、提交者和幂等键共同避免重复提交；费用累积在根 Run，预算超限后状态为 `paused_budget`。
- Runtime 不保存凭据或原始敏感 Payload；Artifact/Evidence 只保存必要引用和脱敏摘要。
- 0.9.6 的 `runtime_driver_tick` 仅在受信任 Host 上自动运行已签发的确定性 `workflow` Operation；每个执行参数必须显式给出 `inputs`，并经 effect、命令、路径白名单校验。
- Operation 可声明依赖 DAG、有限重试与 Lease 到期恢复；Driver 的结果、失败或暂停均写入 Artifact、Evidence、Trace 和持久 RunState。
- 外部写入、破坏性动作及未在 Driver 中实现的 `agent`/`grader` Operation 仍停留在 Host Adapter，不会被伪装成已自动执行。
- 0.9.7 增加版本化 Runtime Adapter：Adapter 公开声明可领取的 Operation kind、Effect、并发、暂停/恢复与回执能力；领取与上报会使用精确 Adapter 版本，并自动登记 Artifact 与 bounded Evidence。
- 本地 Adapter 不能声明 `external_write` 或 `destructive`；这类 Effect 只能由明确标为 `isolated` 的 Adapter 接管，且仍须满足 Run Policy 与审批要求。
- 0.9.9 新增风险分级决策：`read_only` 为普通 Host 的可移植执行；macOS/Linux 的本地生成代码写入才选择网络拒绝的 `LocalIsolatedAdapter`；外部写入进入人工审批；不可补偿的破坏性动作、未接入受信任 Broker 的凭据请求直接阻断。Windows 不因缺少本地隔离器失去读/规划和审批能力，只是不允许自主执行需要硬隔离的写入。

## 边界

`LocalIsolatedAdapter` 当前使用 macOS `sandbox-exec` 或 Linux 已检测到的隔离器，网络默认拒绝、命令/路径需白名单；隔离器不可用时仅该高风险执行失败关闭。v0.10.2 已增加本地 HTTPS Egress Broker 与 Sandbox Inbox Bridge：Sandbox 本身继续断网且不获得凭据，由宿主 Broker 代办精确请求，再将脱敏、不可信且零执行权限的响应投递到 Ticket 私有目录。它不是透明企业代理、远程网络策略或完整 Saga 实现。Eval Runner 可自动执行确定性 Workflow；Runtime 中的通用 Agent/模型 Operation 必须由兼容 Host 领取并提交观察到的结果。

关联：[Runtime 与宿主接入](runtime-integration.md) · [Experience/Eval](experience-eval.md) · [Workflow/Signoff](workflow-signoff.md)
