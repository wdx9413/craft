# Craft Runtime Contracts：P0/P1 行业复核（2026-09-15）

## 结论

按 v0.12.28 与当前未提交 Runtime Contracts 复核后，Craft 的核心控制面已经覆盖
Trace、Verification、Evaluation、Capability Kit、Context/Memory、Host Session Event
和 Independent Outcome Observer。下一步不该再重做这些内核。

剩余 P0/P1 是把“本地、可测试的契约”变成“可由第三方安全部署、真实运行和互操作的
产品证明”：安全远程 MCP、真实 Host/模型的端到端实验、授权绑定的异步任务、多租户
边界、A2A v1 适配和生态供应链运行。

## 复核范围

- **当前代码事实**：按 [`current-capability-matrix.md`](../technical/current-capability-matrix.md)、
  [`remote-mcp-session-observer.md`](../technical/modules/remote-mcp-session-observer.md)、
  [`remote-mcp-access.ts`](../../core/remote-mcp-access.ts)、
  [`host-session-events.ts`](../../core/host-session-events.ts) 和
  [`outcome-observer.ts`](../../core/outcome-observer.ts) 判断。
- **行业事实**：仅取协议所有方或模型厂商的一手公开资料；每项之后与 Craft 的结论
  分开写。
- “本地契约 + 单元测试”不视为“真实 IdP、真实 Host、真实业务环境已经部署”。

## 已覆盖，不列入缺口

| 能力 | 当前事实 | 结论 |
|---|---|---|
| Runtime / Plugin / MCP 分层 | 产品名映射到同一 Runtime；Plugin 仅打包 Skill、MCP 配置和 bundle | 正确，不应为每个 Plugin 复制实现 |
| 长任务事实 | Host Session Event 已连续、幂等、引用化并映射 canonical Trace；暂停/恢复受状态约束 | 已有内核，缺真实 Host 采用而非再造状态机 |
| 真实交付判定 | Independent Outcome Observer 必须不同于 Host、环境指纹一致、`passed` 需要 Evidence | 已有机制，缺真实观察器 Adapter/Case |
| 评测与演进 | Subject/Case/Trial/Signoff/Canary、`inconclusive`、候选受限已存在 | 不应另建“Skill 专用”第二套质量系统 |
| 能力资产治理 | Source/Kit/Connector/Activation/Ticket 已有 digest、版本、健康和显式激活边界 | 下一步是生态运营与远程供应链，不是重做 Registry |

## P0：安全远程 MCP Reference Deployment

### 行业事实

MCP HTTP 授权规范要求 OAuth 2.1 安全措施：客户端使用 resource indicator，服务端
验证 token 专门签发给自身的 audience，服务器不得把收到的 token 透传给下游；还
要求 HTTPS、PKCE 和安全 token 存储。MCP 规范同时指出工具描述/annotation 在非可信
来源下属于不可信输入，Host 需要明确同意才调用工具。

来源：[MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)、
[MCP Security Guidance](https://modelcontextprotocol.io/specification/draft)。

### 当前 Craft 事实

`RemoteMcpAccessPolicy` 已在本地校验安全传输、Bearer 格式、issuer、audience、scope、
到期和每主体分钟限流，且不保存 token。它刻意把 IdP/OIDC verifier、TLS、持久限流、
审计、PKCE 和授权码交换交给部署 Adapter。

### P0 缺口与最小交付

提供一个**可选 Reference Deployment**，不放进 Core：OIDC discovery/JWKS 验签、
OAuth authorization-code + PKCE、每个 MCP Product 的最小 scope、短期 audience-bound
token、下游 Credential Broker 换票（绝不透传 Host token）、TLS/反向代理配置、持久
审计/限流/撤销与攻击性 conformance suite。stdio 和本机 HTTP 仍可保持无 OAuth、仅
本机绑定。

验收：恶意/过期/错误 audience/scope 的 token 在读 body 前拒绝；一个已授权 Product
不能扩大到 `admin`；下游 Asset 永远收不到 Host token；工具描述中的注入文本不能绕过
Capability trust、Activation 和用户/Policy 同意。

## P0：真实 Host + Outcome 的可重复产品实验

### 行业事实

Anthropic 将 Agent Eval 的关键对象明确为 Task、Trial、Trace、Outcome 和 Harness；对
会改变环境的 Agent，Outcome 应为环境真实终态而非 Agent 自述。其 2026 实验还表明，
同一 Agent Eval 的资源配置可带来超过小型榜单差距的分数变化，环境和资源必须作为
一等实验变量。

来源：[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、
[Quantifying infrastructure noise in agentic coding evals](https://www.anthropic.com/engineering/infrastructure-noise)。

### 当前 Craft 事实

Host Session 与 Outcome Observer 的本地契约已实现；Observer 结果不会单独直接晋级。
当前文档仍将真实 Host、真实业务 Case、真实 IdP 和生产环境留给部署 Adapter。

### P0 缺口与最小交付

交付一份公开、脱敏的 **Runtime Acceptance Campaign**：一个嵌入式 Host（先 Codex
控制台模式）和一个独立 Provider/CLI Host；两个 Case；每 Case 固定模型、工具、
Harness、环境、CPU/RAM、超时、网络/重试和预算指纹；独立 Outcome Observer；重复
baseline/candidate Trial；输出成功率、基础设施失败率、成本/时延、置信范围与
`inconclusive`。

这是产品效果证据，不是把现有 unit test 换个名字。只有该 Campaign 证明收益后，才
允许启用额外检索、evaluator 或 sub-agent 默认拓扑。

## P1：授权绑定的远程异步任务与租户隔离

### 行业事实

MCP Tasks 是实验性扩展；任务查询、结果和取消需受授权上下文保护。无授权方案也应
使用高熵 task ID、短 TTL，且不能假定可枚举任务列表。A2A 也把长任务、异步推送和
人工介入作为协议场景，而不是把后台 Worker 当作私有会话。

来源：[MCP Tasks specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)、
[A2A v1.0 Specification](https://a2a-protocol.org/v1.0.0/specification)。

### 当前 Craft 事实

Craft 有 Durable Wait、Lease、Checkpoint 和 `data_space_id`；Remote MCP Access Receipt
含调用方摘要、scope 和到期时间。但当前契约未把 Remote principal/authorization
context 端到端绑定到每个创建的 Run、Wait、Session、result/cancel 查询，也没有
面向托管服务的 tenant data plane。

### P1 缺口与最小交付

定义 `RemoteTaskBinding`：principal/tenant/authorized product/scope/authorization receipt
digest/expiry 与 Craft Run/Wait/Session 一次性绑定；所有 get/result/cancel/stream 都重验
绑定和 TTL；高熵不可枚举 handle；取消、超时、预算耗尽和撤销形成可审计终态。

对于 SaaS/多组织部署，再以此为基础交付 Tenant Store Adapter：租户级 data root/key
envelope、配额、保留/删除策略与跨租户拒绝 conformance。单机 `CRAFT_DATA_DIR` 不应被
误说成多租户隔离。

## P1：A2A v1 的真实互操作 Adapter

### 行业事实

A2A v1.0 面向不透明的独立 Agent，通过 Agent Card 发现能力、Task/Message/Artifact
协作、流和异步推送；它不要求共享内部 memory、工具或思维链。远程服务需加密传输，
认证后的 Extended Agent Card 可以暴露更多能力。A2A v1.0 是有破坏性变化的版本，
不能把旧模型自动称为兼容。

来源：[A2A v1.0 Specification](https://a2a-protocol.org/v1.0.0/specification)、
[A2A v1.0 release](https://github.com/a2aproject/A2A/releases/tag/v1.0.0)。

### 当前 Craft 事实

Craft 已有 A2A Card 的不可信发现、reference-only delegation、grant、撤销、健康和
本地治理规则；文档明确远程身份、传输、推送和 Artifact 内容是部署 Adapter 的工作。

### P1 缺口与最小交付

增加可插拔 **A2A v1 Adapter**：协议版本协商、Agent Card/Extended Card 映射与签名
验证、caller task/tenant/budget 的绑定、幂等 request id、Task 状态/stream/cancel、
Artifact reference 的分类/TTL/留存、callback/abort/revoke 审计，以及官方 TCK/fixture
互操作测试。A2A 不读取 Craft Memory；远端 Agent Card/回执不能单独作为质量或安全
Gate。

## P1：第三方 MCP / Skill 供应链的可运营治理

### 行业事实

MCP 把 Tools 当成任意代码执行面，并明确说明非可信 Server 的工具描述也不可信；MCP
本身不能在协议层替实现者强制 consent、访问控制或隐私保护。

来源：[MCP Specification — Security](https://modelcontextprotocol.io/specification/draft)。

### 当前 Craft 事实

Craft 已有 Capability Source、Kit digest、Connector health/revocation 和 Activation
Ticket；当前能力矩阵仍将远程 Registry 的签名、moderation、健康调度和官方治理列为
部署治理。

### P1 缺口与最小交付

交付一个独立 Supply-Chain Service/Adapter：签名与发布者身份、digest pin、依赖/SBOM
投影、恶意工具描述与提示注入 fixture、Registry 健康轮询、漏洞通报/撤销传播，以及
安装与激活分离的审计。不要让“发现到的 Skill/MCP”直接进入模型工具面或 Context。

## 取舍

1. **先 P0 Remote MCP 和真实 Campaign**：这是“别人直接使用 Craft MCP”与“自适应
   有真实证据”的前提。
2. 然后做 **RemoteTaskBinding + A2A v1 Adapter**：两者共享 principal、租户、TTL、
   budget、cancel 和审计模型，应设计为一条远程协作边界。
3. 最后做供应链服务：它服务生态扩展，不应阻塞单机/受信任本地 Source。

不建议为此默认增加多 Agent、RAG/向量、世界模型、UI 或自动执行模型生成脚本。它们
都应继续作为由 Campaign 证明有效后才增加的 Harness/Adapter 选择。
