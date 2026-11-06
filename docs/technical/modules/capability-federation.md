# Capability Federation：可审查的能力共享

## 目标

让个人、团队和组织复用经过验证的 Capability，同时避免把原始轨迹、业务数据或凭据直接复制到共享池。该模块是 Hub/企业经验池的本地控制面，不绑定具体云服务。

## 生命周期

`verified asset → proposed bundle → human review/redaction → independent publication → exact subscription → resolve or revoke`

- Bundle 固定 Capability Asset 的 ID 与版本，并要求至少一条 Evidence。
- Manifest 会拒绝敏感字段及常见密钥形态；不保存原始轨迹，也不授予执行权。
- Review 可替换为人工脱敏后的 Manifest；发布者必须与审查者不同。
- Release 带稳定内容摘要，Subscription 固定 release 与 asset 的精确版本。
- 每次解析订阅都检查最新撤销状态；撤销后所有旧订阅 fail closed。
- 共享只解决发现和可信分发，实际激活仍经过 Capability Planning、Autonomy、Sandbox、Budget 等现有控制面。

## 当前边界

已实现本地持久化内核、完整 MCP，以及独立的签名 Hub 增量目录协议。尚未实现主动 HTTP 拉取、能力内容 Materialization、组织身份目录、跨设备同步和管理员 UI；这些应作为适配器建立在相同生命周期上，而不是绕开审查与撤销规则。
