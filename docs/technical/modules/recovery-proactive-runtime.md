# Recovery Queue 与受控主动性

## 当前实现

`RecoveryQueueKernel` 把分散在持久状态中的恢复需求投影为统一的 `recovery_item`：

```text
Durable Wait / External Effect / Saga
  → bounded refresh
  → prioritized persistent recovery item
  → compatible Worker lease
  → underlying action through an existing controlled API
  → evidence-backed report with stale-state check
```

当前识别：到期时间等待、待人工审批、未知外部 Effect、未知补偿，以及失败 Saga 中需要逆序执行的下一项补偿。事件等待由精确 Event Inbox 唤醒，不重复放进通用恢复队列。

## 并发与恢复规则

- Refresh 有数量上限，使用稳定 Item ID；同一来源状态不会重复创建工作。
- Worker 只声明自己支持的 Action，按优先级领取一个短期 Lease；领取不等于授权执行。
- Lease 到期可以有界回收，进程退出不会永久锁死任务。
- Worker 必须通过既有 Wait、Reconciler、Compensation 或人工审批 API 改变真实来源状态；Queue Report 本身不代替业务动作。
- `completed` 回执要求来源已不再处于待恢复状态，并必须引用 Evidence。来源发生不同版本的并发变化时，回执记为 `stale`，旧 Worker 不能覆盖新状态。
- `failed` 需要 Evidence；`deferred` 可以仅提供原因，供人类注意力队列继续处理。

## 承诺边界

这是主动工作的控制面，不是常驻自主 Agent。它发现和分配已知恢复工作，但不自动申请权限、不生成凭据、不绕过预算，也不自行解释不可信内容。真正的后台服务仍需 Host 定时调用 Refresh/Claim，并通过对应受控接口执行。

## Signed Webhook Subscription

`TriggerKernel` 已提供受控的通用 Webhook 入口协议：订阅固定绑定 Task、事件键、HMAC 凭据句柄、确定性顶层标量过滤器、允许投影字段、重放窗口、节流间隔和可选资源预算。调用方以 `timestamp.rawBody` 计算 HMAC-SHA256；Craft 验签和解析时短暂使用原始正文，只持久化摘要、事件元数据及白名单标量投影。

投影始终标记为 `untrusted_data` 且不携带执行权。验签、重放、过滤、节流和预算预留均在唤醒 Wait 之前完成；预算不足时保留 `awaiting_budget` 回执，稳定 Event ID 重试不会重复投递。当前实现是可由 MCP Host、反向代理或 Serverless Function 调用的协议内核，不包含公网 HTTP Server，也不适配供应商专用签名格式。

## Speculative Candidate Runtime

`SpeculativeKernel` 把主动准备限制为 `index`、`summarize`、`draft`、`prefetch_metadata` 四类只读动作。版本化 Policy 固定 Task、事件键、动作、预算、资源估算、TTL 和并发候选上限；只有已经验签并成功投递的匹配事件才能创建候选。

每个 Candidate 绑定 Policy 精确版本、Trigger Event、输入摘要和预算 Reservation。Worker 通过短 Lease 领取工作，只获得不可信输入引用和 `execution_authority: false` 的 Dispatch；Ready 成果必须引用已登记 Artifact 与 Evidence。失败或过期会结算并释放未使用预算，候选不会自动转成外部 Effect。

Candidate 入队时会自动建立绑定 Policy 精确版本的 Trial；领取、产出、人工决定和过期都会写入 Trace。Worker 失败、候选过期、人工接受或拒绝分别形成显式 Outcome，并记录实际结算资源。人工接受、拒绝或替换 Artifact 还会形成 `preference_signal`，记录生成成果与最终成果是否发生改变；人工接受属于 `human_observed` 结果，不能冒充程序验证，也不会凭单次结果直接晋级 Workflow。当前还没有内置模型 Worker或后台常驻调度器。

后续可在此之上增加环境订阅、领域 Worker 和维护数据集上的候选评测；任何真实写入仍必须重新经过 Effect Policy、审批和幂等边界。

关联：[控制面护栏](control-plane-guardrails.md) · [Transactional Runtime](transactional-runtime.md) · [Closed-loop Runtime](closed-loop-runtime.md)
