# Current Capability Matrix (v0.12.34)

## 单点能力的统一评测契约

单点能力要能被 Codex、Claude、IDE 或独立 Agent 单独接入，但“能调用”不等于“值得路由”。每个组件都应提供同一组证据阶段：

| 阶段 | 证明什么 | 典型检查 | 可否成为默认路由 |
|---|---|---|---|
| `mechanism_passed` | 接口和不变量正确 | schema、输入校验、scope/effect、版本/摘要、失败关闭 | 否 |
| `fixture_passed` | 本地确定性机制可工作 | 脱敏 Case、边界、冲突、漂移、幂等、恢复、敏感泄漏 | 否 |
| `conformance_passed` | 运行时边界保持失败关闭 | 沙箱/网络/凭据/资源/输出与清理证明 | 否 |
| `integration_passed` | 接入 Craft 核心账本 | Policy、Trace、Receipt、State、Acceptance 的一致性 | 否 |
| `host_verified` | 接入真实 Host 后仍遵守契约 | Host Receipt、State Observer、超时/取消、Trace 完整性 | 否 |
| `business_eligible` | 在固定业务 Case 上产生净收益 | Outcome、成本/时延、恢复率、回归、盲评/独立 Grader | 仅进入 Signoff/Canary |
| `routeable` | 已通过发布门并可被最小激活 | held-out、等预算配对、Signoff、Canary、回滚目标 | 是 |

能力的检查面至少包括：输入/输出契约、权限与数据隔离、版本和 digest 一致性、失败关闭、重试与幂等、恢复与取消、成本/延迟、兼容性以及真实终态。单元测试和 MCP 握手只能证明前两层，不能替代 Host 或业务效果证据。

## 当前架构审查结论

当前矩阵大多记录“本地协议已实现”，但仍需避免把协议状态写成产品承诺：`Runtime Proof`、`Host Session`、`Outcome Observer`、A2A、真实模型和外部隔离仍依赖 Adapter/部署证据；`Automatic experience publication` 仍不是自动行为。v0.12.34 的主目标应是把这些事实接入同一 `VerifiedWorkLoop`，而不是再增加新的平行 MCP 入口。

## 对外名称与兼容别名

当前实现同时存在产品能力名、组件投影名和历史兼容名，不能把它们当成三套实现：

| 语义 | 当前推荐入口 | 兼容/历史名称 | 说明 |
|---|---|---|---|
| 完整组合根 | `craft` | 无 | 装配 Core、Context、Capability、Quality、Host Bridge |
| 知识 | `craft-knowledge` / daily component MCP | `component-knowledge`、`craft-context` 的知识投影 | 默认只暴露日常小工具面；高级面与默认面共享 KnowledgeSource、Evidence 和 Context Receipt |
| 记忆 | `craft-memory` / daily component MCP | `component-memory`、`craft-context` 的记忆投影 | 默认只暴露受管候选/当前 scope 解析；高级面与默认面共享 MemoryLedger 和 scope 规则 |
| 能力发现 | `craft-capability` | 无 | 发现、激活、授权、调用严格分离 |
| 通用质量 | `craft-quality` | `craft-skill-quality` | Skill、MCP、Host、Memory、Knowledge 都是 Subject，不限于 Skill |
| 经验/工作流演进 | `craft-experience` / daily component MCP | `component-experience`、旧 workflow-evolution 名称 | 默认是观察到草案的最小路径；只产生 Candidate，不能绕过 Eval/Signoff/Canary |

`craft-runtime`、`craft-workflow` 若尚未出现在 Marketplace，不应在文档中宣称已是可安装产品；它们目前属于内部领域概念或未来投影。发布门禁应同时覆盖 Codex 与 Claude manifest、Marketplace 独立仓库和所有组件的工具面，避免宿主缓存旧协议或旧名称。

| Area | State | Boundary |
|---|---|---|
| Primary `craft` plugin composition | implemented and tested locally | one compact syscall surface reaches built-in Context, Capability, Quality and bounded Workflow Evolution; `craft-context`、`craft-capability`、`craft-quality` are optional projections, not prerequisites |
| Project Brain / Work Session | implemented and tested locally | editable goal/decision/material kernels plus a digest-pinned Context Manifest; Markdown remains source of truth |
| Default Internal Host tools | implemented and tested | five bounded syscall actions; external tools remain explicitly routed through MCP/Host adapters |
| CLI `run` vertical slice | implemented and tested locally | creates/continues Project Brain + Work Session and records outcome; model/provider credentials remain deployment configuration |
| Workbench project experience | implemented locally | read-only projection routes for Brain, sessions, traces and checkpoints; native desktop shell is separate packaging work |
| Bounded Action Gateway | implemented locally | workspace read/write with traversal protection and approval; shell/browser/MCP require explicit adapters |
| Independent Acceptance Gate | implemented locally | Host completion cannot create a passed verified Outcome without Artifact and Evidence |
| Durable Worker lease/recovery | implemented locally | persistent bounded worker state; OS daemon, tray and notification delivery remain adapters |
| Provider fallback route | implemented locally | provider order and usage receipt; protocol streaming and credentials remain Host/Model adapters |
| Standard A2A operations | protocol adapter | digest-only message/send, stream and task list; auth, push, Artifact content and remote execution remain deployment work |
| Federated delegation | governed remote collaboration | health-bound one-time Grant, scoped Artifact grants, revocation and indeterminate timeout; remote transport/identity remains an Adapter concern |
| Harness topology | evaluated optional coordination | single-Agent baseline by default; up to five read-only roles only after paired evidence; no hidden Agent launch |
| Runtime readiness | deployment fact assessment | evidence, recovery, platform preflight and enterprise binding blockers; does not claim a Host/Sandbox/Broker is deployed |
| Context selection | implemented | exact references and digests; vector search remains optional |
| Knowledge Source / Memory Ledger | implemented and tested locally | source scope, digest, trust/access, legacy reference bindings, expiry/revocation and sensitivity are explicit; external systems remain source-owned |
| Legacy formal knowledge migration | implemented and tested locally | one-time offline importer reads 53 eligible `kefu_llm_wiki` pages into candidate/Evidence records; runtime MCP/Host never scans the legacy tree; no legacy DB/MCP/Gate/FTS index or raw body is copied |
| Context Resolution Receipt | implemented and tested locally | content-free exact memory/source versions and budgets; untrusted/revoked sources and restricted memory fail closed by default |
| Component data-space identity | implemented and tested locally | every `craft_info` returns a content-free `data_space_id`; components with different IDs must not assume Ledger, Receipt or Evidence interoperability |
| Retrieval Adapter admission | implemented and tested locally | keyword default; vector requires provider fingerprint plus recall, zero-leakage, latency and cost evaluation |
| Turn Cognitive Runtime | implemented and tested locally | Host/Craft Agent submits a content-free semantic proposal; scoped Policy issues a minimal receipt and optional user-governed memory candidate, but cannot install Host hooks or execute tools |
| Turn Policy evaluation | implemented and tested locally | deterministic fixture checks decision accuracy, false-positive selection and scope rejection; it is a stage evaluation, not proof of business Outcome |
| Console / Agent mode plan | implemented and tested locally | same verified protocol projects a Host-bound plan; it does not duplicate provider model calls or terminal execution |
| Continual Harness view / refinement | implemented and tested locally | content-free exact bindings; low-risk Session memory/prompt changes have privacy review and TTL, while governed changes require shadow Eval, exact Signoff and Canary |
| Stateful compute protocol | implemented and tested locally | generic Host descriptor, Session, Dispatch, monotonic state Receipt and re-observation; no embedded code executor or vendor-specific Agent binding |
| Sub-agent function calls | implemented and tested locally | at most five asynchronous read-only calls per parent Session with explicit context references, budget, Evidence and result contract; single Agent remains the default |
| Trace / Workbench projection | implemented locally | controlled Replay Runner now revalidates the terminal Trace and records step receipts; external effect executors remain deployment adapters |
| Long-task recovery | implemented protocol | fresh Host dispatch is required after process release |
| OTel / OTLP | implemented adapter contract | deployment collector is external |
| OS sandbox / Secret Broker | local contracts and probes | production isolation requires a platform adapter |
| Runtime Assurance | implemented and tested locally | attests terminal Host receipt, re-observation, environment/budget and write preflight; it does not invent external execution proof |
| Assured Pilot | implemented and tested locally (v0.12.17) | binds verified Host facts, recovery drill, trusted capability versions and one-time sealed Case access; any drift requires replanning |
| Capability Kit Registry | implemented and tested locally | declarative exact-version Kit manifests, pinned dependencies, lifecycle state, digest and provenance; install is not code loading |
| Kit Conformance / Activation | implemented and tested locally | static mechanism checks plus Task-bound activation; dependency drift, disable or revoke fail closed and require replanning |
| Kit presentation | implemented and tested locally | one Kit descriptor may project Skill, MCP, CLI and plugin surfaces; Core MCP exposes read-only inspection while Full MCP keeps lifecycle writes explicit |
| Built-in vertical samples | implemented and tested locally | Serena project knowledge and local workspace Kits exercise the supply boundary only; actual Host/Serena execution remains adapter-owned |
| External Connector health/revocation | implemented and tested locally | exact scope, metadata digest and current health gate ticket consumption; host-owned transport/credentials remain external |
| A2A / organization sync | digest-only transport and local conflict rules | remote identity, storage, and policy require deployment evidence |
| MCP Registry sync | implemented adapter | HTTPS pull and local ingest only; signature, moderation, health scheduling and official registry policy remain deployment governance |
| Durable checkpoint tick | implemented locally | expiry/wake processing is bounded; v0.12.13 adds persistent worker leases and recovery, while OS scheduler and notification delivery remain adapters |
| Project Bundle / Handoff | implemented locally | digest-verified portable references preserve project continuity without copying raw business content |
| Feedback / Domain Evaluation / Cost | implemented locally | scoped feedback, metric-based domain evaluator contracts, and provider price/usage attribution are recorded; business-specific scorers remain external |
| Trust Profile / autonomy compounding | implemented and tested locally | evidence-backed recommendation is scoped, expiring and revocable; it never grants execution authority or silently escalates effects |
| Web operation boundary | implemented and tested locally | bounded credential-free HTTP GET/HEAD observation plus adapter-only browser contracts; clicks, forms and submits require an explicit host/plugin Adapter |
| MCP HTTP transport | implemented and tested locally | bounded JSON POST `/mcp` gateway with size and Accept checks; optional Remote Access Policy fails closed on non-TLS, missing verifier, issuer/audience/scope/expiry mismatch and rate exhaustion; IdP/TLS gateway remain deployment adapters |
| OIDC/JWKS reference verifier | implemented and tested locally | RS256/JWKS resource-server Adapter verifies issuer, audience, expiry and signature without storing a token; authorization-code/PKCE, TLS termination, token exchange and revocation are deployment-owned |
| Remote Tenant / Task Binding | implemented and tested locally | opaque one-time handle is bound to Task, tenant data-space, principal/receipt digests, audience, scopes and expiry; remote result/cancel/stream reads must re-authorize and tenant disable/revocation fails closed |
| Host Session Protocol | implemented and tested locally | content-free contiguous events map into the canonical Trace; embedded Host only reports facts and never causes a second CLI to start |
| Independent Outcome Observer | implemented and tested locally | observed snapshot and Evidence are distinct from Host self-report; it never independently grants promotion |
| Runtime Acceptance Campaign | implemented and tested locally | requires two declared Hosts, two sanitized Cases, pinned environment/budget and independent observed outcomes; 3–4 trials are diagnostic and only strict five-trial evidence can become eligible for later Signoff/Canary |
| Publisher provenance attestation | implemented and tested locally | public-key signature proves a digest was signed and fails stale on digest drift; it never installs, activates or replaces existing certification |
| A2A v1 Adapter | implemented and tested locally | HTTPS Agent Card plus `message/send`, `tasks/get` and `tasks/cancel` are grant-bound, idempotent, digest-only protocol projections; remote identity, Artifact content and production transport remain deployment work |
| Automatic experience publication | not automatic | Evaluation, Signoff, Canary, and human publication remain mandatory |
