# Multi-Agent runtime

Craft 使用宿主介导的编排协议，把“如何拆分和跟踪工作”与“某个平台怎样启动子 Agent”分开。

## 核心对象

- `Agent Profile`：不可变版本，记录 `role`、`host`、`provider`、`model`、`reasoning_effort`、能力标签和允许的副作用。
- `Orchestration Plan`：一次多 Agent 目标及其最大并发数。
- `Node`：角色、目标、依赖、输入输出约定、证据要求，以及按优先顺序排列的 `profile_ids`。
- `Lease`：某个宿主对一个就绪节点的一次唯一领取；同节点同 attempt 不会被重复派发。

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
4. 调用 `craft_orchestration_submit`，提交 `passed`、`failed` 或 `blocked`，并附带真实 result、evidence 和 provenance。
5. 再次 dispatch，直到 Plan 为 `completed` 或 `failed`。

失败节点还有后续 Profile 时会返回 pending，下一次领取使用下一个固定版本；候选耗尽后成为 failed 或 blocked，其下游节点级联 blocked。并发数是 Craft 的上限，宿主自身更严格的并发和权限限制仍然有效。

当前 Lease 没有 TTL 或 heartbeat。宿主崩溃后不能自动回收领取中的节点，应由用户保留 Plan ID 并检查状态；在加入可审计的超时与恢复策略前，不要把它作为无人值守调度器。

## Codex 映射

当 `profile.host` 为 `codex` 时，宿主应把 Lease 映射到 Codex 原生子 Agent：使用 Profile 中明确的 `model` 和 `reasoning_effort`，将 objective、input、dependency_results、output_schema、evidence_required 和副作用边界写入子任务。多个独立 Lease 应先分别启动，再等待结果，以保留并行性。子 Agent 完成后，由主 Agent检查实际产物和证据，再调用 `craft_orchestration_submit`；不得因为请求的模型不可用而静默换成另一个模型，失败应提交给 Craft，让固定 fallback 路由生效。

## Claude 与 API Host 映射

Claude 宿主采用相同 Lease 协议，将 Profile 翻译为当前客户端支持的 Agent/Task 配置。API Host 则根据 `provider` 和 `model` 调用用户配置的端点。平台不支持指定字段时，应明确返回失败或 blocked，不伪造已经按指定 Profile 执行。密钥只保存在宿主/provider 配置中，不进入 Profile、Plan、Lease result 或 Craft 日志。
