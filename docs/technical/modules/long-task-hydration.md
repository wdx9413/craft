# 长任务 Dehydration / Hydration

## 目标

长任务等待人工、Webhook 或未来时间时，不要求 Agent 进程和 Sandbox 常驻。Craft 将恢复所需的最小控制状态冻结为 Snapshot，Host 退出后仍能重新验证并续接。

## 当前实现

`HydrationKernel` 固定以下引用：Task 版本、Workspace 状态修订和最近 Checkpoint、Durable Wait、Runtime Run 及其策略/环境指纹、活跃 Budget，以及 Recovery Item。Snapshot 只记录结构化引用和摘要：

- 不保存原始对话上下文。
- 不保存凭据或 Secret。
- 使用内容指纹阻止同一 Snapshot ID 指向不同状态。
- 只允许 Active/Paused Task，以及属于同一 Task 的 Wait、Run、Budget 和恢复工作。
- Snapshot 有 TTL；过期后必须重新捕获当前状态。

Hydration 前执行三态检查：

```text
still_waiting  → 不启动 Host
ready          → 发放 resume Lease
needs_replan   → 发放 replan Lease，不假装能够原样续跑
```

Workspace 修订、Task/Runtime 版本、Wait 状态和 Budget 可用性都会重新检查。Claim 使用短 Lease 防止两个 Host 同时恢复；相同 Host 与 Claim Key 幂等返回，其他 Claim 失败关闭。完成恢复必须引用 Evidence；放弃或 Lease 超时会回到 Frozen 状态。

## 承诺边界

Snapshot 是控制面恢复清单，不是进程内存镜像，也不会序列化模型隐藏推理。Sandbox 文件状态仍由 Workspace Checkpoint 或具体后端快照保存；外部系统状态仍需 Effect/Reconciler 重新观察。跨机器搬运底层文件、对象存储和数据库尚未实现。

关联：[控制面护栏](control-plane-guardrails.md) · [Recovery Queue](recovery-proactive-runtime.md) · [Agent-Native Workspace](agent-native-workspace.md)
