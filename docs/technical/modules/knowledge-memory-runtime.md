# Knowledge Source、Memory Ledger 与 Context Resolution

v0.12.19 将知识来源、可用记忆和上下文装配收敛为一个控制面 Module。它不替代 Evidence Wiki、Serena 或用户已有知识库；这些系统保留各自的内容与维护职责。

```text
知识来源描述符
  → Memory Ledger（来源、范围、证据、有效期、状态）
  → Context Resolution（预算、选择理由、精确版本）
  → content-free Receipt
  → Host / Verified Work Loop
```

## Knowledge Source

`KnowledgeSource` 统一 Evidence Wiki、Serena、旧知识库、项目说明、README 与自定义来源的 scope、digest、trust 和 access：

- `read_only`：只允许提供受限上下文；
- `proposal_only`：只能提出外部内容更新建议；
- 没有任何类型允许 Craft 直接修改外部 Wiki、Serena 或 README。

默认可登记 Craft Evidence Wiki 与 Serena 描述符。外部知识库首次接入是摘要固定的只读描述，不同步草稿、不导入原始会话，也不把外部 review 自动等同为 Craft 的 Evidence/Signoff。

## Memory Ledger

Ledger 统一四种 Memory：`working`、`episodic`、`preference`、`procedural`。每项都有精确 Source、user/project/workspace/task scope、content digest、sensitivity、confidence、Evidence、有效期和撤销/替代关系。

`procedural` 或 `confirmed` 记忆必须引用 Evidence；偏好和临时工作记忆可以是 bounded。旧 `memory_item`、`episodic_memory`、`semantic_memory` 通过 reference-only compatibility binding 可见，不写回也不强制迁移。

## Context Resolution Receipt

Context Resolution 只在一个精确 scope 内选择 active、非 `untrusted` 且未过期的 Ledger 项，遵守条目数和字符预算。`restricted` 项默认不装载，只有调用方显式声明 `allow_restricted=true` 才可选择。调用返回当前 Host 所需的正文，但持久 `context_resolution_receipt` 只保存：查询摘要、Source/Memory 精确版本、内容 digest、选择理由、预算和遗漏数量；不保存重复正文。

任何 Host、Agent Mode 或后续 Work Loop 都可引用此 Receipt；它不授予 Capability、Effect 或执行权。

## 可选 Retrieval Adapter

默认使用确定性关键词选择。向量 Adapter 必须先登记 provider fingerprint，并通过独立的**检索单点评测**：冻结查询与相关项、召回率达到阈值、跨项目泄漏为零、时延和成本不超预算。关键词、向量或未来任意检索器都要走同一准入；失败、未配置或未评测时 Resolution 固定回退关键词，不会静默使用向量。

本 Module 只管理检索选择的准入事实；真正 embedding 调用仍由既有 `EmbeddingProvider`/部署 Adapter 负责。
