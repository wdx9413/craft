# v0.12.30 距离“面向人和 AI 的通用工作运行时”理想态：一手资料复核

日期：2026-09-15。范围：仅复核当前还未由 v0.12.30 代码/文档覆盖的 P0/P1；不把
已有的 Trace、Verification、Eval、Kit、Context Receipt 或本地 Runtime Contract 重列为
缺口。

## 结论

Craft 的内核方向已足够清晰：它不是聊天 UI 或单一模型 Harness，而是一个把工作事实、
能力资产、最小上下文、权限/效果、验收证据和受限演进统一起来的 Runtime。当前距离
理想态的关键不是更多 Skill、默认多 Agent、世界模型或行业标签，而是以下五个“从
契约到真实运行”的 P0/P1 能力。

| 优先级 | 真正缺口 | 为什么它决定理想态 |
|---|---|---|
| P0 | 真实 Host / Outcome 的持续验收实验室 | 没有真实运行证据，不能证明 Runtime 比纯宿主工作流更可靠 |
| P0 | 可部署的安全执行与远程访问参考栈 | 没有可信执行环境、IdP/Broker/网关，写操作和远程 MCP 仍只是本地契约 |
| P1 | 独立 Agent 模式的最小 Provider/Host 实现 | 否则 Craft 只能当控制台，尚不能在需要时成为独立 Agent Runtime |
| P1 | 完整 A2A v1 互操作与远程协作运维 | 当前是安全的最小投影，尚非可长期运行的远程协作服务 |
| P1 | 组件生态的稳定 SDK、运营治理与可观测性 | MCP-first 能被别人直接使用，才不只是多个本地插件 |

## 当前已覆盖的基础（代码事实）

下列能力已在 v0.12.30 的本地实现/测试和文档中出现，因此本研究不把它们当成新的
开发项目：

- KnowledgeSource、MemoryLedger、Context Resolution Receipt，以及向量检索的
  召回/泄漏/时延/成本准入；
- Capability Source/Kit/Connector、版本/digest、信任、健康、激活 Ticket 与候选
  演进门；
- canonical Trace、Host Session 连续事件、独立 Outcome Observer、Acceptance、
  Campaign/Signoff/Canary；
- OIDC/JWKS 资源服务器校验、RemoteTaskBinding、Tenant 元数据、发布者摘要签名；
- A2A v1 的 HTTPS Card、`message/send`、`tasks/get/cancel` 的 read-only、grant-bound、
  digest-only 基础投影；
- `full/context/knowledge/memory/capability/quality/evolution/admin` MCP 产品面与
  插件仅做分发的架构。

来源：[`current-capability-matrix.md`](../technical/current-capability-matrix.md)、
[`runtime-proof-deployment.md`](../technical/modules/runtime-proof-deployment.md)、
[`component-plugin-architecture.md`](../technical/modules/component-plugin-architecture.md)。

## P0：真实 Host / Outcome 的持续验收实验室

### 一手事实

Anthropic 将 Agent Eval 拆为 Task、Trial、Trace、Outcome 和 Harness；对会改变环境的
Agent，Outcome 是环境中的真实终态，不是模型的完成自述。其 2026 基准实验还显示，
CPU/RAM/超时等基础设施配置可造成超过小型榜单差距的变化，因此环境本身是被测系统的
一部分。

来源：[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、
[Quantifying infrastructure noise in agentic coding evals](https://www.anthropic.com/engineering/infrastructure-noise)。

### 对 Craft 的推论

`RuntimeAcceptanceKernel` 已定义正确的机制，但还需运行一个持续的、公开可复现的
**Acceptance Lab**：

- 至少两个真实 Host：先是 Codex App embedded Host，再是独立 CLI/provider Host；
- 两条脱敏 Case，固定模型、Host、能力版本、Harness、环境、资源/预算、超时、重试
  和网络策略；
- 每次由独立 Outcome Observer 读取测试、文件或交付物终态；
- 以 repeated paired Trial 比较 baseline/candidate，同时报告质量、成本、时延、
  基础设施失败率和 `inconclusive`；
- 将通过的 Case 转为防回归 suite，将 Host/Observer 失败分类反馈到 Adapter 健康。

**不应做：**用 LLM 自评、单次 Demo 或“Host 说完成”替代 Outcome；也不应在数据不足时
默认开启 multi-agent/evaluator。

## P0：生产级执行与远程访问 Reference Stack

### 一手事实

MCP 的 HTTP 授权要求 OAuth 2.1、resource/audience 绑定、HTTPS、PKCE 和安全 token
处理；收到的 client token 不得直接透传给下游。MCP 还要求把 Tool 当作潜在任意代码
执行面，非可信工具描述不应被自动相信。

来源：[MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)、
[MCP security guidance](https://modelcontextprotocol.io/specification/draft)。

OpenAI 的 2026 Agents SDK 将可移植 Workspace Manifest、可恢复 Sandbox Session 和
Sandbox Client 明确分开：运行时负责审批、追踪与恢复，Sandbox 负责命令、文件变化和
环境隔离。

来源：[The next evolution of the Agents SDK](https://openai.com/index/the-next-evolution-of-the-agents-sdk)、
[Sandbox Agent concepts](https://openai.github.io/openai-agents-python/sandbox/guide/)。

### 对 Craft 的推论

现有 OIDC/JWKS、RemoteMcpAccessPolicy、Platform Conformance、Egress/Broker 是正确
边界；P0 是提供一条**实际可部署的参考路径**，而非把密钥或云厂商逻辑塞进 Core：

1. OIDC/PKCE/短期 token、TLS 终止、JWKS rotation、撤销、持久限流和审计网关；
2. 一个支持 Manifest、snapshot/rehydrate、文件/命令/网络白名单、资源上限、取消清理
   的 Docker 或托管 Sandbox Adapter；
3. 最后一跳 Credential Broker/token exchange，确保 sandbox/模型/插件拿不到原始
   凭据；
4. 写操作前后统一执行 pre-effect/post-effect guardrail、Receipt、再观察与补偿/处置；
5. 真实攻击和故障 conformance：错误 audience、过期/撤销 token、SSRF、恶意 tool
   description、路径逃逸、网络逃逸、重复写入、取消和恢复。

**不应做：**把读任务也强制塞进高成本 Sandbox；也不应把某一个 macOS/Docker 检查
记录说成跨平台隔离已经完成。

## P1：最小独立 Agent 模式，而不是重造 Codex/Claude

### 一手事实

Anthropic 的 2026 Managed Agents 把可持久 Session、可替换 Harness 和执行 Sandbox
解耦；Harness 中关于模型能力的假设会随模型演进过时。OpenAI 也将 Agent/Runner、
Session、Sandbox、工具和 Trace 作为可组合层，而非必须绑定单一应用。

来源：[Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents)、
[OpenAI Agents SDK overview](https://openai.github.io/openai-agents-python/)。

### 对 Craft 的推论

Craft 已能作为 Codex/Claude/IDE 控制台，但“可在需要时独立运行”的部分仍应有一个
最小 Provider/Host Reference Adapter：

- 模型 Provider 接口只负责 `generate/stream/cancel/usage`；不进入 Core；
- Runtime 继续拥有 Task、Context Receipt、Policy、Ticket、Session Event、Outcome 与
  Eval；Provider/Host 只回传事实；
- 先支持一个受限文本/工具 Host 和一个 Sandbox Host，真正复用当前产品 MCP 面；
- 模型切换、失败回退、预算和 resume 都必须形成可比较 Receipt。

**非目标：**不复制 Codex 的桌面 UI、终端、账号体系或私有工具；嵌入式 Host 也不应被
Craft 自动再启动一个 CLI。

## P1：A2A v1 从“安全投影”到可运营远程协作

### 一手事实

A2A v1 面向不透明的独立 Agent：Agent Card 用于能力发现，Task/Message/Artifact 用于
协作，支持同步、流、异步推送和人工介入；它不要求交换内部 memory、工具或思维链。
生产服务使用加密传输和标准认证，Extended Agent Card 可按已认证身份呈现更多能力。

来源：[A2A v1.0 Specification](https://a2a-protocol.org/v1.0.0/specification)、
[A2A protocol source](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)。

### 对 Craft 的推论

当前 Card + send/get/cancel + Grant 已是正确最小安全起点。下一步应是一个可选 A2A
运营 Adapter：stream/push notification、输入补充、人类审批状态、Extended Card/JWS、
协议版本协商、Artifact reference 的分类/TTL/保留、端到端 cancel/abort/revoke、并发/预算
配额、远端健康 SLO 和 A2A TCK 互操作测试。

**不应做：**把远端 Agent Card、远端“成功”或远端 Artifact 当成 Craft 的安全、质量或
长期 Memory 事实；先以 read-only 远程委派证明价值，写入型协作仍需更强的 Broker 和
补偿边界。

## P1：Knowledge/Memory、组件化与可观测性的运行化

### 一手事实

Anthropic 将上下文视为有限注意力预算，主张逐次挑选高信号信息；结构化笔记应保存在
context window 之外再按需取回。OpenAI Sandbox Memory 也将对话 Session 和记忆提炼
区分，并允许某些子 Agent 只读记忆、不生成记忆。

来源：[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)、
[OpenAI Agent memory](https://openai.github.io/openai-agents-python/sandbox/memory/)。

### 对 Craft 的推论

1. **Memory/Knowledge 运营评测**：用真实脱敏 corpus 和跨项目隔离集，持续评测检索
   召回、错误引用、泄漏、过期率、上下文预算和“是否改变 Outcome”；默认仍是最小
   Context，不做全量自动记忆。
2. **Component SDK / conformance**：把 MCP Product、Skill、Plugin、CLI/SDK 统一为
   一个版本化 Component Contract（manifest、权限/effect、数据空间、迁移、健康、
   deprecation、测试 fixture）。插件继续只是分发壳，不能拥有第二份业务账本。
3. **可观测性运行面**：在已有 OTLP/Trace 合约上，交付部署 collector、跨 Host
   correlation、redaction policy、SLO（恢复率、Outcome 成功率、成本/成功、权限拒绝、
   sandbox/远端失败率）和 drift/撤销告警；将告警映射回 Run、Capability、Provider 或
   Sandbox 版本，而非只记录日志。

**不应做：**为所有内部模块各开一个 MCP Server，或把聊天历史无差别写入 Memory；
也不应以静态行业标签树取代项目/任务事实和动态检索视图。

## 推荐顺序

1. **先跑 Acceptance Lab，并同步做生产 Reference Stack。** 前者证明价值，后者让
   有副作用和远程调用可安全落地；两者共同构成 P0。
2. **实现最小独立 Agent Host，并将它纳入同一 Campaign。** 它证明 Craft 不依赖某一
   宿主，但不与 Codex/Claude 争夺 UI/模型能力。
3. **补 A2A 运营 Adapter 与 Component/Observability 运行面。** 仅在单 Agent 数据
   显示需要后扩大多 Agent 或远程协作比例。

达成这些后，Craft 才可以准确称为：**面向人和 AI 的通用工作运行时——既可作为既有
Agent 的控制台，也可通过可替换 Host 独立运行；无论入口如何变化，状态、边界、证据
和受限演进始终是同一份 Runtime 事实。**
