# v0.12.4 Platform Runtime

> 状态：v0.12.4 已实现本地可验证内核契约；真实模型供应商、OS 级沙箱、远程传输、OTel 和组织身份由 Adapter 提供并单独验收。

## Autonomous Runtime

`autonomous_run` 保存目标、模型、预算和生命周期；每个 Action 都会生成脱敏 Turn、Outcome digest 和 `autonomous_checkpoint`。Resume 只接受同一 Run 的精确 Checkpoint，Cancel 是幂等的。Runtime 不能自行扩大 Effect 权限，真实外部写入仍走既有 Autonomy/Effect Policy。

## Capability lifecycle

`capability_lifecycle` 统一 Register、Install、Activate、Disable、Upgrade、Retire。Upgrade 必须给出新的 source version 和 source digest；Retire 后不能重新安装或激活。它是能力资产的生命周期层，不替代已有 Certification、Supply-chain 和 Capability Access 门禁。

## Memory

Episodic Memory 保存来源和 scope；Consolidate 才能生成 Semantic Memory，Search 只返回 active 且 scope 匹配的条目。Superseded/Rejected 记忆不会继续进入默认检索。

## Remote interoperability

Remote Request 只接受 HTTPS endpoint，Transport 由受信 Host 注入。Craft 保存 envelope digest、远端 ID 和 terminal receipt，但始终将远端结果标为不可信，不把 A2A Discovery 变成执行授权。

## Operations

Platform Member/Authorization 为轻量角色投影；Observations 只保存事件、状态、运行引用和 value digest，并以 `craft.observability.v1` 导出，方便未来接 OTel 或团队服务。
