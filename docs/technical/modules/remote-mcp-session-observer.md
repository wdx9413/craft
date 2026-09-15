# 远程 MCP、会话协议与独立结果观察

状态：本地契约已实现并有单元测试；身份提供方、TLS 终止、真实 Host 和业务 Case 仍由部署 Adapter 提供。

## 目标

这三个模块补齐的是同一个事实闭环，而不是再做一层 Agent 编排：

```text
可信远程请求 ─授权回执─> MCP
Host Session ─连续事件─> Canonical Trace
独立 Observer ─实际状态─> Outcome Observation
                                      ↓
                   既有 Runtime Assurance / Eval Campaign / Signoff
```

`Host` 可以是已运行的 Codex、Claude、IDE，也可以是显式启动的 CLI/Worker。嵌入式 Host 不会由 Craft 再启动一个 Codex CLI；它只回传受契约约束的事件与回执。

## Remote MCP Access Policy

`RemoteMcpAccessPolicy` 是 HTTP 边界的可插拔安全 Adapter：

- 默认本机 HTTP 仍无认证功能且只绑定 `127.0.0.1`；不能把它直接暴露到公网。
- 只有部署方显式注入 verifier 后，HTTP Handler 才进入 remote 模式。未配置 verifier、非安全传输、非 Bearer 格式、issuer/audience/scope 不匹配、过期 Token 都在读取请求体和调用 MCP 前拒绝。
- verifier 由企业 OIDC/OAuth Broker 实现；Craft 不保存 access token，只保留调用方/客户端摘要、受众、scope、到期时间和授权时间的回执。
- policy 按 principal/client 做内存分钟限流。生产环境还应由网关提供 TLS、持久限流、审计留存、PKCE/OAuth 授权码交换和短期 audience-bound Token。

因此该模块是部署契约，不宣称内置了 IdP、OAuth 登录页、密钥托管或公网网关。

## Host Session Event Protocol

`HostSessionEventKernel` 将跨 Host 的事实统一映射到已有的 `TraceKernel`，只存引用、摘要和版本：

- Session 有固定 Task、Host、环境、Policy 和 Capability 指纹；事件必须连续、可幂等重试。
- 支持 started、dispatch、receipt、state observation、pause/resume 和 terminal 事件；暂停后的恢复必须留下摘要原因。
- 原始对话、Prompt、Token、Cookie 等敏感文本被拒绝。事件只能带 Action Contract、State、Artifact 和 Evidence 引用。
- 终态或暂停的 Session 不能继续追加；恢复只从 paused 状态开始。

该协议是 Host Adapter 的共同输入/输出格式，不负责启动模型或执行工具。

## Outcome Observer

`OutcomeObserverKernel` 将“Host 说完成”与“外部观察到结果”分开：

- Observer 必须不同于执行 Host，且环境指纹与 Trace 一致。
- `passed` 必须附 confirmed 或 bounded Evidence；所有观察都固定 state snapshot 引用。
- 观察会追加到 canonical Trace，但 `promotion_eligible` 固定为 `false`。
- 能否晋级仍由既有 Acceptance、Runtime Assurance、重复 held-out Eval、Signoff 和 Canary 判定。

这使程序检查、工作区观察、人工盲评或未来业务 Adapter 可以共享同一个输入面，而不会把模型自述当作真实 Outcome。

## MCP 使用边界

Full/administrative MCP 可调用：

- `craft_host_session_open`、`craft_host_session_append`、`craft_host_session_resume`、`craft_host_session_get`
- `craft_outcome_observer_observe`、`craft_outcome_observer_get`

默认精简面不额外暴露这些低频运行时协议工具；普通用户继续走 `craft` 的主入口。组件或外部 Host 如需集成，显式选择相应 MCP surface，并自行提供 Host、身份与 TLS Adapter。
