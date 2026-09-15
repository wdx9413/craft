# Runtime Proof 与远程部署边界

v0.12.30 把已有的本地 Runtime Contracts 补成四个可替换的深模块。它们不启动隐藏模型、不保存 token、私钥、原始 Case 或远端 Artifact 正文，也不把部署声明当作业务效果。

```text
OIDC/JWKS verifier ──> Remote MCP Access Policy ──> RemoteTaskBinding
                                                        │
Host Session ──> canonical Trace <── Independent Outcome Observer
       │                                                │
       └──────── Runtime Acceptance Campaign ──────────┘

Publisher key ──> Supply-chain Attestation ──> existing Certification/Signoff
A2A v1 Card ──> consumed Federated Grant ──> bounded remote Task Adapter
```

## 远程访问与租户

`createOidcJwksVerifier` 是 Resource Server 的 RS256/JWKS 验签 Adapter：校验 HTTPS issuer/JWKS、签名、issuer、audience、`exp` 与 scope。OAuth 登录、PKCE、token exchange、TLS 终止、撤销列表和持久限流不在 Core 内；它们必须由部署方的 IdP、反向代理和 Broker 提供。

`RemoteRuntimeKernel` 通过一个随机一次性返回、数据库仅保存摘要的 opaque handle 绑定：Task、Tenant data space、principal 摘要、Access Receipt 摘要、audience、scope 和过期时间。`get/result/cancel/stream` 都必须再次携带同一绑定；租户禁用、授权失效、过期或撤销均失败关闭。`RemoteTenant` 只保存 key envelope、保留和删除策略引用，绝不保存密钥或原始租户数据。

本地 stdio / loopback HTTP 不需要 OAuth。把 HTTP 监听到非 loopback 地址或信任 `X-Forwarded-Proto` 会扩大网络暴露，必须在部署时单独明确 TLS、反向代理、允许来源与 IdP 配置；本仓库不默认开启该模式。

## 真实产品验收

`RuntimeAcceptanceKernel` 是端到端验证协议，不是新的模型 Runner：固定两个脱敏 Case、两个独立 Host、baseline/candidate、环境与预算指纹，然后只接受真实 `HostSession` 与独立 `OutcomeObservation` 组成的 Slot。

- Case 或 Host 不在计划内、Harness/预算/环境漂移、Host 与 Observer 相同，都会拒绝记录。
- 3～4 次配对只能产出诊断结果；只有每组 5 次、所有 candidate 均胜且无 baseline 胜出，才会给出 `eligible`。
- `eligible` 只是允许后续走既有 Signoff/Canary 的证据，不直接启用默认 Harness、Skill、Workflow 或多 Agent。

首次真实 Campaign 推荐先用 Codex App 的 Embedded Host，再选一个独立 CLI/Provider Host；每个 Case 均需独立 Outcome Observer 读取测试、文件或交付物终态。

## 供应链与 A2A

`SupplyChainAttestationKernel` 以发布者公钥验证 Capability/MCP/Hub 条目的内容摘要签名。它只证明“该发布者签过这一摘要”；安装、评测、认证、Signoff 与激活仍使用现有 Capability 生命周期。摘要漂移会将 attestation 标为 stale，撤销保留审计记录。

`A2AV1AdapterKernel` 仅处理 HTTPS A2A v1 Agent Card、`message/send`、`tasks/get` 和 `tasks/cancel` 的协议投影。它要求已有且已消费的只读 Federated Grant，以 request id 作为幂等键，并只保存远端 task id、状态和响应摘要。A2A Card、远端结果和 Artifact 都是不可信输入；不会读入 Craft Memory，也不能单独形成安全或质量 Gate。

## 非目标

- 不默认多 Agent，也不自动把成功轨迹发布成 Skill/Workflow。
- 不把 Docker、macOS sandbox 或 Windows Job Object 的“声明”写成跨平台隔离证明；写入仍需已有 Platform Conformance、审批/补偿与实际后端证据。
- 不将 OAuth token、Broker 凭据、原始 Case、聊天正文或远端 Artifact 正文写入 Craft 数据库。
