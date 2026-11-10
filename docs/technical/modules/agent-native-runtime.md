# Agent-Native Workspace Runtime

> 状态：v0.11.57 实现本地、受控的端到端机制。它验证运行事实、状态边界与评测可比性；不宣称已证明任何模型、业务领域或第三方能力的质量提升。

## 目标

Craft 的用户级入口仍是 `Verified Work Loop`。本模块没有另造一个 Agent 调度器，而是把其既有事实对象收敛为一条可审计链：

```text
Task Contract / Activation Profile
  -> Execution Fabric / Work Coordinator
  -> exact Host Run / Receipt
  -> Workspace Observation / Work Loop Receipt
  -> Acceptance / Outcome
  -> Agent Eval Lab / Campaign
```

`WorkCoordinator` 绑定精确 Fabric 与 Managed Run，只保存引用、版本、摘要和状态；Prompt、模型思考、凭据和原始业务材料仍留在 Host 或外部系统。Host 仍可替换，Coordinator 不拥有模型循环，也不伪造进程恢复。

## 工作区观察

`WorkspaceObserver` 通过显式轮询产生 content-free Snapshot 和路径级摘要 Diff。观察来源只允许 `host`、`human` 或 `unattributed`：无法证明归属的变更只能标记为 `external_unattributed`，不能猜测是人还是模型修改。上游 Work Loop 随后会依据 Snapshot 漂移进入 `needs_replan`。

## 分级自主权

| 模式 | 条件 | 承诺边界 |
| --- | --- | --- |
| `portable_read` | `read_only` | 可跨平台；只在声明范围内工作并记录 Receipt |
| `guarded_local_write` | Workspace + 明确人工批准 | 有 Checkpoint/Diff/审计，但**不是**强隔离，不能无人值守 |
| `isolated_local_write` | 已验证、禁网的 Platform Profile | 可用于无人值守本地写入 |
| `external_gateway` | 已验证边界 + 授权 + 再观察；破坏性操作另需补偿或人工处置 | Craft 不承诺外部系统已经回滚 |

这使 Windows 等平台仍可执行只读和人工批准的本地工作；没有对应强隔离证据时，Craft 只拒绝无人值守或外部高风险操作，不把它们降级成裸跑。

## Agent Eval Lab

`AgentEvalLab` 只把已签发的 `CampaignRunner` Slot、可比较 Task Run、精确 Coordinator 与 Host Run 固定为一次 Attempt。它要求同环境、同预算、终态 Host 回执和再观察；Host 退出成功本身不是 Outcome。只有已观察 Attempt 才可参与既有 Campaign / Benchmark / Signoff / Canary。

本版显式启动由 Full MCP、CLI 或 Workbench 发起；Core MCP 保持只读查询。它不默认多 Agent、不生成任意脚本、不直接改 Prompt/Skill/Workflow，也不自动安装第三方能力。

## 后续真实验证

首批脱敏研发与文件/视频 Suite 需由实际 Host 和领域验收器运行；样例测试只证明机制。多 Agent、远程 Capability 拉取、A2A 执行、团队身份和跨设备状态迁移必须在单 Agent 收益、隔离环境和真实 Case 已证实后再扩展。
