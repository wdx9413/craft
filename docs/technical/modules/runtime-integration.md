# Runtime 与宿主接入

## 接入面

Craft Core 通过 CLI、MCP、平台 Plugin 和专用 Adapter 暴露。Codex 与 Claude 插件使用自包含 MCP bundle；DeepSeek Harness 使用独立 TypeScript Adapter；其他 Host 可直接连接 `craft-mcp`。

## 宿主职责

- 模型请求、原生工具、Sandbox 和用户审批。
- 把 Craft Plan/Lease 翻译成真实执行。
- 回传 Trace、Artifact、Evidence、Outcome 与资源用量。

## Craft 职责

- 保留精确版本、状态机、权限上限和执行谱系。
- 统一不同 Host 的结果语义。
- 提供评测、晋级、回滚和跨会话恢复。
- 在评测型编排中锁定 Agent Profile 版本，并自动归档 Dispatch、重路由、Submit、成本和终态 Outcome。

Craft 不绕过宿主权限，也不假定某个平台私有 API 永久稳定。Adapter 必须拥有独立兼容矩阵和真实安装测试。

关联：[Agent IR](agent-ir.md) · [Capability Kit](capability-kit.md) · [Workflow/Signoff](workflow-signoff.md)
