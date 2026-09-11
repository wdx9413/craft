# Capability Connector

> 状态：v0.11.54 实现本地、显式注册的 Connector 控制面与 Host Manifest/Bridge 边界。它验证元数据、调用票据和 Host 接受回执；不替 Host 安装、启动或配置第三方服务。

## 职责

`CapabilityConnectorKernel` 把内置能力、用户选择的 GitHub / 火山引擎 Skill 来源，以及 stdio / HTTPS MCP（含 Serena）统一为可审计的来源。每个 Connector 只有 `kind`、名称、无凭据 endpoint 摘要、审批引用、信任状态和版本；Craft 不保存 OAuth token、Cookie、API Key、原始 Skill 内容或原始 MCP schema。

```text
用户配置并批准来源
        ↓
Host 发现受限元数据 ──→ Connector Asset（discovered）
        ↓ 人工审批
Capability Asset（精确来源与摘要）
        ↓ Activation Profile
Connector Ticket（Profile / Asset / Source Digest / 到期时间）
        ↓ Host 消费后实际调用
Receipt + 再观察
```

发现、批准、激活、调用是四个不同状态。Connector 不在后台轮询网络，也不因发现到 Skill / Tool 而自动把它放进模型上下文或 Host 的 MCP 配置。

## 支持范围

- `builtin`：Craft 自带、无需外部用户审批的逻辑来源。
- `github_skill`、`volcengine_skill`：用户批准的 Skill 元数据来源。
- `mcp_stdio`、`mcp_http`：用户批准的 MCP 元数据来源；HTTP endpoint 必须 HTTPS。
- `serena_mcp`：按需接入 Serena 的 MCP 能力。此版本只允许其登记和签发 `read_only` Asset；项目记忆文件继续由已有 Project Knowledge Adapter 按需读取。

所有外部 Connector 要携带用户审批引用。需要凭据的 Asset 会记录“需要外部 Broker”，但不会进入 Activation Profile；本版没有内置凭据 Broker。`local_write`、`external_write` 与 `destructive` Asset 可以被发现和审查，但不会因 Connector approval 自动成为可激活 Asset。

用户可在 Full MCP 面显式禁用 Connector；已签发但尚未消费的 ticket 会在消费时失败关闭。禁用不删除历史 Receipt，也不修改第三方服务。

## 调用门禁

`craft_capability_connector_ticket_issue` 仅在以下条件同时满足时签发票据：

- Connector 仍为 active 且 trusted/verified；
- 已批准的 Connector Asset、Capability Asset 与 Activation Profile 精确版本一致；
- Asset 健康、可信、无需凭据，并在 Profile 的 effect 范围内；
- Serena 仍是只读；
- ticket 未过期。

`consume` 会重查 Connector 与 Connector Asset 的状态和版本，并只允许一次。Connector Asset 不能走旧的通用 `capability_call` 入口绕过 ticket；Host 应在真正调用前消费 ticket，再把真实执行 Receipt 和观察结果交回既有 WorkLoop/Runtime。Craft 不声称能在未集成的第三方进程中强制拦截裸调用。

## MCP 面与兼容性

默认 `craft-mcp` 保留少量运行时动作：完整 Verified Work Loop 的 `prepare / advance / decide / resume / get`，以及已配置 Connector 的 `list / ticket_issue / ticket_consume`。Connector 注册、发现、启停和批准属于显式配置操作，仅在 `craft-mcp-full` 提供。旧 `capability_asset`、`activation_profile` 和 `capability_call` API 保持兼容。

这使 Codex Plugin 能在任务开始时采用 WorkLoop，而不是每句对话都必须调用 Craft。短回答与无持久价值的单步读取仍可跳过；任何实际启停 MCP Server、安装 Skill 或授予外部权限仍由用户和 Host 决定。

## 非目标

- 不自动下载安装 GitHub / 火山引擎 Skill。
- 不自动修改 Codex、Claude、Serena 或系统 MCP 配置。
- 不把第三方 Tool 的声明、MCP annotation 或模型说明当作安全/质量证明。
- 不用 Connector 代替真实评测、审批、沙箱或外部写入补偿。

关联：[Capability 与领域 Kit](capability-kit.md) · [Runtime 与宿主接入](runtime-integration.md) · [Verified Work Loop](verified-work-loop.md)
