# Knowledge Source、Memory Ledger 与 Context Resolution

> 状态：三个模块，两个能力包 + 一个核心控制面。v0.12.19 曾把它们收敛为**一个** Module（`knowledge-memory-runtime.ts`）；当前 v0.12.37 沿**上下文成员边界**把它切开，因为一个类同时服务两个成员，导致两个成员都无法成为能力包。本文标题没变，因为它从一开始就是准确的；文件名随实现改名。

```text
知识来源描述符                                   capability/craft-knowledge/knowledge-source-registry.ts
  → Memory Ledger（来源、范围、证据、有效期、状态）  capability/craft-memory/memory-ledger.ts
  → Context Resolution（预算、选择理由、精确版本）   src/context-resolution.ts
  → content-free Receipt
  → Host / Verified Work Loop
```

## 为什么切成这三个，而不是别的切法

切法是**成员边界**，不是代码大小：`KnowledgeSourceRegistry` 是 knowledge 成员的写入侧，`MemoryLedgerKernel` 是 memory 成员的写入侧，而 `ContextResolutionKernel` 是**三个累积成员共用的读取侧**。

最后一条决定了它必须留在核心：`component-knowledge`、`component-memory`、`component-context` 三个产品**都**暴露 `craft_context_resolution_*` 与 `craft_retrieval_adapter_*`。只装一个关注点的宿主仍然要能解析那个关注点持有的材料，所以读取侧不能属于任一成员的包。Memory 由核心 Resolver 直接读取 Ledger，避免同一成员被两个 Provider 重复装载。Knowledge 只投影已 `reviewed`、未过期、且 Source 仍 active/非 untrusted 的 Claim。这样“搜索中看到一个 candidate”与“把它交给执行 Host”是两条刻意不同的路径；Experience 只贡献已路由 Procedure：Workflow/Graph 为摘要校验后的 JSON 定义，Prompt 为 Markdown。Observation、Pattern、Candidate 和未标 scope 的旧记录仍可诊断，但绝不进入 Context。

### Scope 不是一棵树

每条 Knowledge、Memory 或 Procedure 都可携带 `Scope Envelope`：`applicability`（适用于哪里）、`custody`（谁拥有）、`audience`（谁可见）、`purpose`（working note / preference / episode / fact / procedure）、`retention` 和可选 `tenant_id`。它们是正交字段；`project` 不是 `user` 或 `team` 的父节点。

Context 的工作通道为 `task → session → project → explicit team → explicit organization`，个人通道为明确指定的 `user`。团队、组织、用户与 global 都只能由 Host/调用方明确给出，绝不扫描全部记录或根据模型文本推断身份。旧记录没有 Envelope 时保持原精确 scope 的兼容语义；新 Envelope 才可要求 principal/tenant 匹配。`global` 也只能经 `include_global=true` 显式读入。

## Knowledge Source

`KnowledgeSource` 统一 Evidence Wiki、Serena、旧知识库、项目说明、README 与自定义来源的 scope、digest、trust 和 access：

- `read_only`：只允许提供受限上下文；
- `proposal_only`：只能提出外部内容更新建议；
- 没有任何类型允许 Craft 直接修改外部 Wiki、Serena 或 README。

登记从不扫描 locator、也从不写入它：一条 Source 是"知识在哪里、可以信任到什么程度"的陈述，内容仍归 Wiki、Serena 或项目文件所有。

默认可登记 Craft Evidence Wiki 与 Serena 描述符，且是幂等的（identity digest 固定，第二次调用返回 `idempotent: true`），所以宿主每次启动都跑一遍是安全的。外部知识库首次接入是摘要固定的只读描述，不同步草稿、不导入原始会话，也不把外部 review 自动等同为 Craft 的 Evidence/Signoff。

`trust` 与 `access` 是检索的全部安全面：`resolve` 拒绝非 `active` 的 Source，并把 `untrusted` 视为不可用。

## Memory Ledger

Ledger 统一四种 Memory：`working`、`episodic`、`preference`、`procedural`。每项都有精确 Source（**及该 Source 当时的版本**）、适用 scope、Scope Envelope、content digest、sensitivity、confidence、Evidence、有效期和撤销/替代关系。`working_note:true` 是短生命周期、默认不装载的兼容桥；Task/Run State 仍属于 Runtime，而不是长期记忆。

`craft-memory` 的日常面既可写也可读：候选经 Evidence review 后 materialize 到 Ledger；`craft_memory_ledger_get` 读取一条正文，`craft_memory_ledger_list` 只列调用方明确给出的 scope，默认只含 active 项，历史项必须显式 `include_history=true`。没有 scope 绝不退回全局或跨项目扫描。这样单独安装的 Memory MCP 不需要 Core 主插件也能维护可迁移的记忆，但仍共享同一 Content Store、Evidence、Policy 和 Context Receipt。

两条规则让它成为受治理记录而不是存储：

- **来源是强制的。** `remember` 拒绝非 active 的 Source，并拒绝没有 Evidence 的 `procedural` 或 `confirmed` 项。Ledger 因此无法保存一条来历与支撑都不明的断言。
- **身份是内容寻址的。** identity digest 覆盖 Source 版本与 content digest，所以重复 remember 是幂等的，而同一个 id 下 remember 了**不同**内容是冲突而不是覆盖。

`transition` 要求替代项在**同一 scope** 内且 active：否则 Ledger 要么指向一个读者无法使用的项，要么把一个事实悄悄搬到另一种策略适用的 scope 里。旧 `memory_item`、`episodic_memory`、`semantic_memory` 通过 reference-only compatibility binding 可见，不写回也不强制迁移——`mode: "reference_only"` 与 `migration_performed: false` 记录在 binding 上，所以"没有做破坏性迁移"是可查的事实而不是承诺。

### 形成、冲突与遗忘

显式用户陈述可通过 `craft_memory_capture_user_statement` 写入，但必须携带 `explicit_consent: true`；它只把该陈述作为带 digest 的 bounded Evidence，不把整段聊天自动入库。`working` 默认 24 小时过期、`episodic` 默认 30 天过期；`preference` 与 `procedural` 必须显式维护或撤销，不能以压缩为名覆盖原条目。

可选 `topic` 是稳定的冲突键，例如 `preference:diet:sugar`。Craft 不会从自然语言猜 topic：无法确定主题时宁可降低自动化程度，也不把不相关的偏好混成冲突。相同 scope + topic 的新候选会进入 `conflict_pending`；选择 `supersede` 后，仍要先完成 Evidence review 并 materialize 新 Ledger 项，旧项才转为 `superseded` 并指向替代项。旧正文和版本保留审计，不再被 Context 召回。

这使“多年前喜欢咖啡”与“昨天开始戒糖”可以并存（主题不同）；同一饮食主题的相反新陈述则必须形成明确替代链。压缩或 Deep maintenance 只能生成带来源链的 Candidate，不能物理删除原始 Memory 或直接覆盖当前规则。

## Context Resolution Receipt

Context Resolution 只在一个明确 scope 栈内选择 active、非 `untrusted`、未过期、且 Scope Envelope 对当前 principal/tenant/purpose 允许的 Ledger 项，遵守条目数和字符预算；同时调用 Knowledge/Experience 的受限 Contribution。`restricted` 项默认不装载，只有调用方显式声明 `allow_restricted=true` 才可选择。调用返回当前 Host 所需的正文或引用，但持久 `context_resolution_receipt` 只保存：查询摘要、Source/Memory/Knowledge 精确版本、内容 digest、选择理由、预算和遗漏数量；不保存重复正文。

调用方可通过 `members: ["knowledge"]`、`["memory"]` 或 `["experience"]` 选择一个累积成员。该选择同样进入 Receipt identity；因此 Knowledge 与 Memory 的独立 Codex Hook 不会互相装载材料。省略 `members` 仍保持兼容的全部累积成员解析；`history` 和 `state` 不是可选检索成员，分别属于 Host 与当前 Run。

缺少 `scope_kind + scope_id` 不是错误也不是全局回退：`craft_memory_search` 和 Context Resolution 都返回 `skipped: true, reason: scope_unavailable`，且不会写 Receipt。这样独立插件在一个没有项目身份的普通对话中不会跨项目取数。

三点让 receipt 可信而不是装饰：

- **对查询无内容。** Craft 不持有对话，所以只存查询的 digest 与它选中的 refs。
- **可复现。** identity digest 覆盖 scope、adapter 及版本、选中的 refs 与预算，因此重放同一 resolution 返回同一 receipt（`idempotent: true`），而改动过的是一次冲突而不是静默的第二张 receipt。
- **必选项失败关闭。** 按 id 指定却不可用、或放不进预算的记忆会抛错而不是被悄悄省略。`omitted_count` 记录有多少项因预算被丢，所以调用方能区分"没有匹配"和"预算太小"。

任何 Host、Agent Mode 或后续 Work Loop 都可引用此 Receipt；它不授予 Capability、Effect 或执行权。

### 决策点 Context Gate

检索得太晚不能修正已经做出的选择。高杠杆 Step 可在 `before_preflight` / `before_execute` 通过 `craft_decision_context_gate_open` 生成一次 Decision-point Context Gate：它在**决策前**解析最小 scope 的 Context，并把 receipt、版本、预算和“继续 / 澄清重规划 / 声明 scope”结果落为同一账本。没有 scope 时 Gate 为 `skipped`，不会全局检索；声明 `require_context` 却没有可用项时为 `blocked`。Gate 只提供决策时机的证据，不扩大权限或替代验收。

### 自动知识晋升与旧导入

日常路径不要求人工审核。`craft_knowledge_auto_review` 是可重复的 Evidence/source/scope verifier，而不是“模型觉得内容合理”的自评器：默认按本机 `craft_knowledge_promotion_policy_get` 的自动策略晋升当前 Claim。默认阈值是至少两条**独立**的 `bounded`/`confirmed` Evidence；每条都必须通过 `craft_knowledge_support_record` 绑定不同的 `evidence_id` 与 `observation_key`。因此跨会话、跨运行的真实重复观察会提高可信度，但同一段聊天、同一 Evidence 或同一运行被重复提交都不能刷高分。

当 Craft 作为 Codex 控制台组件运行时，不需要另配模型 API Key：当前 Codex 模型可通过 `craft_knowledge_host_review` 对一个精确的 `claim_id + source_digest` 按固定 rubric 作出 `supported / needs_evidence / rejected` 判定。当前、可信来源且已有 Evidence 的 `supported` Claim 可直接晋升为 `reviewed`；审核记录只保存 Host/模型标识、turn key、rubric、摘要 digest，不保存提示或模型输出正文。这个本机 Host attestation 不是远程身份签名，也不增加任何 effect：它使知识能进入 Context，但不能单独发布 Workflow、修改 Prompt，或扩大工具权限。

策略还会检查正文引用、活动可信 Source、有效期和矛盾关系。legacy scope、无来源、仅 unverified Evidence、过期或冲突的 Claim 固定为 `revalidation_required`，绝不因 Markdown frontmatter、模型自述或旧摘要自动进入执行 Context。`auto_promote:false` 是诊断 dry-run；`craft_knowledge_promotion_policy_save` 允许本机操作者显式降低/提高阈值或熔断自动晋升，但该策略不会随数据包同步到另一台机器。人工复核仍可作为例外覆盖，不是默认队列。

Evidence 是 Core 的唯一事实账本，避免 Knowledge、Experience 与 Runtime 各存一份互相矛盾的“证据”。`craft-knowledge` 将 `craft_evidence_record → craft_knowledge_claim_save → craft_knowledge_support_record → craft_knowledge_auto_review` 作为自己的日常产品闭环对外暴露；外部插件通过 MCP/Capability Contract 调用该闭环，不导入 Craft 内部 TypeScript 文件。

旧页面的内容审核使用第二道、显式的 `craft_knowledge_candidate_model_review`。调用方必须逐条提交 `candidate_id + source_digest + decision + reason`；Craft 随后重新读取源 Markdown、核对不可变 digest、确认源状态与 Evidence 引用，并把审核模型和理由落为 content-free 记录。`supported` 只表示“该历史页面的正文与其来源相符，可作为 bounded context”，不会把旧业务状态宣称为当前线上事实。`revalidate` 与 `reject` 继续停留在 Context 之外。

模型复核通过后，导入器恢复经过敏感检查的**完整 Markdown 正文**，而不是只保存标题或迁移摘要。Source 为 `shared` 的条目进入 `global`；项目条目进入精确的 `project:<project-id>`。缺少项目身份时使用 `project:unbound`，保持已审核但不可路由，直到显式 Project Scope Binding 完成；Craft 不做模糊项目名猜测，也不把它降级成 global。

早期 candidate-only 导入若漏写了 Claim 的 `source_id`，可在离线模式运行 `legacyKnowledgeMigrationRebindProvenance`：它逐页重新核验 source digest 后，只恢复 Claim→Source 的 locator/digest 关联。该修复不改变正文、状态、Evidence confidence 或 Source trust；因此“可追溯”不等于“已证实”，仍必须经过当前仓库/测试/运行事实的重新验证。

## 可选 Retrieval Adapter

默认使用确定性关键词选择。向量 Adapter 必须先登记 provider fingerprint，并通过独立的**检索单点评测**：冻结查询与相关项、召回率达到阈值、跨项目泄漏为零、时延和成本不超预算。跨项目泄漏那一项是**等零**而不是阈值——一条泄漏的跨项目记录不是质量取舍。

关键词、向量或未来任意检索器都要走同一准入；失败、未配置或未评测时 Resolution 固定回退关键词，不会静默使用向量。

本 Module 只管理检索选择的准入事实；真正 embedding 调用仍由既有 `EmbeddingProvider`/部署 Adapter 负责。

## 跨机器数据包

跨机器迁移不是复制 `craft.db`。`craft_knowledge_memory_bundle` 导出的可移植对象只包含一个明确 scope 内的 Knowledge、Memory、必要的 Source/Evidence、追加式 Knowledge Support 与证据关联的 Experience 引用；正文以受校验 Markdown body 形式进入包，接收端再创建自己的本地 `content_ref` 路径。自动晋升阈值属于本机操作配置，故意不随包迁移。

```text
export → verify → import_plan → approved import_apply
```

- 导入计划把每一项标为 `add`、`duplicate` 或 `conflict`；不会静默覆盖本机内容。
- `candidate` 可作为显式迁移内容保留其状态，但仍不能进入执行 Context；`reviewed` 也仍需要其 Evidence 链完整。
- Bundle Digest 覆盖 scope、记录、版本和正文；路径不参与 Digest，因此两台机器上不同的 Markdown 路径不会制造假冲突。
- 该能力不打包 SQLite/WAL、密钥、原始聊天或任意外部文件。真正的云同步、多人合并和加密分发仍是后续 Adapter 能力。

同一个 MCP 工具以 `operation: export | verify | import_plan | import_apply` 操作，避免把一个数据迁移概念拆成大量模型可见 Tool；`import_apply` 必须带 `approved: true`。

## 关联

- [上下文的五个成员](../../technical/modules/context-members.md)：这三个模块各自服务哪个成员、门槛是什么。
- [Capability 扩展协议](capability-protocol.md)：成员边界为什么决定包边界。
- [上下文与记忆管理](context-memory.md)：范围化记忆与后台整理的既有设计。
