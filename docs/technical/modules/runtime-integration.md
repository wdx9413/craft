# Runtime 与宿主接入

## 接入面

Craft Core 通过 CLI、MCP、平台 Plugin 和专用 Adapter 暴露。Codex 与 Claude 插件使用自包含 MCP bundle；DeepSeek Harness 使用独立 TypeScript Adapter；其他 Host 默认连接精简的 `craft-mcp`，兼容旧全量工具时显式连接 `craft-mcp-full`。

## 宿主职责

- 模型请求、原生工具、Sandbox 和用户审批。
- 把 Craft Plan/Lease 翻译成真实执行。
- 回传 Trace、Artifact、Evidence、Outcome 与资源用量。

## Craft 职责

- 保留精确版本、状态机、权限上限和执行谱系。
- 统一不同 Host 的结果语义。
- 提供评测、晋级、回滚和跨会话恢复。
- 在评测型编排中锁定 Agent Profile 版本，并自动归档 Dispatch、重路由、Submit、成本和终态 Outcome。
- 为兼容 Host 提供受控 Runtime Operation：只领取 Policy 允许的 effect，返回 Lease、审批、回执和父子资源账本所需信息。
- 对模型/业务 Agent 的评测，由 Host 提交真实 Outcome；确定性 Workflow 可由 Core Eval Runner 直接执行。
- v0.9.6 的受信任 Host 可调用 `runtime_driver_tick` 执行服务端签发的确定性 Workflow；驱动只接受明确输入，并检查 effect、命令和路径白名单。它不替代 Host 的真实 sandbox、网络限制或凭据代理。
- v0.9.7 的 Runtime Adapter 是 Agent/Grader 的受控接入 seam：它先声明 kind、Effect、并发与回执能力，再只能领取符合声明和 Run Policy 的 Lease；上报会以精确 Adapter 版本生成有界 Evidence。v0.11.2–v0.11.4 已实现 Codex CLI、Claude Code 非交互 Host Driver 和进程内受管运行；它们仍不是平台私有子 Agent API，也不绕过宿主权限。
- v0.9.9 的 Capability Asset/Activation Profile 只给 Host 一个最小、可审计的启用建议；Craft 不自动写 Codex、Claude 或系统级 MCP 配置。Host 调用时必须先消费绑定 Profile 且有过期时间的 `call_id`。

Craft 不绕过宿主权限，也不假定某个平台私有 API 永久稳定。Adapter 必须拥有独立兼容矩阵和真实安装测试。

关联：[Agent IR](agent-ir.md) · [Capability Kit](capability-kit.md) · [Workflow/Signoff](workflow-signoff.md) · [Codex Driver](codex-host-driver.md) · [Claude Driver](claude-host-driver.md)
