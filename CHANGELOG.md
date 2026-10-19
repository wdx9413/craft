Warning: truncated output (original token count: 38203)
Total output lines: 2642

## v0.12.77（Worker 子进程退出恢复）

- 处理 MCP 子进程退出后标准输入写入触发的 EPIPE，避免未处理事件中断 Worker，确保失败结果仍以结构化记录输出。
- Worker 子进程退出用例与 100% 覆盖率门禁通过。

## v0.12.76（生成内容语言设置）

- 在 `~/.craft_data/config/config.json` 增加 `contentLanguage`，默认 `zh-CN`，支持有效的 BCP 47 语言标签。
- 新增 `craft config language <tag>`，并将配置传入 Knowledge 分类、Experience 场景分类和 Workflow 草案生成提示。
- 明确保留 Memory 用户原文、来源原文、稳定场景键和 JSON 字段名，不自动翻译。

## v0.12.75（Worker MCP 版本握手）

- Experience/Knowledge Worker 启动时校验 Craft MCP 的服务端版本；版本不符时关闭子进程并停止取任务，避免新 Worker 静默连接旧 MCP。
- Worker MCP 客户端关闭后立即拒绝新请求，并保持重复关闭安全。
- 增加匹配版本、缺失版本、旧版本和非 Craft 适配器回归覆盖。

## v0.12.73（Context Host 工具面收敛）

- Context 默认 MCP 工具从 233 项收敛到 46 项，低于 Host 的 90 项注册上限；Knowledge、Memory、Experience 操作通过按需发现和受限 `craft_run` 路由调用。
- 路由按 Context 能力清单限制，并校验被路由工具的参数；内部学习 Worker 仍使用完整 Context 工具面。
- 组件诊断识别精简路由模式，避免把可发现调用误判为 Host 缺少组件工具。
- 增加真实 MCP 分发、路由边界、参数验证和精简工具面回归验证。

## v0.12.72（Knowledge 独立评测来源门禁）

- Knowledge 检索评测只有在来源会话、任务、Evidence、脱敏状态和留出分区均可核验，且与被评 Claim 来源隔离时才具备评测资格。
- Wiki 候选评测授权要求绑定具备来源证明的 Knowledge 检索评测；普通 `eligible` 状态或被篡改的指标不能绕过来源门禁。
- 增加独立会话来源、候选评测桥接和失败分支回归验证。

## v0.12.71（Experience 空闲轮询退避）

- Experience Worker 空队列时逐步延长轮询间隔，最长 5 分钟；检测到分类、候选或评测工作后恢复基础间隔。
- 增加长驻 Worker 间隔验证，保持 Worker 文件语句、分支、函数、行覆盖率 100%。

## v0.12.70（Experience 独立会话来源）

- Experience Host 观察保留精确来源会话标识；候选提案要求来源来自不同 Host 会话，同一会话内的多条任务不再冒充独立证据。
- 场景分类 Worker 将来源会话标识带回终结记录；旧请求不补造会话标识。
- 增加 Hook、MCP、分类 Worker 和 Experience 提案的独立会话回归验证。

## v0.12.69（Knowledge 候选状态保留）

- Host 评审认为证据不足或无法晋升时，保留 Claim 原有候选状态；仅明确驳回才标记为争议，避免 Worker 把待补证候选误降级为过期。
- 增加状态保留与拒绝分支回归验证。

## v0.12.68（Codebase 项目数据与检索评测）

- 仓库快照、语义图分片、分析缓存和检索评测报告写入项目 `.craft_data/codebase/`；必要时只修改该仓库私有 `.git/info/exclude`，避免把生成数据提交到 Git。
- 改进中英文任务描述的符号检索排序，并修正 Go 接口实现关系的范围识别。
- 增加评测报告持久化、项目数据 Git 排除、缓存重建和关系图覆盖回归。
- 修复跨平台适配器构建步骤。

## v0.12.67（Knowledge Ticket 项目根目录解析）

- Knowledge 分类 Ticket 列表依据 Claim 的可信 Source 定位场景目录；同一项目存在多个工作树别名且旧 Claim 指向全局 Markdown 时，仍能列出有效 Ticket。
- Source 项目根推导逻辑收敛为 Knowledge 共享辅助函数，供摄取与 Ticket 场景校验复用。
- 增加多路径别名和旧全局内容引用回归。

## v0.12.66（Knowledge Source 项目路径修复）

- 项目 README Source 重摄取时，按已登记的 Source 根目录绑定项目 Knowledge 内容与场景目录，避免同一项目的多个工作树路径别名造成路径歧义。
- 旧 Claim 引用全局 Markdown 路径且没有场景键时，不再因无效目录更新阻断 Source 重摄取。
- 增加旧全局内容路径、多项目路径别名和自定义 Source 的回归验证。

## v0.12.63（Knowledge Worker 项目根目录恢复）

- 后台 Knowledge 分类 Worker 从项目 Claim 的精确 `.craft_data/knowledge/md` 内容路径推导项目根目录，继续使用项目隔离的场景目录和模型票据；全局 Claim 不推导项目根目录。
- MCP 场景目录查询与模型票据工具公开可选 `project_root` 参数，避免 Worker 传参被工具契约丢弃。
- 增加路径有效性、错误路径、工具 Schema 和真实 MCP 调用回归验证。

## v0.12.64（Knowledge 项目票据校验闭环）

- Knowledge 分类 Ticket 校验沿用 Worker 提供的已登记项目根目录；未登记根目录仍拒绝，确保场景目录隔离。
- 项目 Claim 带有无法映射到项目根目录的旧内容引用时，Worker 将其作为受控跳过记录，继续处理其余 Claim。
- 增加 Ticket 项目范围校验、旧引用跳过和分类分支覆盖回归。

## v0.12.65（Knowledge 全局目录隔离）

- 项目 Claim 若引用的是全局 `$CRAFT_DATA_DIR/knowledge/md` 内容，Worker 不再把用户主目录误识别为项目根；该 Claim 会受控跳过，其他可定位项目继续分类。
- 增加全局内容路径隔离回归，Knowledge 分类覆盖率保持行、分支、函数 100%。

## v0.12.60（项目级 Knowledge 隔离）

- 项目 Knowledge 正文改为写入各自项目的 `.craft_data/knowledge/md`；场景目录也归属该项目的 `.craft_data/knowledge`，不再落入全局数据目录。
- Knowledge 内容读取校验 Claim 范围；未登记项目路径时拒绝写入，防止不同项目串用全局目录。
- 自动审核工具要求调用方提供明确范围；缺少范围或范围外 Claim 不会进入审核。同步更新 Context 工具说明与隔离、回归测试。

## v0.12.59（Knowledge 评测工具发现）

- Context 的 Knowledge 工具发现新增固定评测用例保存、列表、执行与结果读取接口，允许 Agent 从统一入口建立和运行 Knowledge 检索评测。
- 增加对工具名与输入参数结构的回归验证。

## v0.12.58（Knowledge 候选摄取幂等）

- 相同来源片段合并到候选 Claim 时，仅在新增 Evidence 引用时保存新版本；重复摄取不再反复递增 Claim 版本，避免 Worker 对未变化内容空转重审。
- 增加跨重复文件、重复轮次摄取的回归验证，确保 Evidence 集合保持唯一且版本稳定。

## v0.12.57（Knowledge Host 结构化输出）

- Knowledge 分类与 Evidence 审核向 Codex Host 传递严格 JSON Schema，CLI 使用 `--output-schema` 限定响应；不同响应契约使用独立 schema。
- Schema 只在系统临时目录以私有权限短暂写入，并在成功或失败后删除；模型回复仍不持久化。
- 分类输入摘要升级契约版本，使旧失败记录不会阻止新输出约束下的受控重试；增加 Host 参数、schema 校验、清理和分类请求覆盖。

## v0.12.56（Knowledge 失败票据抑制）

- Knowledge 模型完成后若分类或审核失败，只保存票据、输入摘要、失败阶段、受控错误码和时间；相同输入不再每轮重复发送，状态保存在 `~/.craft_data/knowledge/classification-attempts.json`。
- Claim/Evidence、场景目录、模型 Profile 或分类契约变化会形成新摘要并允许重试；模型请求未成功返回时仍保留重试能力。
- Trace 与 Worker 诊断增加安全失败阶段和错误码，不保存模型回复或业务正文；增加重启恢复、输入变更、符号链接、状态损坏与容量边界覆盖。

## v0.12.55（学习 Worker 单实例锁）

- 同一 `~/.craft_data` 下，Context Worker 原子占用 Knowledge 与 Experience 组件锁，Knowledge/Experience 独立 Worker 仅占用各自锁，避免多个 MCP 会话重复消费同一学习票据。
- 锁元数据先完整写入私有临时文件，再通过同目录硬链接原子发布；活动锁不重复启动，死进程锁可恢复，损坏状态仍安全失败。
- 为并发启动、死锁恢复、所有权变化、异常清理补充定向测试；模块增量覆盖率保持 100%。

## v0.12.54（Knowledge Ticket Trace 闭环）

- Knowledge 分类与候选审核 Ticket 必须绑定真实 Host Trace，并验证模型完成和结果摘要；历史无可验证 Trace 的完成票据会重新发行恢复票据。
- 候选 Claim 先由 Host 对有界 Evidence 分片做支持性审核，再进入既有 Knowledge 治理流程；不足或冲突的证据不会晋升。
- 为 Ticket 恢复、Evidence 审核边界、异常结果和 Trace 绑定增加定向回归覆盖。

## v0.12.53（语义索引失败自动重试）

- Codebase 的可信 LSP 语义分析失败时保留明确的 partial 回退，并记录 5 分钟重试时间；冷却期后自动重试，成功后清除重试标记。
- 重试使用新的索引身份，避免同一源码和配置下失败回退与成功语义图发生幂等冲突。
- 增加 LSP 配置单独变化的重建回归验证，并覆盖失败冷却、自动恢复和重试状态清理。

## v0.12.52（Knowledge 引用候选分类修复）

- Knowledge 分类 Worker 可从引用型 Claim 获取并核验完整内容，再提交场景分类候选；模型输入仅包含脱敏后的有界内容，日志不记录 Claim 正文。
- 覆盖项目 scope 的规范标识与历史别名，避免同一项目 Claim 因旧 scope 命名而漏分类。
- 为持续 Worker 开放受限 Trace 写入工具，使请求、模型回执和候选保存留下可查询记录；集成验收覆盖自动分类、晋级和 Canary 再迭代。

## v0.12.51（启动内容索引限域）

- CraftStore 启动重建内容索引时，仅扫描可能包含 Markdown 引用的知识、记忆和 Experience 记录，并逐行处理；避免遍历大型 trace/archive 历史并一次性载入内存。
- 增加覆盖知识片段、Wiki、情景记忆、语义记忆、Experience Procedure 和空引用 Claim 的索引重建回归验证。

## v0.12.50（Go 语义索引预算）

- 统一 Go LSP 配置与请求的关系符号上限，允许在可信配置中按仓库规模提高预算；上限仍受 12,000 硬限制。
- Language Server 提前关闭输入管道时，等待关闭事件给出稳定错误，不再让未处理的 EPIPE 终止 Host。
- 用真实 Go 仓库验证 825 个文件的语义索引和增量重建；关系结果明确标记为 partial，增量图与干净重建一致。

## v0.12.47（学习 Worker 配置诊断）

- Knowledge 场景分类因模型配置缺失而跳过时，持续 Worker 输出经脱敏的原因并继续轮询；一次性运行返回非零退出码，避免把“未分类”报告成成功。
- 对未识别原因使用通用安全提示，不将 provider 返回的任意内容写入日志；无可处理 Claim 时保持安静。

## v0.12.46（Experience 终态分类续接）

- Host 在 Hook 已写入未分类终态后补充语义场景时，原位升级同一 Observation 版本并复用 Evidence；不重复计数。
- 分类升级仅允许从未分类到显式场景，需匹配相同 Host、turn、Context receipt、验证指纹和结果；兼容 0.12.45 已有的无终态摘要 Evidence。
- 保持独立任务候选、模型提交以及 Shadow、Held-out、Signoff、Canary 晋级门槛。

## v0.12.45（Host 缓存刷新与自进化验收）

- 版本推进用于区分同版本但内容不同的 Host 缓存；统一 Context 包基于当前源码重新构建并同步到 Marketplace。
- 验收三能力隔离数据根上的自动流程：Memory 分层晋升、Knowledge Claim 审核晋升、Experience Canary 迭代。
- Knowledge 与 Experience 场景仍由模型提出语义定义，Craft 管理稳定 Catalog、层级、证据阈值与迁移。
- Knowledge Catalog 按能力目录保存全局与项目场景：`~/.craft_data/knowledge/global/` 和 `~/.craft_data/knowledge/projects/{project_id}/`；分类、检索、退役与迁移均按精确 scope 隔离。
- 没有可用 Provider Profile 时，Experience 回执交由当前 Host 模型读取脱敏请求并提交候选，继续走原有 Shadow、Held-out、Signoff、Canary Gate；Knowledge 日常 MCP 面补齐精确审核包工具。
- Context 的 Experience 工具发现补齐候选读取/提交、评测派发与恢复、Model Profile/Ticket 查询，使当前 Host 能从回执走完并恢复发布前评测闭环，而不只看到观察和路由入口。
- Context 的 Memory 工具发现补齐 Ledger 读取、撤销/转移、维护与会话归档入口；无 Hook 的 Host 也能执行记忆退出和临时记忆清理。
- Context 的 Knowledge 工具发现补齐来源注册/枚举、候选读取和自动审核策略查询；无 Provider Profile 的当前 Host 可处理来源与待审核 Claim，晋升仍受原证据规则约束。
- Knowledge Skill 为无 Provider Profile 增加当前 Host 的有界续处理路径：每个 Knowledge 任务最多审核一个仍绑定当前可信 Source 的候选，陈旧、争议与需重验 Claim 留在各自治理路径。

# Changelog

> Note on numbering: this source candidate is **0.12.45**, based on the 0.12.44
> release. Earlier `v0.12.34`–`v0.12.43` headings name **incremental work on the previous revision**,
> not releases. Each is a self-contained change set with its own 100%-coverage
> test script; the version bump happens only when the work is released.

## v0.12.44（本次发布）

- 完成 Codebase 多语言静态分析与增量索引改造，扩展 TypeScript、Python、Java 解析和查询，并加入 LSP worker、控制流与数据流事实；索引仍报告预算和语言覆盖边界。
- Experience 增加项目级场景分类、评测和自动学习 Worker；学习结果继续经过来源验证、独立评测与既有晋级 Gate。
- 收紧独立 MCP 日常工具面与预算，Procedure 图编辑等高级操作保留在显式高级面；统一发布版本、Marketplace 清单和插件 bundle。

## v0.12.42（本次发布）

- 修复 Context 的错误分类、失败阶段和预算字段回执；区分解析状态与 pack 投影状态，必需 Codebase 引用缺失时明确失败。
- Codebase 保留本次引用投影完整度与索引分析置信度的区别；小仓库不会仅因 basic analyzer 被误标为解析失败。
- Knowledge 注册来源摄取后自动运行现有审核门槛；相同范围、相同文本只在两份独立可信来源支持时自动晋升，旧的待重验记录不会被此路径复活。
- 增加 `craft_learning_cycle_finalize`，供无 Hook 的 MCP/Skill Host 提交带 Context receipt 的已验证终态；重复提交幂等，产出 Observation/候选请求，不绕过 Experience 的独立评测和晋级 Gate。
- Memory 继续只接受显式用户授权；自动晋升策略和撤销、冲突、过期规则不变。

## v0.12.40（本次发布）

- 修复全局 Context 召回对 `global:global` scope 的兼容，保持显式范围授权。
- Experience 增加嵌入式 Host 准备、快照、Session 和 Observation 接口，复用现有 Runtime；不在 Craft 内执行命令或启动子 Host。
- Graph 决策支持声明式条件、已验收事实摘要绑定、人工确认与受限返工；缺失、歧义或过期证据阻止推进。Host 上报不自动成为独立验收或晋级资格。
- 具体产研流程作为本地 Experience 数据保存，不随公共插件发布。

## v0.12.39（历史发布）

- `craft-context` 的 Codex/Claude 插件增加单入口生命周期 Hook：提示阶段一次解析 Knowledge、Memory、Experience 的共享限额回执；显式记忆写入失败不阻断其余召回；Experience 继续只记录脱敏的本地编辑与验证信号。
- 单独安装 Context 即可保留四个子能力的 MCP 工具；独立插件仍可按需安装，Skill + MCP 的无 Hook 路径保持可用。

## v0.12.38（历史发布）

- 发布默认聚合的 `craft-context` 与 Knowledge、Memory、Experience、Codebase 四个独立组件，均提供 Codex、Claude、独立 Skill + MCP 和 DSH 接入；进入 Git 仓库自动建立或复用基础索引，Hook 保持可选。
- 收紧 Knowledge 历史和当前读取权限、Qualification/Verification 身份绑定及检索无答案评测；Procedure 孤儿版本可在受控重试时恢复。
- 将公共协议、本地 Store、无内容观测 SDK 与四能力打包为独立包；分发仓同步插件 bundle、Skill、版本和来源摘要。本地测试不构成真实 Host、IdP 或生产收益证明。

## v0.12.37（历史发布）

- Engineering Quality Profile 仅接纳 Task/Activation/Host 环境、模型与预算指纹都固定的 `VerifiedEvaluationReceipt`；旧的直接记录一律 `revalidation_required`，不能用于 routeable 晋级。
- Experience Procedure 自动化不再在 Craft 进程内执行命令或自判 accepted，只能产生受限 `awaiting_host_dispatch` 请求，并由外部 Host 回执、独立 Observation 与既有 Acceptance 收口。
- 对外分发契约固定为 `craft-knowledge`、`craft-memory`、`craft-experience`；Marketplace 和 common-use 的同步/校验均绑定版本、来源和摘要，安装事务先预检并可回滚。

## v0.12.36（历史发布）

- Git-first canonical Project Identity 与本机 path/旧 scope alias，避免跨机器串台；Context Receipt 记录 scope 栈、遮蔽与排除理由。
- 真实 Keyword/BM25 检索与可选 OpenAI-compatible embedding 适配器；未配置或未评测的向量检索明确回退并记录 unavailable。
- Knowledge Source 引入不可变 revision、fragment、Evidence 与 candidate ingest；来源漂移使旧 Claim 显式 stale，不静默复用。
- Memory 引入 observed/effective 时间、topic 冲突弃权和自动 Light maintenance；Experience Graph 只接受确有执行形态证据的候选。

## v0.12.35（历史发布）

- 收口 P0-P2 控制面：新增 Runtime Execution Attempt、Context Working Set、Workbench Command、Capability Intake 和 Graph Compiler；Graph 只生成交给 `VerifiedWorkLoop` 的 Plan。
- 运行 Attempt 绑定 Task/Run/Host/Environment/Effect/Receipt/Observation，并将 `effect_unknown` 固定为需人工或受控 reconcile、禁止自动重放；上下文回执只保存引用、预算与选择原因。
- 新增能力来源扫描、Conformance、审批、撤销和升级计划；扩展 MCP、CONTEXT、技术模块文档与 ADR，并为新模块建立 100% 行/函数/分支门禁。
- 将 `craft_component_readiness_get` 明确限定为内容无关的可达性预检：返回值标记为 `readiness_only`，不会冒充 Knowledge 检索、Memory 读取、Experience 观察或 Context Resolution。
- 独立 Knowledge、Memory、Experience MCP 面只接受自身组件的 readiness/diagnose 请求；错挂载调用会失败并指向正确的组件入口。
- 同步组件插件、适配器和 Marketplace 版本元数据至 `0.12.35`。

## v0.12.34

- 统一 `Agent / Harness / Environment / Context / State` 契约，并将 `Goal → Target → Plan → Step → Accept → Outcome` 接入 VerifiedWorkLoop。
- 新增单点能力 `EvaluationContract`，阶段从机制证据单调推进到 `routeable`，不会因单次调用或握手自动放行。
- 统一发布版本元数据、组件依赖、插件 manifest、MCP serverInfo 与 Marketplace 校验；Schema 与 Protocol 版本独立保留。
- `craft-knowledge`、`craft-memory`、`craft-experience` 的 Codex Hook Bridge 现可独立工作：仅注入各自范围内的 Context；Memory 只接受 `记住：…` 或 `/remember: …`；Experience 仅从“本地修改 + 可观察验证”生成脱敏 Observation 和候选请求，绝不记录聊天正文或自动发布 Workflow。

## v0.12.43 (continued) - origin/main merged: 0.12.32's work re-expressed on the split kernels

`origin/main` was ten commits ahead with the 0.12.32 feature set (Markdown content store,
Memory Governance, Workflow DAG, Task State, MCP Tasks, Runtime Proof, Trace Review, Memory
Maintenance, legacy knowledge migration). This branch had meanwhile split the same modules
along capability boundaries, so the merge had to answer, feature by feature, which of the two
structures each one belongs to.

**Ported onto the split kernels.** `payload` no longer returns a body that lives behind a
`content_ref`. `MemoryLedgerKernel.remember` writes the body to the content store, keeps the
reference and the digest, and gives a working note 24 hours and an episode 30 days by default.
`ContextResolutionKernel.resolve` reads bodies through that same reference, and reports a scope
it could not obtain as `skipped: true, reason: "scope_unavailable"` instead of searching every
scope. `MemoryGovernanceKernel` takes the Ledger half it actually calls (`remember`,
`transition`) rather than the single object this branch split up. `validation.ts` gained the
shared `fallback`, `optionalText` and `optionalScope` helpers and the `session` scope kind,
because three modules carried private copies of them.

**Deliberate losses, recorded rather than hidden.** The remote's cosmetic `x ?? d` ->
`fallback(x, d)` rewrites inside the eight modules this branch split out of `v01211-runtime.ts`
were not carried over: the shared helper exists, the spellings are behaviour-identical, and
re-applying them would have rewritten files for no reader. `defaultSettings().theme` stays
`"system"`, harmonised with `normalizeSettings`, instead of being reverted to the remote's
`"light"`: the two describe the same first launch and must agree, and this branch had already
changed the factory rather than the test.

**Found while merging.** Both sides added `tests/runtime-proof.test.ts`; the collision cost the
remote's RuntimeProofKernel tests, now restored as `tests/runtime-proof-kernel.test.ts` and
`src/runtime-proof.ts` back at 100%. `.gitignore`'s `coverage/` pattern matched
`scripts/coverage/` at any depth, so the coverage gate scripts themselves were never committed
and a fresh clone could not run its own gate; the directory is now un-ignored explicitly. Two
shared helpers that `git` merged textually had to be reconciled by hand because the two sides
disagreed about meaning: the theme default above, and `runtime-acceptance`'s evaluation identity,
which included the plan version that `evaluate` itself bumps, so the remote's idempotency test
and this branch's kernel could not both be right.

**Verification.** `pnpm run typecheck`, `pnpm run lint`, the four audits and all **39** per-module
coverage gates pass, and **1038** tests pass. The single combined coverage run
(`scripts/ci/test.ts`) still reports a residue below its 100/100/100 thresholds
(99.93 line / 99.65 branch / 99.40 function over 23 files). That gate was already failing before
this merge on 53 files at 97.03% branch coverage, so the merge improves it rather than causing
it; the residue is dominated by class-field lines that V8 attributes as uncovered only in a
combined run -- the effect `tests/coverage-gates.json` documents -- plus a few delegates the
remote added that only its per-version scripts exercised.

## v0.12.43 (continued) — the four open questions, decided and landed

`context-members.md` ended with four things it deliberately would not decide. All four are now
decided, implemented, and tested.

### Three compaction mechanisms became one

`compactConversation`, `ReversibleContext.project` and `compactionPlan` each answered "what fits in
the budget" independently. They disagreed where it mattered: two ranked by weight but broke ties in
**opposite** directions, and only one protected anything — so a caller's result depended on which
function it happened to call rather than on a policy anyone chose.

`src/compaction.ts` is now the one implementation, with two stages whose fill rules deliberately
differ: a **contiguous recent suffix** stops at the first segment that does not fit, because
contiguity is what makes the elided span describable as one run; then the remainder **competes by
weight, skipping** what does not fit, because that is what packs a budget. One tie-break for the
whole system: weight descending, then the more recent segment. Protection stays **subtraction** —
removed from the budget and from the omitted set, its cost reported separately — because giving a
constraint a large weight still loses to a tighter budget, which is the failure the governance
research measures.

Two dead branches were found and removed while covering this: an id tie-break and a position
fallback, both unreachable because segment ids are unique. An unreachable branch reads as a rule
that exists.

### `restore` became durable, because the tool had promised something it could not do

`craft_context_project` said *"omitted segments are named and can be restored"*, and
`craft_context_restore` then demanded the **original segments again** — the one thing a caller that
omitted them no longer has. Measured before: `restore({segment_id})` threw
`Context segment s2 does not exist` and `context_segment` held nothing.

`src/context-projection.ts` stores a session's segments under `context_session` and a
**content-free** projection under `context_projection`, so a later call needs only
`session_id` + `segment_id`. The two paths are distinguishable rather than silently different: no
session means the old stateless answer plus `restored_from: "arguments"`. The segments are one
versioned record per session rather than one per segment, and that is a consequence worth stating —
the store has no `delete`, so per-segment rows would accumulate and stale ones could only be hidden.

Writing the tests found two real logic errors in it: `already_present` was derived from what would fit
at the **new** budget rather than from the session's stored projection, and the existence check came
after that derivation, so a segment the session did not hold at all looked present and the restore
returned a projection without it — silently, which is the one thing a restore must never do.

### `state` has one read-only view

`StateViewKernel` reads the contract, run, run state, launch, delivery loop, manifest and workspace
snapshot, and reports **one** status and **one** safe next action. Its whole content is the
precedence: a stopped run outranks a loop that still has work queued; `needs_replan` outranks
everything downstream of it; a pending approval outranks the loop's action, because reporting
`deliver` instead would invite the caller to skip a human decision. It has no write method and the
status is derived, so it cannot become a second source of truth, and `sources` names the records it
actually read so a reader sees the basis rather than the conclusion.

It also had a bug the tests caught: `store.list` is ordered **newest first**, and the kernel took
`.at(-1)` — the *oldest* contract and run. For a re-planned task that is the wrong answer, and it
looked plausible because a task with one contract has only one record to find.

### The transcript stays out of the capability system

`CONTEXT_MEMBER_SOURCES.history` is unchanged. `contributes` exists for a Host that keeps its own
prompt and asks Craft for material; when Craft *is* the Host it builds the request directly and needs
no such round trip. Making the transcript a capability would add indirection for the one caller that
does not need it, and would replace a checkable fact — the conversation is not in Craft's database —
with a policy.

Recorded as ADR 0012 and 0013; the ADR index now lists 13.

### Verification

`tsc --noEmit`, `lint` (623 files), `audit-layering`, `audit-surfaces` (834 tools), `audit:docs`
(391 links, 13 decision records), `check-version`, `check-consistency-falsifiable` (9/9) — clean.
Three new coverage groups (`compaction`, `context-projection`, `state-view`) at
**100.00 / 100.00 / 100.00**. Full suite: **919 tests, 913 pass, 6 fail** — the same six documented
sandbox `spawn EPERM` cases.
## v0.12.43 (continued) — the hook reaches the flow, and experience gets a read side that cannot leak

### `runPhase` had eighteen tests and no caller

That is the same defect as a provider nothing invokes, and it meant "a hook can stop a tool call"
was a claim nothing exercised end to end. The phase is now entered from **MCP `tools/call`**, in a
new `src/hook-plane.ts`:

| the protocol owed | what landed |
|---|---|
| capability attribution | `buildCapabilityRegistry` stamps `owned` onto every hook — **the registry is the only writer**, so a capability cannot appear in another's numbers — and `PhaseResult.outcomes` carries `capability` beside `hook` |
| honest context | `HookContext.scope_kind` / `scope_id` are **optional**; a tool call at the MCP boundary may belong to no task, and inventing a scope would put an unobserved fact into an instrumentation record |
| observability | `HookPlane.records` appends one **content-free** record per phase: the phase, how many hooks ran, whether any refused, which capabilities they were. No tool name, no arguments, no result |

`tool_before` is a gating phase, so a refusal **returns without dispatching** and `tool_after` does
not run either — hooks that decide about an effect that is no longer going to happen would be
deciding about nothing. The tests go through `McpServer.handle`, so a refusal travels the whole way
before it counts.

`input_digest` is a digest of the tool name and its arguments — content-free by construction, the
same discipline `prompt_digest` and `request_digest` already follow. `capability.name` comes from a
new `ownerOfTool(tool)`, which is what turns the `owns` declarations into something the flow
actually uses rather than a second list that could disagree with them. When no capability owns a
tool the field is **omitted, not defaulted**: `{name: "unowned"}` would be a fabricated attribution.

### `contributes` had to become a factory, and that is a protocol gap it exposed

A contribution needs the kernels `register` just built, and which kernel that is only the registry
knows — so a static provider could not hold a store that does not exist until assembly. A capability
with a genuine read side had no way to declare one. `contributes` is now
`(registry) => ContextContributionProvider`, called after every `register` in capability order. No
capability had a contribution when this changed, so making it a factory cost nothing.

### The experience read side, which may only hand over pointers

`craft-experience` is the **only** one of the three members with a contribution, and it is the
opposite of the other two. Knowledge and memory read back through `ContextResolutionKernel.resolve`
in the core; experience cannot, because `compile` stores only
`hypothesis_digest` / `applicability_digest` / `counterexample_digest` with `content_free: true`, and
every record is `execution_visible: false` — *"execution Hosts never receive it directly."*

So the prose a Host must not receive **does not exist in Craft to leak.** What the contribution
carries is a reference and its provenance: which pattern, at which version, of which kind, backed by
how many independent observations and how much Evidence, whether the ledger marks it
execution-visible, and whether anything for it has reached Signoff
(`requires_governed_route: true`). That is what a routing policy needs in order to decide to consult
the ledger through a governed path.

The failure mode this file could have is growing a field, so the test asserts the absence: no item
may carry `hypothesis`, `applicability` or `counterexample`, and the record itself is checked to
have no such key. Matching is on `scenario_key`, and the request's scope is deliberately unused — a
pattern has no scope, and filtering by one would look like it narrowed the result when nothing could
satisfy it.

### `resolve` is async now, and that is a real behaviour change

Contributions are asynchronous, so `ContextResolutionKernel.resolve` is too. The consequence worth
naming: a validation failure (a query containing a credential, an invalid budget) is now a
**rejection** rather than a synchronous throw. Identical through MCP, where the handler catches
both, but different for a direct caller — every `assert.throws` in the affected tests became
`assert.rejects`.

The receipt keeps only a content-free summary of what the contributions selected
(`member`, `receipt_id`, `item_count`, `omitted_count`), while the result carries the material. A
receipt holding the items would be storing retrieved content. The summary is part of the receipt's
identity, so replaying a resolution against changed compiled experience is a conflict rather than a
silent second receipt describing a different pack.

### Verification

`tsc --noEmit`, `lint` (615 files), `audit-layering`, `audit-surfaces`, `audit:docs`,
`check-version`, `check-consistency-falsifiable` (9/9) — clean. New coverage groups and tests:
`hook-plane.ts` and `capability-protocol.ts` at **100.00 / 100.00 / 100.00** together with
`capability-catalog.ts`; `experience/contribution.ts` and `context-resolution.ts` at the same. Two
groups were extended (`evaluation-model-workflow-evolution`, `universal-runtime`) and both re-run
directly, since `scripts/coverage/coverage-gates.ts` cannot spawn in this session. Full suite:
**902 tests, 896 pass, 6 fail** — the same six documented sandbox `spawn EPERM` cases.

### One self-inflicted error, again

`Regex.Replace(text, pattern, replacement, 1)` reads its fourth argument as `RegexOptions`, not as a
count — so the import insertion hit **every** import line, twenty-two duplicates in `mcp-server.ts`.
This is the second time in this session, and the first time was documented in this same changelog.
The lesson belongs in the practice rather than in another paragraph: a multi-file text transform
gets a line-based implementation or a dry run, never a four-argument `Regex.Replace`.
## v0.12.43 (continued) — Experience becomes a package, and the core stops constructing it

### The capability had a contract and no instance

`capability-protocol.ts` declared what a capability *is* — a name, an ownership pattern, a
`register` hook, an optional context contribution, hooks on the flow — and nothing
implemented it. The core still did this, in `service-foundation.ts`:

```ts
this.experienceLedger = new ExperienceLedgerKernel(store);
this.evaluationModelProfiles = new EvaluationModelProfileKernel(store, this.modelProviders);
this.workflowEvolution = new WorkflowEvolutionKernel(store);
```

Three `new` calls naming three classes through three direct imports. A capability could not
be added, omitted, or replaced: deleting a line would have left an `undefined` property to be
discovered at call time, which is not the same thing as being unable to omit it.

`capability/craft-experience/` is now a package:

| file | role |
|---|---|
| `package.json` | `@craft/capability-experience`, version `0.12.33`, `exports` for the descriptor and each kernel |
| `tsconfig.json` | compiles against the repository config with `rootDir` at the repository |
| `ownership.ts` | `EXPERIENCE_FAMILIES`, `EXPERIENCE_OWNS`, `EXPERIENCE_COMPONENT` — imports nothing |
| `capability.ts` | the `CraftCapability`: name, product, `owns`, `register` |
| `experience-ledger.ts`, `workflow-evolution.ts`, `evaluation-model-profile.ts` | the kernels, moved here from `src/` |

The core now states the capability set once, in `src/capability-catalog.ts`, and resolves what
the capabilities built:

```ts
const capabilities = buildCapabilityRegistry(CRAFT_CAPABILITIES, {
  [CORE_KERNELS.store]: store,
  [CORE_KERNELS.modelProviders]: this.modelProviders,
});
this.experienceLedger = capabilities.registry.require<ExperienceLedgerKernel>(EXPERIENCE_KERNELS.ledger);
```

### `core` is a registry parameter because a capability must not own its environment

A capability has to *require* the store and the model catalogue, and cannot *provide* them:
both are decided before the capability set is known. `buildCapabilityRegistry` therefore takes
the core's kernels and registers them first. Two things follow, and both are tested rather
than asserted:

- **A removed capability reports the kernel it owed.** `buildCapabilityRegistry([])` then
  `require(EXPERIENCE_KERNELS.ledger)` throws `kernel is not registered: experience.ledger`,
  naming the capability. This is the property the contract existed for.
- **A capability cannot displace the environment.** A capability that provides
  `core.store` collides with the core's own entry and fails assembly with
  `kernel already registered: core.store`, rather than winning by registering last.

### The moved kernels brought their layer with them

`audit-layering.ts` walked `src/` only. Moving a kernel to `capability/` would have removed it
from the audit — the exact "moving the file silences the rule" failure that script was
rewritten to close. The walk now covers `capability/` too, at a declared rank of 1: a
capability owns kernels, so it may use infrastructure and domain kernels and may **not** reach
into `application/` or `interfaces/`. A capability that could import the facade that discovers
it would make the dependency run both ways, and neither side could then be replaced alone.

Falsified before being trusted: a probe file at `capability/_probe-upward.ts` importing
`src/interfaces/mcp-server.ts` produced `capability/_probe-upward.ts -> src/interfaces/mcp-server.ts`
and exit 1; removing it returned the audit to clean.

### The Experience product could not reach its own ledger

`COMPONENT_SURFACES["component-experience"]` was the literal

```
/^craft_(workflow_evolution|evaluation_model|experience_mine|experience_candidate|experience_shadow|route_workflow_proposal|workflow_(?:save|get|search|transition|rollback))/
```

which does not match `craft_experience_ledger_observe`, `_compile`, `_propose`, `_evaluate`,
`_decide` or `_get` — the ledger is *the* write side of experience, and it was unreachable
through the product named after it. Nothing reported this because the surface list and the
implementation had no relationship anything could check.

The projection is now derived from the capability's declared families, in the same
`ownership.ts` that declares them, and it adds back the separate kernels the same product
serves (`craft_experience_pattern_*`, `_mine`, `_candidate_list`, `_shadow_experiment_*`,
`_capture_*`). Ownership stays narrow — this capability does not implement those families and
does not claim them, because a declaration that cannot be wrong is not a declaration.

`component-context`, `component-knowledge` and `component-memory` had each restated
`context_resolution|retrieval_adapter` verbatim; they now compose it from one source, so
adding a shared verb is a one-line change instead of a three-line one.

## v0.12.43 (continued) — the class that served two members, cut into three modules and a third package

### Why craft-memory could not be declared

`knowledge-memory-runtime.ts` was one class serving **two context members' writes** and one read
side at once:

| the class held | which member |
|---|---|
| `installBuiltins`, `sourceRegister`, `sourceList`, `sourceTransition` | knowledge |
| `remember`, `transition`, `compatBind`, `get` | memory |
| `retrievalConfigure`, `retrievalEvaluate`, `resolve`, `receiptGet` | all three, on read |

A class serving two members belongs to neither package, so `craft-knowledge` could not claim
`craft_knowledge_source_*` and `craft-memory` had nothing to register. Cut along the **member
boundary** — not by size — into three modules:

|…18203 tokens truncated…, and an outage does not
become a capability finding. This is a deliberate demonstration of rule 2 rather
than a gap.

### What the suite found by being run

Writing it against real contracts surfaced four places where my assumptions were
wrong, each caught by execution rather than reading:

- `neighbors` **resolves the far endpoint record and silently drops an edge whose
  record is missing**, so a relation between bare ids is invisible. The cases now
  create real claims.
- `knowledgeClaimSave` requires at least one real Evidence record — an empty
  `evidence_ids` array is rejected.
- Workflow steps use `type` (values `command`, `assertion`, `coverage_gate`), not
  `kind`, and `command` spawns a process the sandbox denies, so the cases use
  `assertion`, whose evaluators read the filesystem directly.
- `retract` defaults `valid_to` to now, leaving no queryable window, so the
  closed-interval case states an explicit window and queries inside and outside it.

Two of these were bugs **in my own eval code**, not in Craft, which is the
expected cost of testing something against its real interface.

### One flaw removed before shipping

The governance axis first had a control case asserting that the *unpinned* model
complies. That would have counted a governance failure as a pass and let
misbehaviour raise the score. It was removed: a control belongs in a decay
measurement that compares two conditions, not in a pass/fail suite.

### Script

`scripts/eval-suite-run.ts` drives the suite against the live endpoint and
prints the per-axis and per-case breakdown. It reports
`comparable_to_published_benchmarks: false` and states the denominator next to
every rate. This measures one model on one endpoint in one environment; it is not
an industry conclusion and is not comparable to the multi-model published
benchmarks cited in the research notes.

## v0.12.42 — evaluation suite kernel

`defineEvalCase`, `defineEvalSuite`, `gradeCase`, `summarizeSuiteRun`, plus the
case catalogue in `eval-cases.ts` and the runner in
`scripts/eval-suite-run.ts`. See v0.12.43 above for the results and the contract
it reuses. 7 tests at 100% line, branch and function coverage across both files.

## v0.12.41 — MCP 2026-07-28 forward compatibility

### What this is, precisely

The 2026-07-28 revision is not a version bump. The official changelog lists nine
major changes: it removes the `initialize` handshake, makes the protocol stateless
with per-request `_meta`, mandates `server/discover`, requires `resultType` on
every result, removes `ping`, `logging/setLevel`, `resources/subscribe` and SSE
resumability, moves Tasks into an extension, and replaces server-initiated
requests with Multi Round-Trip Requests. Craft cannot adopt that opaquely: its
human approval flow and durable long-task model sit exactly where MRTR and the
Tasks extension now live.

So this change does **not** claim compliance. It implements the two changes that
are safe while still speaking 2025-11-25, and records the rest as deliberate,
checkable debt.

### Implemented (both strictly additive)

- **`server/discover`** — mandated with MUST by the new revision, and harmless on
  every earlier one, so a newer client gets an honest answer instead of
  `Method not found`. `discoverResult` reports the revisions actually spoken, and
  separately the assessed revision and migration state, so a client cannot infer
  support from the fact that this build knows the revision exists.
- **`_meta` tolerance** — a peer sending 2026-07-28 per-request keys is served
  rather than rejected, and unknown `io.modelcontextprotocol/*` keys are reported
  rather than silently discarded. Keys outside that namespace are not treated as
  protocol drift.

### Deliberately not done

`initialize` removal, `_meta` statelessness, MRTR, and the Tasks extension
mapping. Each is recorded with its reason in `MCP_REVISION_REQUIREMENTS`, and
`forwardCompatibility()` returns `compliant_with_target: false` with the remaining
list. The point of the honesty is that `assessMcpMigration` already blocks on
`host_supports_mrtr` and tasks-extension mapping — this makes the same judgement
machine-readable instead of leaving it in prose.

Two smaller decisions, both recorded rather than left implicit:

- **`ping` is retained.** It belongs to every revision this build speaks, and
  2026-07-28 removed it only for the revision this build does *not* speak.
  `pingPolicy` makes retention conditional with a stated removal condition, so a
  future migration cannot rediscover the question by accident.
- **`resultType` is NOT emitted.** The revision requires it, but this build speaks
  2025-11-25 and the spec says a client MUST read an absent field as `"complete"`.
  Emitting it now would be exactly the premature declaration this project keeps
  catching. `outboundResult` documents the omission and the correct reading.

### Guarded by G8

Three declarations were added to `mcpDeclarations()` — `server/discover` is
implemented, no `resultType` is emitted, and the build is not claiming
compliance — so the readiness report cannot drift into a compliance claim. The
falsifiability check was extended to **9/9 mutations caught**, including "the build
starts claiming compliance".

7 tests at 100% line, branch and function coverage.

## v0.12.40 — governance pinning (G2)

### The gap

`ReversibleContext.project()` selects segments purely by weight, so a governance
constraint competes for the token budget against the active task state — and a
constraint is old, off-topic, and low-salience next to the current sub-goal. That
is the mechanism the Governance Decay work measures: compaction raises the
violation rate from 0% to 30% (up to 59%), because compaction is engineered for
task continuity and treats standing policy as evictable content.

Craft is exposed on exactly the channels that work finds vulnerable. Its threat
model explicitly excludes the system message — frameworks that preserve it
"simply protect one channel while leaving memory and conversation-carried
governance exposed" — and `agent-loop.ts` has no system channel at all, so
governance necessarily arrives through memory, tool output, or a user turn: the
three channels measured at +45, +33 and +50 points of decay, against +0 for a
preserved system message.

### The fix is structural, not a better summary

`compactionPlan` takes constraints **out of the eviction competition entirely**.
The pinned block is carved off first, the remaining segments are projected as
before, and the pinned text is re-injected on top, so the result is bounded by
`maxTokens + pinTokens` and cannot drop a rule at any budget. A test drives the
budget down to one token and the constraint still survives, because it never
enters the loop that decides eviction.

Design rule inherited from `agent-loop.ts`: a guard must be an explicit ceiling
owned by Craft, never a prompt instruction the model could reinterpret.

### Integrity is checked by content, not presence

`verifyPinIntact` distinguishes `dropped` from `reworded`: a constraint whose id
is still quoted but whose statement has changed is not the rule that was pinned.
A naive id check would pass it, and the digest would then be lying.

### Refusing to protect an undeclared rule

A segment that *looks* like a constraint but was never declared stays evictable,
and a declared constraint with no matching segment is reported as
`unbound_constraints` rather than quietly treated as satisfied. Auto-pinning
either one would protect a policy nobody declared.

### Tiering

`craft_governance_pin_get`, `craft_governance_pin_check` and
`craft_governance_compaction_evaluate` are `read` and mounted, so the loop can
verify its own guardrail. `craft_governance_constraint_define` is deliberately
`governed` and **not** mounted: a guard the loop can redefine is not a guard. The
tests assert the tier rather than trusting the name.

9 tests at 100% line, branch and function coverage.

## v0.12.39（历史增量工作）

Declaration/implementation consistency (G8).

Every defect the v0.12.38 live run found had one shape: a claim disagreed with the
code, and nothing compared them. `MCP_ASSESSED_REVISION` recorded that this build
had assessed 2026-07-28 while the handler still whitelisted only the three older
revisions and still implemented `ping`, which 2026-07-28 removed.
`buildChatRequest` promised an `authorization` header and emitted template source
text. A test asserted the wrong value and locked it in place.

The lesson is not "be careful" — it is that a claim and its implementation drift
apart silently, because nothing in the build forces them to agree. So the
declarations are now *data* with a named falsifying fact, and the comparison is
mechanical.

### `unverifiable` is not `confirmed`

Each claim resolves to `confirmed`, `contradicted`, or `unverifiable`. A claim
whose expected facts are absent from the observation is `unverifiable` — never
`confirmed`. That distinction is the whole module: the MCP contradiction survived
because an unchecked declaration was read as a true one, and collapsing "I could
not check this" into "this is fine" is exactly how it happened. Only
contradictions make a build inconsistent; honest unknowns are reported at equal
volume but do not fail it.

### The checker had the bug it exists to catch

The first version of `observeMcpFacts` returned the runtime constant as the
handler's advertised set, so `mcp.advertised_versions` compared a value against
itself and **could never fire**. A check that passes because it never looks at the
thing it claims to check is worse than no check, since it manufactures confidence.

`scripts/check-consistency-falsifiable.ts` now mutates each fact in turn and
requires the check to notice: **6/6 mutations caught**, including a handler
advertising the assessed revision, a handler dropping a declared version, and a
mounted tool escaping classification.

### A claim was corrected, not the code

`mcp.no_removed_methods` asserted that the server does not implement methods
2026-07-28 removed. That failed immediately — `ping` is implemented. But `ping` is
*correct* while speaking 2025-11-25, so the declaration was wrong, not the code.
It is now `mcp.removed_methods_acknowledged`: the gap is recorded and deliberate.
This is the difference between a declaration and an aspiration, and the check
drawing that line on itself is the point. The test asserts the corrected claim
*and* that the aspirational version is still caught, so it cannot be softened back.

### Wiring

`craft_consistency_check` and `craft_mcp_declarations_get` are `read` and mounted
on the internal loop, so the agent can check a claim against the implementation
instead of trusting the claim.

### Tests

`tests/declaration-consistency.test.ts` — 8 tests at 100% line, branch and function
coverage, including a self-check that reads the shipping source files rather than
a copy, and every verdict path.

## v0.12.38 (continued) — first run against a live model

A working local endpoint (`http://127.0.0.1:8000/v1`, OpenAI protocol) made it
possible to run Craft's real transport against a real model for the first time.
Two defects surfaced that no amount of reading had caught, and both were the kind
only execution finds.

### A credential header that announced itself

`buildChatRequest` set `authorization` to a template with a doubled dollar sign,
emitting the literal string `Bearer $WORKBUDDY_API_KEY` — the un-interpolated
source text. It was wrong in the worst way: valid-looking, so nothing rejected
it, while the transport happened to rebuild its own headers and masked the
result. Anyone reading the built request would see what appeared to be a
credential that was not one.

Two things kept it alive, and both are instructive:

- **A test asserted the bug.** `model-gateway.test.ts` pinned
  `"Bearer $DEMO_API_KEY"` as the expected value, so the suite protected the
  defect instead of catching it. The assertion now encodes the real contract —
  `env:DEMO_API_KEY`, naming the variable rather than a value — and a new check
  rejects any header matching `Bearer <token>` in either wire format.
- **Nothing compared the header to what the transport sends.** The fix is
  verified against the live endpoint, not just the unit suite.

### Abstraction could never see recurrence across tasks

Running v0.12.37 against real model output exposed a contract hole in the
signature. Checks are naturally named per task — `rev-1:exact`, `rev-2:exact` —
and as raw strings those never match, so a failure repeating across independent
tasks was invisible and the evidence floor could never be met. The grouping was
correct and unreachable at the same time.

`trajectoryFailureSignature` now reduces each name to the check's own identity by
stripping the task-specific prefix, so `rev-1:exact` and `rev-2:exact` both yield
`exact` and group — while `exact_sum` correctly stays separate. Verified live:
three distinct tasks sharing a failure signature now produce one abstraction,
with the unrelated failure reported as a named near-miss.

### What the live runs actually showed

On four deterministic cases the model scored 3/4, failing only
`reverse('craft')` → `tfarC` (a case-folding slip). On three character-counting
tasks it scored 3/3.

The important result is the negative one. `abstractAcrossTrajectories` returned
**zero abstractions** with `sufficient_evidence: false` for those runs, and that
is the mechanism working: one isolated failure, on one task, is not a pattern,
and inventing one would have been the failure mode the evidence floor exists to
prevent. A learning system that reports "nothing to learn" when nothing recurred
is behaving correctly; a scoreboard that only counts lessons produced would have
hidden this.

The full chain ran end to end on live output: v0.12.36 observed the failure from
bytes, v0.12.38 attributed it to `synthesis_gap` (evidence complete, answer still
wrong), and v0.12.34 captured it as a `correction` with `requires_review`.

Scripts: `scripts/eval-run.ts`, `eval-recurrence.ts`, `eval-abstraction.ts`.

## v0.12.38

Failure attribution (G3).

v0.12.36 gave the harness a way to observe that it had failed. It could not say
*why*. Every failure was a single undifferentiated fact, so a lesson drawn from
one could not be checked against the cause it claimed — and a lesson with an
unverified cause is indistinguishable from a superstition.

The taxonomy is taken from the Eywa memory report (2026), whose central argument
is that a single end-to-end score cannot tell which layer failed: a wrong answer
may come from missing evidence, unsupported extraction, stale state, retrieval
loss, or the answer model itself. Each needs a different fix.

### Derived from observations, never asserted

`attributeFailure` accepts eight observed signals and returns one of: coverage,
grounding, revision, scope, temporal, retrieval, synthesis, or `unattributed`.

The rule that shapes the module: **a guessed cause is worse than an admitted
gap.** A wrong cause produces a confident, useless, and permanently repeated
lesson, so the function names a cause only when the observations support it and
otherwise says `unattributed`. Two distinctions carry that:

- **`null` is not `false`.** `null` means "not observed"; `false` means "observed,
  and it was not the case". An unobserved signal can never justify a conclusion,
  and `wrong_scope_applied: false` is evidence rather than silence.
- **Diagnostic priority follows the pipeline, not severity.** A fact absent from
  the source cannot also have been mis-scoped, so `coverage_gap` is checked
  first. Naming the downstream cause would send the fix to the wrong layer, which
  defeats the entire purpose of having a taxonomy.

Revision is checked before retrieval on purpose: recalling the right fact and
then ignoring that it had been superseded is a revision failure, not a search
failure. Likewise `answer_in_context: false` is classed as retrieval rather than
grounding — the fact was found and then dropped between retrieval and context, so
the fix is the budget or the eviction order, not extraction.

### Where the system is weakest

`summarizeAttributions` answers the different question of what to fix first. It
ranks classes by count, reports `unattributed_count` rather than hiding it (a
falling attribution rate means observability is degrading, which is itself a
finding), and sets `primary` to the top **named** class — `unattributed` is never
a fix target, so an all-unattributed run reports `primary: null` instead of
pointing at ignorance.

### Wiring

`craft_failure_attribution_get` and `craft_failure_attribution_summary_get` are
`read`, mounted on the internal loop, and dispatched through the real service, so
the loop can diagnose its own failures. The name matters: a bare `_attribute`
suffix matches no verb in the classifier and silently falls through to
`governed`, which would leave the loop unable to reach its own diagnostic — the
tests assert the tier rather than trusting the name.

The full chain is now closed end to end: v0.12.36 observes the failure, v0.12.38
names its cause, and v0.12.37 generalises it across independent trajectories.

### Tests

`tests/failure-attribution.test.ts` — 9 tests at 100% line, branch and function
coverage, including every class, every priority ordering, the `null` versus
`false` distinction, and an end-to-end MCP run.

## v0.12.37

Cross-trajectory abstraction (G1).

Two independent sources pointed at the same missing capability. The ACL 2026
survey *From Storage to Experience* formalises agent memory as three stages —
Storage, Reflection, Experience — and names cross-trajectory abstraction as the
frontier mechanism. Mem0's 2026 memory report independently lists "temporal
abstraction at scale" among its three hardest open problems. Craft had Storage
and Reflection, and none of Experience.

### The gap, precisely

`decideExperienceCapture` scored one run's outcome, retries and corrections, and
`buildExperienceRecord` produced one record per run. Nothing ever looked *across*
runs. So Craft could record that a run went badly, but never that twelve runs
went badly the *same* way. A per-run lesson only helps the run that produced it;
the entire value of memory is that the thirteenth attempt starts smarter than the
first.

### Deserving to generalise

The hard part is not clustering, it is earning the right to generalise. An
over-eager abstraction is indistinguishable from a confident hallucination, and
it would poison every future run that trusts it. Three rules enforce restraint:

- **Recurrence must be independent.** A signature is refused unless it appears in
  two or more distinct traces spanning **two or more distinct tasks**. The same
  task retried twice inside one trace is one story told twice, not a pattern —
  and treating it as one is exactly how a broken loop convinces itself it has
  learned something. Replayed trace ids are rejected outright, since that is the
  one way to fake recurrence.
- **Generalisation happens over a deterministic signature, never over prose.**
  The signature is the sorted set of failed check names, so two runs group only
  when they failed the *same* checks by a rule anyone can re-run. Order
  independence matters: the same failure reported in a different sequence is
  still the same failure.
- **Below the floor, the answer is no abstraction, not a weaker one.** Refusals
  are returned with their reason and counts, so abstention is checkable rather
  than trust-based. `sufficient_evidence` is reported explicitly so silence is
  never mistaken for "nothing recurred" when it actually meant "nothing was
  examined".

### What an abstraction is

A candidate, never a published lesson. `buildAbstraction` always sets
`requires_review: true` and `execution_authority: false` — generalising is a
claim about the future drawn from the past, and Craft's whole posture is that
such a claim is proposed, not asserted. The statement is generated from the
evidence ("`tests` failed across 2 independent trajectories spanning 2 task(s)"),
so it cannot overclaim, and it carries the exact trace ids that justify it. A
signature with no check names produces an explicitly unnamed statement rather
than inventing names it was never given.

### Tiering

`craft_trajectory_signature_get` and `craft_abstraction_evaluate` classify as
`read` and are on the internal loop surface, so the loop can notice recurrence
itself. `craft_abstraction_build` is deliberately `governed` and **not** mounted:
the loop may observe a pattern, but minting an abstraction is a claim about the
future that needs review. The tests assert this asymmetry rather than leaving it
to naming convention.

### Tests

`tests/trajectory-abstraction.test.ts` — 9 tests at 100% line, branch and function
coverage, including the refusal paths (single-task recurrence, insufficient
occurrences, falsified recurrence via replayed trace ids) and an end-to-end MCP
run.

## v0.12.36

The deterministic verification sensor (V1).

An external review of the harness literature (Cycode, LangChain, 2026-09) prompted
a check of a claim Craft had been making implicitly: that its self-evolution loop
learns from failure. It did not. `decideExperienceCapture` weights a failure at 30
points, but the failure itself was always supplied by the caller as `outcome`. The
loop could be *told* it failed; it could never *observe* that it had. So its
`failure` weight was waiting for a signal that never arrived on its own.

### A sensor, not another record

Craft already had verification *records* (evidence, signoffs, held-out
evaluations), and they are strong. What it lacked was a verification *sensor*: a
way for the harness to decide, without a human or a model, whether the work it
just did was correct. That distinction is the whole point of the harness layer —
and it is why a passing test suite matters more than a detailed test report.

### Every check is deterministic, or reports that it is not

`evaluateVerificationCheck` supports five kinds, each decidable from bytes:
`exit_code`, `output_contains`, `output_matches`, `file_digest`, `file_absent`.

There is deliberately no LLM judge and no path where the agent's own claim of
success counts as evidence. Three design decisions follow from that:

- **`blocked` is not `failed`.** A check whose observation is missing never
  counts as a failure. A loop that treats "I could not verify this" as "this
  broke" fills its experience store with lessons drawn from ignorance.
- **`inconclusive` is its own verdict** for the same reason: "we could not tell"
  and "we know it broke" must drive different learning.
- **A broken check is blocked, not failed.** A regular expression that does not
  compile is a defect in the check, not in the work — failing the task for it
  would blame the wrong thing.

Combination is conservative and order-independent: any `failed` fails the plan,
otherwise any `blocked` blocks it, otherwise any `inconclusive`, otherwise it
passes. One real contradiction outweighs any number of passes.

### Closing the loop

`verificationCaptureSignals` is the wiring: it maps a sensor verdict onto the
`outcome` that `decideExperienceCapture` already scores, so a deterministically
observed failure produces a captured lesson with no human and no model input.

- A single failed check clears the capture threshold on its own (30 + 26 = 56
  against a threshold of 25), so the loop cannot miss a real regression.
- `blocked` and `inconclusive` map to `abandoned`, not `failed`, because the
  capture vocabulary is `succeeded|failed|abandoned` and an unverifiable run is
  not a demonstrated mistake. The real verdict survives in `verification_verdict`.

### Wiring, and why the names are what they are

The tool-authorization classifier reads the **last segment** of a tool name, and
treats any `_run` or `_propose` suffix as `governed` — a tier the internal loop
cannot mount. Naming the entry point `craft_verification_run` would therefore have
produced a sensor the loop is forbidden to call, reproducing exactly the wiring
gap this version exists to close. Hence `craft_verification_evaluate` and
`craft_verification_signals_get`, both of which classify as `read` and are
asserted to be in a mounted tier by the tests.

The `read` tier is honest here rather than merely convenient: the sensor is a
pure function over facts the caller already observed. It executes no command,
opens no file, and reaches no network. A test asserts that no observed content
survives into the result — only a digest and a reason code — so a sensor result is
safe to record even when the output it inspected contained a secret.

### The loop can now verify its own work

`verification_evaluate` and `verification_signals_get` are on the internal loop
surface and dispatched through the real service, so the failure signal originates
inside the loop.

### Tests

`tests/verification-sensor.test.ts` — 11 tests at 100% line, branch and function
coverage, including an end-to-end run where a deterministically observed failure
becomes a captured lesson over MCP with no `outcome` supplied by anyone.

Craft did not keep a changelog before v0.12.33. Git tags stopped at `v0.12.10`
while `package.json` reached `0.12.30`, so twenty releases existed only as commit
messages. This file starts at the version where that stopped, and v0.12.33 also
adds the cross-repository version check that makes silent drift fail a build.

## v0.12.35

Wiring the memory substrate into the agent loop.

An external assessment argued that Craft's memory, knowledge and self-evolution
substrate is complete but nothing flows into the running loop. Verification found
that claim **partly right and partly wrong**:

- The claim that `cli.ts` hardcodes `knowledge_refs: []` is **wrong**.
  `resolveStandaloneContext` (cli.ts:245) already calls
  `contextResolutionResolve`, searches knowledge and emits `memory_refs`.
- The claim that knowledge search is "`LIKE` only, no BM25" is **wrong**.
  `knowledge-index.ts:266` uses `LIKE` as a candidate prefilter and reranks with
  the `Bm25Index` added in v0.12.34.
- The claims about the loop surface, memory decay and the two-memory split are
  **right**, and are addressed here.

So the real gap was narrower and more precise than "all wiring is cut": the
memory *read* path was cut.

### The loop could write memories but never read them

- `DEFAULT_INTERNAL_TOOLS` exposed seven read-only tools, none of which touched
  memory; `memory_search` and `memory_propose` did not exist anywhere in the
  repository. An agent could record a lesson and never benefit from it.
- `memory_search` (read tier) and `memory_propose` (candidate tier) are now on
  the loop surface, dispatched through the real service. The read path delegates
  to the governed resolver, so it still produces a content-free receipt with
  per-memory reasons and an explicit omitted count — memory access was added
  without adding a way around the budget or the provenance trail.
- `memory_propose` routes to a turn proposal carrying a memory candidate and
  stops. It cannot create a durable memory; approval remains mandatory.

### Tier classification had to be earned, not special-cased

- The first tool names (`craft_memory_decay_weight`, `craft_memory_propose_policy`,
  `craft_memory_legacy_promote`) classified as `governed`, because the classifier
  reads the **last segment** and those names end in `weight`, `policy` and
  `promote`. Governed tools are outside the loop's mounted tiers, so the tools
  would have been invisible despite existing.
- Rather than weaken the fail-closed classifier, the tools were renamed to end in
  the verbs the existing vocabulary already recognises — `_get`, `_search`,
  `_preview` → read; `_propose`, `_record` → candidate. Classification now falls
  out of the rules that were already there.
- A test asserts every memory tool lands in a mounted tier, so this cannot
  silently regress.

### Memory decay and access weighting

- `memory_ledger` had no decay, weighting or access tracking; `resolve()` scored
  candidates by counting substring hits, so a stale preference competed on equal
  terms with yesterday's correction.
- `memoryDecayWeight` combines exponential half-life recency (90 days), a capped
  access bonus and a source-trust factor. Decay is floored, so "old" never
  becomes "gone" — an exponential underflows to exactly zero after ~26 years,
  which would make an ancient memory indistinguishable from a deleted one.
- A future `confirmed_at` is clamped rather than treated as a bonus, so clock
  skew cannot inflate a memory above every legitimate one.

### Capture policy: review by exception

- Automatic capture required both `memory_capture === "candidate"` and a
  `durable_value` signal, so by default nothing was ever proposed.
- `shouldProposeMemory` adds a `review_by_exception` mode where a correction, a
  retry, a decision or novelty each justify a candidate. The governance is
  unchanged — approval is still mandatory — only the proposal threshold moved, so
  the human moves from approving everything to vetoing what matters.
- `strict` mode reproduces the historical behaviour exactly, so a project that
  wants full manual approval keeps it.

### Two memory systems

- `compatBind` records `mode: "reference_only", migration_performed: false`, so
  the legacy and governed stores stay separate forever and a legacy memory can
  never gain provenance.
- `planLegacyPromotion` produces an approvable promotion candidate instead of
  migrating silently: an episode becomes `experience` (not a fact), raw episodic
  content is marked restricted, and `requires_approval` is always true.
- Writing this surfaced a concrete divergence: `service.memoryRemember` routes to
  the workbench memory whose scopes are `user|workspace|task` and which demands a
  `workspace_id`, while the ledger accepts `user|project|workspace|task`. That is
  recorded rather than papered over.

### A2: the vector path changed the label, not the result

- `resolve()` selected its mode with `adapter?.status === "eligible" ? strategy :
  "keyword"` but scored candidates by substring overlap either way — the vector
  branch only changed the `reason` string.
- `hybridMemoryScores` fuses keyword and vector rankings by reciprocal rank
  (matching `catalog.searchHybrid`), so an eligible adapter actually changes the
  result and neither method has to be trusted alone. The keyword-only path is
  preserved exactly when no adapter is eligible.

### Evidence that memory changed an outcome

- Every existing artifact proves the agent was *governed*; none proved it *got
  better because it remembered*. Without that link, decay would have no signal to
  learn from.
- `memoryUsageEvidence` records that resolved memories were in context for a turn
  that succeeded — and counts only successes, because counting a failure as usage
  would reward memories that were present when things went wrong.

### Tests

- `tests/memory-wiring.test.ts` — 15 tests at 100% line, branch and
  function coverage, plus end-to-end MCP calls.
- `tests/loop-memory-access.test.ts` — 4 behavioural tests asserting the
  loop's mounted surface, tier membership, the authorization projection, and real
  dispatch against a store.

## v0.12.34

The ideal-state gap closure. v0.12.33 carried capabilities to the user; this
release fixes three places where an existing capability was wired to the wrong
*shape*. Nothing here is a new runtime concept — all three were seams.

The gaps were identified by comparing Craft against first-party industry sources
(Anthropic's Managed Agents and Contextual Retrieval posts among them). The
comparison, its limits, and the outstanding gaps are recorded in
`docs/research/ideal-state-vs-industry-2026-09-18.md`. That document states
plainly that the sources are single-vendor and that no independent replication of
the cited numbers was found.

### Reversible context

- `truncateToBudget` is one-way: it returns a shorter string and the discarded
  tail is unrecoverable. Managed Agents names this directly — "irreversible
  decisions to selectively retain or discard context can lead to failures."
- `ReversibleContext` keeps every segment and shrinks only the *projection*.
  Dropped segments are named in `omitted` rather than lost, and `restore()` pulls
  one back. Ties break by recency so a projection is reproducible.
- `restore()` promotes the requested segment above all others. An earlier
  `weight + 1` bump made the outcome depend on the weights of *unrelated*
  segments; this was caught by the accompanying tests, not by review.

### BM25 retrieval

- Craft stores digests, ticket ids and record kinds — exactly the content an
  embedding model handles worst. `catalog.ts` had no BM25 and no IDF, so a query
  containing a common word was dominated by that word.
- `Bm25Index` implements standard BM25 (k1=1.2, b=0.75, +0.5 idf smoothing) with
  an exact-identifier boost, so `TS-999` finds the one record that mentions it.
- `fuseRankings` extracts the reciprocal-rank fusion already used by
  `catalog.searchHybrid` into a reusable, tested function.
- Note: the existing `rerank` is a local scoring function, not a model reranker,
  and `searchHybrid` already performed RRF fusion. Both were initially
  misread during the assessment.

### Deterministic experience capture

- Memory could previously be written only through an explicit tool call, so a
  lesson survived only if the model chose to remember it.
- `decideExperienceCapture` makes capture a deterministic function of observed
  signals with a threshold, producing an auditable candidate carrying its
  reasons and provenance rather than a silent write.
- Calibration corrected: a single correction now clears the default threshold on
  its own — it encodes the failure *and* its fix — and `requires_review` no
  longer gates a user-requested working pattern, which is already vouched for by
  the person who asked.

### Harness/session decoupling

- Whether the harness can be replaced without losing the session was previously
  *claimed*; it is now *demonstrated*.
  `tests/harness-session-decoupling.test.ts` boots three independent store
  instances with no in-memory object shared between them, and shows that a fresh
  harness recovers and continues a session, that a paused session survives a
  close/reopen and is resumable by a different harness, and that replaying the
  log reproduces identical history with the trace as an independent witness.
- `scripts/audit-v01234-layering.mjs` checks the declared layer direction. Only
  seven kernels import upward, all composition roots or compatibility shims.

### Seven surfaces added

`craft_context_project`, `craft_context_restore`, `craft_bm25_search`,
`craft_retrieval_fuse`, `craft_experience_capture_decide` and
`craft_experience_capture_build` are registered on the service facade and reachable
through MCP, with end-to-end tests through the real server rather than direct calls.

### Tests

- `tests/ideal-state-gaps.test.ts` — 20 tests at 100% line, branch and
  function coverage, plus end-to-end MCP calls.
- `tests/harness-session-decoupling.test.ts` — 3 behavioural tests.

## v0.12.33

Version unification, the distribution chain, and the first-run path. The theme is
that the runtime was already capable; what was missing was the last mile between
those capabilities and a user being able to succeed.

### Versioning

- `craft` and `craft-marketplace` now agree on `0.12.33`. Before this release the
  marketplace manifests said `0.12.32`, its README said `0.12.31`, and craft said
  `0.12.30` — three-way drift with nothing to detect it.
- `scripts/check-version.ts` now also verifies the sibling `craft-marketplace`
  checkout (release manifest, plugin manifests, README) when it is present, so the
  drift cannot recur. It validates craft alone when that checkout is absent.
- `release.json` records the exact craft `source_commit` the marketplace was cut
  from, refreshed at bump time rather than left stale.

### Distribution

- `.github/workflows/desktop-release.yml` builds the Windows ZIP on a Windows
  runner and the macOS DMG on a macOS runner, then attaches both to the GitHub
  Release. Previously no workflow built a desktop package and no release carried
  an asset, so a user had no download entry point at all.
- `package.json` `files` narrowed from `dist` to `dist/src` and `dist/plugin`. A
  bare `dist` would have published the 35MB Windows ZIP and the macOS `.app`
  bundle to npm — 1172 desktop artifacts.
- `publish.yml` runs the version check explicitly before publishing.

### First run

- `scripts/windows-launcher.cs` reads `%LOCALAPPDATA%\Craft\credentials.env` and
  injects each pair into the child environment, using the same mechanism that
  already injected `CRAFT_DATA_DIR`. A pasted key now reaches `env[apiKeyEnv]`
  without the user editing a system environment variable.
- `src/distribution-and-first-run.ts` adds credential resolution with an explicit overlay
  order, `readCredentialFile`, and `firstRunReadiness`, which answers "can a user
  run this right now" and names the exact variable that unblocks them.
- Six MCP tools expose this surface: `craft_first_run_readiness`,
  `craft_credential_resolve`, `craft_mcp_protocol_negotiate`,
  `craft_mcp_migration_assess`, `craft_isolation_capability_get`,
  `craft_distribution_plan_get`.

### Protocol

- MCP protocol negotiation is now explicit: a requested version that is not
  supported is recorded as a downgrade with a reason instead of silently falling
  back. The 2026-07-28 revision is tracked as `assessed_deferred`, with
  `assessMcpMigration` naming what blocks adoption (MRTR support, and mapping the
  durable task model to `io.modelcontextprotocol/tasks`).

### Honesty fixes

- `a2a-v1-adapter.ts` no longer writes `verified_transport: true`. The digest was
  the card hashing itself with no trusted key, so the record now states
  `transport_observed: true`, `signature_verified: false`, `signature_scheme: null`
  and `card_trust: "self_asserted"`. The old field claimed a signed-Agent-Card
  guarantee this adapter never provided.
- `isolationCapability` reports Windows as `enforced: false`. The `job_object`
  boundary is declared, not executed, so generated-code writes on Windows still
  require approval; the previous wording implied parity with macOS and Linux.
- README corrected in both directions: it understated a shipped HTTP transport
  (line 92) and disclaimed desktop packages that now exist (line 156).

### Studio approval surface

- Studio now has a **「待我批准」** view, the first persistent place to approve
  work. The runtime's headline guarantee is an approval gate, yet Studio had no
  pending-approval entry point at all — the most visible self-inconsistency
  between the backend and the product surface.
- It consumes the existing `/api/inbox/refresh` and `/api/inbox/decide`, which
  were already a persistent SQLite projection, so this required **no kernel
  change**. Decisions survive a page reload; previously an approval existed only
  for the life of the session.
- The view matches the real `attention_item` contract from `src/attention.ts`
  (`reason` / `action` / `priority` / `audience` / `details`), not an assumed
  shape, and offers only the two decisions the kernel accepts (`acknowledge`,
  `defer`), with a future `deferred_until` for deferral.
- `tests/studio-server.test.ts` asserts the served bundle actually wires the
  view, and that assertion was verified to fail when the nav entry is
  disconnected. Studio's reachable endpoints rise from 19 to 23.

### Tests

- `tests/first-run-readiness.test.ts` covers the new surface at 100% line,
  branch and function coverage, wired into the aggregate `test` chain.
