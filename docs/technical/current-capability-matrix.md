# Current Capability Matrix (v0.12.33)

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
