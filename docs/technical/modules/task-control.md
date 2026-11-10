# Task Control

## 目标

`TaskControlKernel` 是 v0.11.47 的单任务控制面。它不新增一个 Agent 调度器，也不替代 Host、验收器或 Delivery Loop；它将这些已有事实收敛成一个可恢复、可审计的下一步。

## 边界与记录

一个不可变 `task_control_contract` 固定：

- `task_id` 与绝对工作目录；
- 允许的 `read_only` / `local_write` / `external_write` effect；
- 可选的 Activation Profile 与 Budget Account 的精确版本；
- 是否必须存在独立 Acceptance Plan。

Contract 只能绑定一个兼容的 Work Launch。任务、目录、effect 或验收要求不一致时失败关闭；同 ID 但不同契约也不会静默覆盖。

`task_control_state` 是从 Contract、Work Launch、Host Run 和 Delivery Loop 导出的版本化投影，不包含 Prompt、业务正文或凭据。它只会给出以下有限状态之一：

| 状态 | 下一动作 | 责任方 |
| --- | --- | --- |
| `prepared` | `prepare_work_launch` | 人或 Host |
| `awaiting_approval` | `review_work_launch` | 人 |
| `running` | `wait_for_host` | Host |
| `awaiting_acceptance` | `collect_acceptance` | 人 |
| `ready_for_delivery` | `deliver` | 人 |
| `recovery` | `retry_or_handoff` | 人 |
| `blocked` | `human_handoff` 或重新准备 | 人 |

`task_control_handoff` 固定 Contract 与 State 的精确版本、当前 Launch 和 `resume_action`。原因只允许受限枚举，避免把原 Prompt 或业务原文写入长期状态。

## 集成

- Host 终态回执和 Acceptance Assessment 均会刷新已绑定 Contract；不会依赖模型自述。
- Attention 将需要人类处理的 Task Control State 投影为卡片，但不授予执行或重试权限。
- Home / Workbench 显示控制状态。Workbench 新建 Work Launch 后会创建并绑定最小 Contract。
- MCP 完整面提供 save / bind / refresh / get / handoff；精简核心面只提供状态 refresh / get，不将启动或写入能力暴露给默认面。

## 非目标

- 不自动执行 `deliver`、重试、外部写入或人工验收。
- 不替代真实沙箱、凭据 Broker、事务补偿或跨 Agent 调度。
- 不将状态投影、Attention 卡片或手工 Handoff 宣称为业务交付已完成。
