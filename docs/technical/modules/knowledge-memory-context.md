# Knowledge Source、Memory Ledger 与 Context Resolution

> 状态：三个模块，两个能力包 + 一个核心控制面。v0.12.19 曾把它们收敛为**一个** Module（`knowledge-memory-runtime.ts`）；v0.12.43 沿**上下文成员边界**把它切开，因为一个类同时服务两个成员，导致两个成员都无法成为能力包。本文标题没变，因为它从一开始就是准确的；文件名随实现改名。

```text
知识来源描述符                                   capability/craft-knowledge/knowledge-source-registry.ts
  → Memory Ledger（来源、范围、证据、有效期、状态）  capability/craft-memory/memory-ledger.ts
  → Context Resolution（预算、选择理由、精确版本）   src/context-resolution.ts
  → content-free Receipt
  → Host / Verified Work Loop
```

## 为什么切成这三个，而不是别的切法

切法是**成员边界**，不是代码大小：`KnowledgeSourceRegistry` 是 knowledge 成员的写入侧，`MemoryLedgerKernel` 是 memory 成员的写入侧，而 `ContextResolutionKernel` 是**三个累积成员共用的读取侧**。

最后一条决定了它必须留在核心：`component-knowledge`、`component-memory`、`component-context` 三个产品**都**暴露 `craft_context_resolution_*` 与 `craft_retrieval_adapter_*`。只装一个关注点的宿主仍然要能解析那个关注点持有的材料，所以读取侧不能属于任一成员的包。相应地，两个能力包都**不**声明 `contributes`——那会让同一个成员有两个贡献者，而 `buildCapabilityRegistry` 直接拒绝。

## Knowledge Source

`KnowledgeSource` 统一 Evidence Wiki、Serena、旧知识库、项目说明、README 与自定义来源的 scope、digest、trust 和 access：

- `read_only`：只允许提供受限上下文；
- `proposal_only`：只能提出外部内容更新建议；
- 没有任何类型允许 Craft 直接修改外部 Wiki、Serena 或 README。

登记从不扫描 locator、也从不写入它：一条 Source 是"知识在哪里、可以信任到什么程度"的陈述，内容仍归 Wiki、Serena、kefu 或项目文件所有。

默认可登记 Craft Evidence Wiki 与 Serena 描述符，且是幂等的（identity digest 固定，第二次调用返回 `idempotent: true`），所以宿主每次启动都跑一遍是安全的。外部知识库首次接入是摘要固定的只读描述，不同步草稿、不导入原始会话，也不把外部 review 自动等同为 Craft 的 Evidence/Signoff。

`trust` 与 `access` 是检索的全部安全面：`resolve` 拒绝非 `active` 的 Source，并把 `untrusted` 视为不可用。

## Memory Ledger

Ledger 统一四种 Memory：`working`、`episodic`、`preference`、`procedural`。每项都有精确 Source（**及该 Source 当时的版本**）、user/project/workspace/task scope、content digest、sensitivity、confidence、Evidence、有效期和撤销/替代关系。

两条规则让它成为受治理记录而不是存储：

- **来源是强制的。** `remember` 拒绝非 active 的 Source，并拒绝没有 Evidence 的 `procedural` 或 `confirmed` 项。Ledger 因此无法保存一条来历与支撑都不明的断言。
- **身份是内容寻址的。** identity digest 覆盖 Source 版本与 content digest，所以重复 remember 是幂等的，而同一个 id 下 remember 了**不同**内容是冲突而不是覆盖。

`transition` 要求替代项在**同一 scope** 内且 active：否则 Ledger 要么指向一个读者无法使用的项，要么把一个事实悄悄搬到另一种策略适用的 scope 里。旧 `memory_item`、`episodic_memory`、`semantic_memory` 通过 reference-only compatibility binding 可见，不写回也不强制迁移——`mode: "reference_only"` 与 `migration_performed: false` 记录在 binding 上，所以"没有做破坏性迁移"是可查的事实而不是承诺。

## Context Resolution Receipt

Context Resolution 只在一个精确 scope 内选择 active、非 `untrusted` 且未过期的 Ledger 项，遵守条目数和字符预算。`restricted` 项默认不装载，只有调用方显式声明 `allow_restricted=true` 才可选择。调用返回当前 Host 所需的正文，但持久 `context_resolution_receipt` 只保存：查询摘要、Source/Memory 精确版本、内容 digest、选择理由、预算和遗漏数量；不保存重复正文。

三点让 receipt 可信而不是装饰：

- **对查询无内容。** Craft 不持有对话，所以只存查询的 digest 与它选中的 refs。
- **可复现。** identity digest 覆盖 scope、adapter 及版本、选中的 refs 与预算，因此重放同一 resolution 返回同一 receipt（`idempotent: true`），而改动过的是一次冲突而不是静默的第二张 receipt。
- **必选项失败关闭。** 按 id 指定却不可用、或放不进预算的记忆会抛错而不是被悄悄省略。`omitted_count` 记录有多少项因预算被丢，所以调用方能区分"没有匹配"和"预算太小"。

任何 Host、Agent Mode 或后续 Work Loop 都可引用此 Receipt；它不授予 Capability、Effect 或执行权。

## 可选 Retrieval Adapter

默认使用确定性关键词选择。向量 Adapter 必须先登记 provider fingerprint，并通过独立的**检索单点评测**：冻结查询与相关项、召回率达到阈值、跨项目泄漏为零、时延和成本不超预算。跨项目泄漏那一项是**等零**而不是阈值——一条泄漏的跨项目记录不是质量取舍。

关键词、向量或未来任意检索器都要走同一准入；失败、未配置或未评测时 Resolution 固定回退关键词，不会静默使用向量。

本 Module 只管理检索选择的准入事实；真正 embedding 调用仍由既有 `EmbeddingProvider`/部署 Adapter 负责。

## 关联

- [上下文的五个成员](../../technical/modules/context-members.md)：这三个模块各自服务哪个成员、门槛是什么。
- [Capability 扩展协议](capability-protocol.md)：成员边界为什么决定包边界。
- [上下文与记忆管理](context-memory.md)：范围化记忆与后台整理的既有设计。
