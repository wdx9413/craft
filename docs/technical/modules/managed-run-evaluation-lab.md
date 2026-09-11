# Managed Run 与 Evaluation Lab

> 状态：v0.11.56 已实现本地机制闭环。它证明引用、版本、状态和评测门禁被正确保存；不证明特定模型、业务领域或 Judge 的质量提升。

## 问题与边界

长任务最容易在 Host 重启、人工改文件、上下文切换或评测对照时失去事实边界。`ManagedRun` 和 `CampaignRunner` 为既有 Verified Work Loop / Eval Campaign 加上持久化运行控制，但不另造一个隐藏的 Agent 调度器：

```text
Verified Work Loop
  -> Task Run State + State Snapshot + Work Loop Receipt
  -> Managed Run Observation
  -> structured Handoff / fresh observation / resume
  -> optional read-only Shadow fork

held-out Eval Campaign
  -> deterministic Case × Harness × Trial slot
  -> explicit Host-prepared Task Run
  -> comparable bind
  -> existing Benchmark / Evaluation / Signoff / Canary
```

Craft 保存的只是对象引用、精确版本、摘要、Artifact/Evidence 引用和事件时间线。Prompt、原始业务正文、模型思考和凭据仍留在 Host 或外部系统，不能借 Managed Run 重新进入 Craft 存储。

## Managed Run

`ManagedRunKernel` 绑定一个既有 `VerifiedWorkLoop` 和 `TaskRun`。每次 `observe` 必须同时提供同一运行的 `TaskRunState`、`StateSnapshot` 与 `VerifiedWorkLoopReceipt`；任一对象不属于该运行、工作区或 receipt 不匹配即拒绝。

`handoff` 只能从已观察状态创建，并固定原因摘要、Artifact/Evidence 引用及下一步动作。`resume` 只接受新的观察；若新观察已经是 `needs_replan`，它返回重新准备而不是重放旧 Host 操作。`forkShadow` 固定为 `shadow_read_only`，明确 `external_effects_allowed=false`，不会复制或重发外部写入。

这不是“恢复任意进程”。真实 Host 的挂起、取消与重新执行仍由现有 Host Bridge / Adapter 管理；Managed Run 只提供跨会话可核对的接力事实。

## Campaign Runner

`CampaignRunnerKernel` 将已有 `EvalCampaign` 的 Slot 做成显式、一次一个的 Host 交接：

1. `claim` 签发一个固定 Case、Harness、Trial、环境和预算摘要的 dispatch；它不启动模型。
2. Host 按 dispatch 准备并实际运行 Task Run。
3. `bind` 调用既有 Campaign 比较规则，只有环境和预算摘要相同的 Task Run 可以绑定。
4. `advance` 只聚合已绑定的 observed Delivery，继续使用既有 held-out、重复试验和 Signoff/Canary 门禁。

因此，确定性 Workflow 可继续用既有 `EvaluationRunner` 实跑；通用 Agent/Host 评测没有伪造“自动跑完”，而是由 Host 以同一控制契约回传真实 Task Run。

## Judge 校准 Gate

Judge Adapter 默认 `uncalibrated`，只能提供诊断。`JudgeCalibration` 可保存人工金标 Case 标识和 Evidence 引用；校准状态达到约定一致率后才为 `calibrated`。`EvaluationJudgeGate` 同时要求：

- reliability assessment 已 `eligible`；
- Judge 已校准；
- 可选的 Evidence 引用均已登记。

只有 Gate 为 `eligible` 时，依赖该 Judge 的 Adaptation Candidate 才可在原有 Signoff 后进入 Canary。未使用 Judge 的纯程序/人工验收不被强加此 Gate。

## MCP 与 Workbench

`craft-mcp` Core 只读暴露 Managed Run、Campaign Runner 与 Judge 的状态查询；创建、领取、绑定、交接、影子分叉和 Gate 记录只在显式的 `craft-mcp-full` 提供。Workbench 也只提供本机令牌保护的只读 API：

- `GET /api/managed-runs/:id`
- `GET /api/campaign-runners/:id`

这避免管理操作膨胀默认工具面，也不会因为安装插件而自动开始、恢复或修改任何 Host 任务。

## 非目标

- 不默认多 Agent，不自动增加 evaluator；只有独立对照证明收益才值得扩展 Harness。
- 不执行模型临时生成的任意脚本，不把 Shadow 当成真实生产写入。
- 不把本地文件事务宣称为外部 API/数据库事务或跨平台沙箱。
- 不让线上反馈直接进入 held-out 或触发发布。
