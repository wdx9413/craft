# Attention Inbox（统一注意力收件箱）

Craft 的审批、恢复、后台维护和投机候选分别有自己的权威状态机。普通用户不应理解这些内核，也不应在多个列表中寻找下一步。Attention Inbox 将当前需要人、Agent 或运维者处理的事项投影成统一卡片，作为 CLI、MCP 和未来 Canvas 首页共同的数据接口。

## v0.10.8 已实现

- 从待审批自主权请求、开放的 Recovery Item、异常 Maintenance Component 和 ready Speculative Candidate 生成稳定 ID 的卡片。
- 卡片包含受众、优先级、原因、建议动作，以及源记录的精确种类、ID、版本和状态。
- 支持按受众读取、确认和延后；延后到期后重新出现。
- 源版本变化会重新打开卡片，源不再需要处理时卡片自动 resolved。
- Inbox 是可重建投影。确认卡片不会批准动作，延后卡片不会修改 Recovery、授权或运行状态。
- Local Maintenance Worker 每轮在恢复投影之后刷新 Inbox；CLI 提供 `inbox refresh/list/ack/defer`，无需先接入桌面端。

当前没有桌面通知、团队分配、批量操作和领域化卡片文案。未来 UI 必须调用源模块的正式动作完成审批或处置，不能把 Inbox 的 `acknowledge` 当成业务完成。
