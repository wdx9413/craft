# Multi-Agent runtime

Craft 使用宿主介导的编排协议，把“如何拆分和跟踪工作”与“某个平台怎样启动子 Agent”分开。

## 核心对象

- `Agent Profile`：不可变版本，记录 `role`、`host`、`provider`、`model`、`reasoning_effort`、能力标签和允许的副作用。
- `Orchestration Plan`：一次多 Agent 目标及其最大并发数。
- `Node`：角色、目标、依赖、输入输出约定、证据要求，以及按优先顺序排列的 `profile_ids`。
- `Lease`：某个宿主对一个就绪节点的一次唯一、有期限领取；同节点同 attempt 不会被重复派发。
- `Event`：Plan 内单调递增、不可变的控制与执行记录，用于接续、审计和复盘。

## Astra + Luna 示例

先保存 Profile：

```json
{
  "name": "Luna implementer",
  "role": "implementer",
  "host": "codex",
  "provider": "openai",
  "model": "gpt-5.6-luna",
  "reasoning_effort": "max",
  "allowed_side_effects": ["read_only", "local_write"]
}
```

```json
{
  "name": "Astra reviewer",
  "role": "reviewer",
  "host": "codex",
  "provider": "openai",
  "model": "gpt-6-astra",
  "reasoning_effort": "high",
  "allowed_side_effects": ["read_only"]
}
```

Plan 可以让多个 implement/test 节点并行，并让 reviewer 依赖它们全部通过。一个节点的 `profile_ids` 是有序 fallback，例如 Luna 执行失败后再尝试 Terra；Craft 不会自行更换到未声明的模型。

## Host loop

1. 新会话可先用 `craft_orchestration_plan_list` 按 Task 或状态找回 Plan，再调用 `craft_orchestration_dispatch`，领取不超过宿主当前容量的就绪 Lease。
2. 对每个 Lease，读取 `profile.host`、`provider`、`model`、`reasoning_effort`、`side_effect`，以及只读的 `dependency_results` 前置结果上下文。
3. Codex 宿主调用原生 subagent，Claude 宿主调用自己的 Agent/Task 能力，API Host 调用配置的供应商接口。
4. 执行时间可能超过 Lease TTL 时，由同一个 `claimed_by` 定期调用 `craft_orchestration_heartbeat`。
5. 调用 `craft_orchestration_submit`，提交 `passed`、`failed` 或 `blocked`，并附带真实 result、evidence 和 provenance；建议同时回传 `claimed_by` 校验所有权。
6. 新会话或宿主崩溃后调用 `craft_orchestration_reclaim`，也可直接再次 dispatch；过期 Lease 会先被回收。
7. 再次 dispatch，直到 Plan 为 `completed` 或 `failed`。

失败节点还有后续 Profile 时会返回 pending，下一次领取使用下一个固定版本；候选耗尽后成为 failed 或 blocked，其下游节点级联 blocked。并发数是 Craft 的上限，宿主自身更严格的并发和权限限制仍然有效。

Plan 的 `policy.lease_ttl_seconds` 可设为 30–86400 秒，默认 900 秒。Lease 超时表示宿主执行中断：节点回到 pending，下一次仍使用同一个 Profile，但 attempt 递增；只有宿主明确提交 failed/blocked，才会推进有序 fallback。旧 Lease 一旦 expired 或 cancelled，后续 heartbeat 和 submit 都会被拒绝。

`craft_orchestration_plan_control` 支持 pause、resume、cancel。暂停只阻止新派发，不抹除进行中结果；取消会关闭活动 Lease 并取消未完成节点。`craft_orchestration_node_retry` 可显式重试 failed/blocked 节点，并恢复因依赖失败而 blocked 的下游；`restart_routes=true` 会从第一个 Profile 重新开始，否则重试当前/最后一个路由。所有派发、心跳、过期、提交和人工控制都会进入 Plan 的不可变 `events`。

这些机制解决了客户端崩溃后的状态接续与重复提交问题，但 Craft 仍不主动拉起宿主进程，也不是无人值守后台调度器。

## Codex 映射

当 `profile.host` 为 `codex` 时，宿主应把 Lease 映射到 Codex 原生子 Agent：使用 Profile 中明确的 `model` 和 `reasoning_effort`，将 objective、input、dependency_results、output_schema、evidence_required 和副作用边界写入子任务。多个独立 Lease 应先分别启动，再等待结果，以保留并行性。子 Agent 完成后，由主 Agent检查实际产物和证据，再调用 `craft_orchestration_submit`；不得因为请求的模型不可用而静默换成另一个模型，失败应提交给 Craft，让固定 fallback 路由生效。

## Claude 与 API Host 映射

Claude 宿主采用相同 Lease 协议，将 Profile 翻译为当前客户端支持的 Agent/Task 配置。API Host 则根据 `provider` 和 `model` 调用用户配置的端点。平台不支持指定字段时，应明确返回失败或 blocked，不伪造已经按指定 Profile 执行。密钥只保存在宿主/provider 配置中，不进入 Profile、Plan、Lease result 或 Craft 日志。
