# Craft 能力闭合实施计划：把「记忆 / 知识 / 自进化 / Harness」接进运行时

- 日期：2026-09-19
- 基线版本：`VERSION = "0.12.33"`（[craft-service.ts:L37](file:///d:/documents/project/mytest/craft/src/application/craft-service.ts#L37)）
- 状态：待评审
- 目标版本：v0.12.35

---

## 一、Summary（一页结论）

上一轮（v0.12.33 / v0.12.34）已经把 MCP 协议协商、凭证解析、首启就绪、`ReversibleContext`、`Bm25Index`、`fuseRankings`、`decideExperienceCapture` 作为**纯函数**实现并测试到 100% 覆盖。仓库自己的文档也如实承认了这一点——[ideal-state-vs-industry-2026-09-18.md §五](file:///d:/documents/project/mytest/craft/docs/research/ideal-state-vs-industry-2026-09-18.md) 明确列出 5 条未闭合项。

**本轮要做的不是再写内核，而是把这些能力「接线」——接到真实的 loop、真实的 context、真实的检索路径上，并补齐三处仍缺的能力（向量接入、经验自动捕获、关系与衰减）。**

四类改动：

| 类 | 内容 | 涉及 |
|---|---|---|
| B1 | `craft run` 的 context manifest 从硬编码空引用改为真实解析 | [cli.ts:L269](file:///d:/documents/project/mytest/craft/src/cli.ts#L269) |
| B2 | 内部循环工具面从 7 个只读工具扩展到 MCP 全量对齐（可寻址 + 分级授权） | [internal-host-driver.ts](file:///d:/documents/project/mytest/craft/src/internal-host-driver.ts) |
| B3 | BM25 接入 `catalog.searchHybrid`，替换/增强现有纯 substring 词法侧 | [catalog.ts:L253](file:///d:/documents/project/mytest/craft/src/catalog.ts#L253) |
| B4 | 两套记忆系统（`memory_ledger` 与 `episodic/semantic_memory`）打通 | [memory-consolidation.ts](file:///d:/documents/project/mytest/craft/src/memory-consolidation.ts) |
| A2 | 向量检索从 capability catalog 扩到 knowledge / memory | [semantic.ts](file:///d:/documents/project/mytest/craft/src/semantic.ts) |
| A2' | 自动经验捕获接入 `agent-loop` 结束点 | [agent-loop.ts](file:///d:/documents/project/mytest/craft/src/agent-loop.ts) |
| A1 | 轻量关系表 `knowledge_relation` + 多跳查询 | 新内核 + [knowledge-index.ts](file:///d:/documents/project/mytest/craft/src/knowledge-index.ts) |
| A3 | 记忆衰减（decay）与到期回收 | [knowledge-memory-runtime.ts](file:///d:/documents/project/mytest/craft/src/knowledge-memory-runtime.ts) |

一条贯穿全部改动的原则：**能力声明 + 自动降级链**。每项能力声明自己的 `requires`（embedding provider / 向量库 / FTS5），不满足时自动回退，并在 receipt 中如实记录 `actual_mode`——与仓库既有的 fail-not-silent 原则一致，也与「少配了向量模型就先用数据库」的增量配置诉求一致。

---

## 二、Current State Analysis（现状，全部为实测）

### 2.1 已经存在、但没被调用的能力

| 已实现 | 位置 | 现状 |
|---|---|---|
| `ReversibleContext` | [v01234-runtime.ts](file:///d:/documents/project/mytest/craft/src/v01234-runtime.ts) | 纯函数，仅测试调用；`internal-host-driver` 仍用 `compactConversation` |
| `Bm25Index` / `fuseRankings` | 同上 | 零生产调用点；`catalog.searchHybrid` 仍用本地 `rerank` substring |
| `decideExperienceCapture` / `buildExperienceRecord` | 同上 | 接到 MCP 与 service，但 `agent-loop` 结束时不调用 |
| `negotiateProtocolVersion` / `assessMcpMigration` 等 | [v01233-runtime.ts](file:///d:/documents/project/mytest/craft/src/v01233-runtime.ts) | 已接入，本轮不动 |

### 2.2 真正的接线缺口（逐条核实）

**B1 — `craft run` 上下文为空。**
[cli.ts:L269](file:///d:/documents/project/mytest/craft/src/cli.ts#L269)：

```ts
const context = service.contextManifestSave({ manifest_id: ..., knowledge_refs: [], capability_refs: [], workflow_refs: [], excluded_refs: [], selection_rationale: ["standalone runtime context"] }).manifest as JsonObject;
```

三个引用数组**硬编码为空**，`selection_rationale` 是一句占位字符串。`runStandalone`（L238–283）实际上是在「无上下文」下启动工作会话。

**B2 — 内部循环工具面只有 7 个只读工具。**
[internal-host-driver.ts:L42-L50](file:///d:/documents/project/mytest/craft/src/internal-host-driver.ts#L42-L50)：
`capability_search`、`knowledge_search`、`task_checkpoint`、`evidence_record`、`artifact_register`、`workspace_read`、`workspace_write`。

对应白名单在 [craft-service.ts:L241-L260](file:///d:/documents/project/mytest/craft/src/application/craft-service.ts#L241-L260) 的 `invokeInternalAction`，不在表上的动作 `throw new Error("Internal host action is not permitted")`（fail-closed）。

而 [mcp-server.ts](file:///d:/documents/project/mytest/craft/src/interfaces/mcp-server.ts) 暴露的 `craft_*` 工具是数百个（如 `craft_knowledge_search` L1432、`craft_memory_ledger_remember` L1393、`craft_context_resolution_resolve` L1394、`craft_experience_ledger_observe` L1149）。**两套工具面互不相通。**

**B3 — 词法检索无 BM25。**
[catalog.ts:253](file:///d:/documents/project/mytest/craft/src/catalog.ts#L253) `searchHybrid` 已**有 RRF 融合**（`rerank` 是本地打分函数，非模型 reranker），但词法侧判别力弱。[knowledge-index.ts:L254-L263](file:///d:/documents/project/mytest/craft/src/knowledge-index.ts#L254-L263) 的搜索是 `body LIKE ?` 逐 token AND 拼接——**连 catalog 的 RRF 都没有**。

**B4 — 两套记忆互不相通。**
- 系统一：`KnowledgeMemoryRuntime`（[knowledge-memory-runtime.ts](file:///d:/documents/project/mytest/craft/src/knowledge-memory-runtime.ts)）→ `memory_ledger` / `context_resolution_receipt`，有 Evidence 门禁、`noSecret`、status 状态机。
- 系统二：`MemoryConsolidationKernel`（[memory-consolidation.ts](file:///d:/documents/project/mytest/craft/src/memory-consolidation.ts)）→ `episodic_memory` → `semantic_memory`，检索是 `content.toLowerCase().includes(query)`。
两套的写入、检索、状态机完全不同，也没有任何转换路径。

**A2 — 向量只用于 capability。**
[semantic.ts:L68](file:///d:/documents/project/mytest/craft/src/semantic.ts#L68) 的 `OpenAiCompatibleEmbeddingProvider` 与 `cosine`（L95）存在；[knowledge-memory-runtime.ts:L152](file:///d:/documents/project/mytest/craft/src/knowledge-memory-runtime.ts#L152) 里 `retrievalMode = adapter?.status === "eligible" ? adapter.strategy : "keyword"`，但 `resolve` 的打分实际仍是 `content.toLowerCase().includes(term)` 关键词重叠，**向量从未参与检索**。

**A1 — 关系为零。**
全仓库无 `knowledge_relation` 记录类型，无多跳。`surface-registry.ts` 的 knowledge surface 正则里已有 `relation`（L12、L22、L26），但**没有任何工具以 `craft_relation_*` 注册**——是预留的空位。

**A3 — 无衰减。**
[knowledge-memory-runtime.ts](file:///d:/documents/project/mytest/craft/src/knowledge-memory-runtime.ts) 有 `MEMORY_STATUS = ["active","superseded","revoked","expired"]` 与 `valid_until` 字段，但**没有自动过期/衰减扫描**；[knowledge-index.ts:L203](file:///d:/documents/project/mytest/craft/src/knowledge-index.ts#L203) 的 `forgetExpired` 只删投影不删 Markdown。

### 2.3 必须保留的既有边界（不得破坏）

1. **内部循环 fail-closed 白名单**：不在表上的动作必须继续抛错。
2. **内容无关 receipt**：`context_resolution_receipt`、`harness_resolution_receipt` 等不落正文。
3. **Evidence 门禁**：procedural / confirmed 记忆必须有 Evidence；Experience Observation 必须 `confirmed | bounded`。
4. **`noSecret` 检查**：所有文本入参必须先过密钥正则。
5. **`execution_authority: false`**：所有推荐/建议类输出不带执行权。
6. **最多 2 个设计轴**：`continual-harness`、`workflow-evolution`、`experience-ledger` 均已实现，新代码沿用。
7. **`MCP_MIGRATION_STATUS = "assessed_deferred"`**：协议版本不因本轮改动而升级。

---

## 三、Proposed Changes

### 决策记录（来自用户确认）

| 决策点 | 选择 |
|---|---|
| 范围 | 全部：B 类接线 + A2 向量 + 自动经验捕获 + A1 关系 + A3 衰减 |
| 内部循环工具面 | **按 MCP 全量对齐 `craft_*`，但可寻址 + 分级授权** |
| 交付形态 | **就地修改既有内核与 facade**，不新增版本 runtime 模块 |
| 降级机制 | **能力声明 + 自动降级链**，receipt 记录 `actual_mode` |
| 图谱粒度 | **轻量关系表 `knowledge_relation` + 多跳查询**，不引入图库 |
| 验收 | **门禁（lint/test/覆盖率/审计）+ 端到端证据，两者都要** |

---

### 改动 1（B2，最高优先）：内部循环工具面 MCP 全量对齐 + 分级授权

**Why**：这是所有其他能力的**前置条件**。只要工具面还是 7 个只读工具，任何记忆/知识/自进化能力都无法从循环里被调用——`invokeInternalAction` 会直接抛错。

**What**：

1. 新建 `src/internal-tool-authorization.ts`，定义四级授权：

```ts
export type ToolAuthorization = "read" | "candidate" | "governed" | "forbidden";
```

- `read`：只读查询，默认启用（`craft_knowledge_search`、`craft_context_resolution_get`、`craft_memory_search`…）
- `candidate`：提议但未生效的写入（`craft_memory_ledger_remember` 的 candidate 语义、`craft_experience_ledger_observe`、`craft_turn_proposal_submit`），默认启用，但必须经 TurnCognitive / ExperienceLedger 治理才转正
- `governed`：需要 Signoff / Evidence / 评估的受治理写入（`craft_workflow_save`、`craft_capability_publish`、`craft_agent_evaluate`…），**默认不注册**，需显式开关
- `forbidden`：沙箱逃逸、凭证读取、宿主配置修改等，**永不可寻址**

2. 分类规则复用 [surface-registry.ts](file:///d:/documents/project/mytest/craft/src/interfaces/mcp/surface-registry.ts) 的既有 SURFACE_RULES，**不新建一套分类**：先按 surface 归类，再按动词（`_get` / `_list` / `_search` = read；`_propose` / `_observe` / `_submit` / `_remember` = candidate；`_save` / `_publish` / `_promote` / `_decide` / `_signoff` = governed）细化。

3. `InternalHostDriver` 构造函数新增 `authorization?: ToolAuthorization[]`（默认 `["read","candidate"]`），[service-foundation.ts:L307-L309](file:///d:/documents/project/mytest/craft/src/service-foundation.ts#L307-L309) 传入。

4. `invokeInternalAction`（[craft-service.ts:L241](file:///d:/documents/project/mytest/craft/src/application/craft-service.ts#L241)）改为**两级校验**：
   - 第一级：工具名必须在授权集合内，否则抛错（保留 fail-closed）
   - 第二级：动作参数必须通过该内核自身的门禁（沿用内核已有校验，**不绕过**）

5. 工具描述从 `McpServer` 的工具表**单一来源**生成（`buildTools()`），避免两处定义漂移。

**How（关键代码形状）**：

```ts
// internal-host-driver.ts
export interface InternalHostOptions {
  providers: ProviderDeclaration[];
  transport?: ModelTransport;
  invokeAction?: (action: string, args: JsonObject) => JsonObject;
  env?: NodeJS.ProcessEnv;
  tools?: string[];                       // 保留：显式工具名列表
  authorization?: ToolAuthorization[];    // 新增：分级授权
  toolSchemaProvider?: () => Tool[];      // 新增：从 MCP 单一来源取 schema
}
```

**边界守护**：新增测试断言 `forbidden` 集合中的每个工具名在内部循环下都抛错；断言默认配置下 `governed` 工具不可寻址。

---

### 改动 2（B1）：`craft run` 接入真实上下文解析

**Why**：这是「接线」最具代表性的一处——能力全在，接的是空数组。

**What**：

1. `runStandalone`（[cli.ts:L238-L283](file:///d:/documents/project/mytest/craft/src/cli.ts#L238-L283)）在 `contextManifestSave` 之前插入真实解析：

```
knowledgeIndexSync({ scope_kind: "project", scope_id: <projectRoot> })
  → knowledgeSearch({ query: <task goal>, limit: 6 })
  → capabilitySearch({ query: <task goal>, limit: 6 })
  → contextResolutionResolve({ query: <task goal>, scope_kind: "project", scope_id: <projectRoot> })
      → 取 memory_refs
  → contextManifestSave({ knowledge_refs, capability_refs, workflow_refs, excluded_refs, selection_rationale })
```

2. 每个 ref 带 `{ kind, id, version, digest }`，与既有 receipt 惯例一致。
3. `selection_rationale` 记录**真实的选择理由**（如 `"bm25_top6"`、`"memory_scope_project"`、`"degraded:no_embedding_provider"`），不再写占位符。
4. 空结果时 `excluded_refs` 记录被排除的原因，`selection_rationale` 记录 `"no_match"`——**不假装有上下文**。

**How**：新增私有函数 `resolveStandaloneContext(service, { goal, projectRoot })`，纯编排、可独立测试。同时给 `craft run` 增加 `--context-scope` 选项（默认 `project`）。

---

### 改动 3（B3）：BM25 接入 `catalog.searchHybrid` 与 `knowledge-index`

**Why**：Craft 存的是 receipt digest、ticket id、sha256——**标识符密集**，正是纯语义/substring 检索最弱处。`Bm25Index` 已实现且有 identifier boost，却零生产调用。

**What**：

1. [catalog.ts:253](file:///d:/documents/project/mytest/craft/src/catalog.ts#L253) `searchHybrid`：把现有 `rerank` 作为「本地信号」保留，**新增 BM25 作为独立词法信号**，用 `fuseRankings` 做三路 RRF（bm25 + 现有 rerank + vector）。
2. [knowledge-index.ts:L254-L263](file:///d:/documents/project/mytest/craft/src/knowledge-index.ts#L254-L263)：检索从 `body LIKE ?` 改为内存 `Bm25Index`；SQL 仍负责**取候选集**（保持可移植，不依赖 FTS5）。
3. **降级链**：`Bm25Index` 是纯 JS，无外部依赖，因此永远可用——这一条不降级，只是**新增信号**。

**回归门禁（重要）**：仓库文档已明确「不该在没有对照数据的情况下换掉线上检索路径」。因此：
- 保留 `searchHybrid` 原签名与返回形状；
- 新增 `tests/catalog-search-regression.test.ts`，用**固定语料 + 固定查询**对照 RRF 融合前后的 top-k 变化，把变化写入测试期望（可审查）；
- 若回归显示 top-1 变差，则把 BM25 降级为**仅增强**（`fuseRankings` 中给 bm25 更低权重），而不是替换。

---

### 改动 4（B4）：两套记忆系统打通

**Why**：`memory_ledger` 与 `episodic/semantic_memory` 各行其是，一次对话里模型看到的是哪一套取决于它调了哪个工具。

**What**：

1. 在 `MemoryConsolidationKernel` 增加**单向投影**：`semantic_memory` 的每条记录在 `consolidate` 后，同步写入 `memory_ledger`（走 `KnowledgeMemoryRuntime.remember`，`kind: "episodic"` 或 `"procedural"`，`scope_kind: "project"`）。
2. `KnowledgeMemoryRuntime.resolve` 与 `MemoryConsolidationKernel.search` 共享一个**统一检索函数** `unifiedMemorySearch(store, { query, scope, limit })`：两套都过 BM25，再 `fuseRankings` 合并，返回带 `source` 字段的结果。
3. **不做的**：不删除任何一套记录类型（会破坏现有测试与历史数据），不做双向同步（会造成写放大与循环）。方向固定为 `episodic → semantic → ledger`。
4. 降级：`retrieval_adapter` 未 `eligible` 时，`actual_mode: "bm25_only"`。

---

### 改动 5（A2）：向量检索接入 knowledge / memory

**Why**：`semantic.ts` 的 provider 与 `cosine` 已存在，`retrievalMode` 字段也已预留，但向量从未参与打分。

**What**：

1. `KnowledgeMemoryRuntime.resolve`（[knowledge-memory-runtime.ts:L148](file:///d:/documents/project/mytest/craft/src/knowledge-memory-runtime.ts#L148)）：打分改为 `bm25_score` 与 `cosine_score` 的 RRF 融合。
2. `KnowledgeIndex.search`：同样支持向量信号。
3. **能力声明 + 降级链**（核心）：

```ts
export interface CapabilityDeclaration {
  name: "vector_retrieval" | "fts5" | "embedding_provider" | "knowledge_graph";
  requires: string[];        // e.g. ["embedding_provider"]
  fallback: string[];        // e.g. ["bm25", "keyword"]
}
```

启动时评估（复用 [v01233-runtime.ts](file:///d:/documents/project/mytest/craft/src/v01233-runtime.ts) 的 `firstRunReadiness` 形状）：
- 无 embedding provider → `vector_retrieval` 不可用 → 回退 `bm25`
- 有 provider 但未通过 `retrievalEvaluate`（recall ≥ 0.8 且 leakage = 0）→ 仍回退 `bm25`，`actual_mode: "bm25_only"`
- 通过 → `actual_mode: "hybrid_rrf"`

4. **receipt 如实记录**：`context_resolution_receipt` 增加 `actual_mode` 与 `degraded_reason`（内容无关）。这是对既有 `retrievalMode` 字段的扩展，不是新概念。

5. **不做**：不引入外部向量库（SQLite 存 embedding BLOB 即可，与现有「单一 CraftStore」架构一致）。

---

### 改动 6（A2'）：自动经验捕获接入 `agent-loop`

**Why**：仓库文档如实承认「`decideExperienceCapture` 是纯函数，但没有在 `agent-loop` 结束时自动调用」。所以自进化目前是被动的。

**What**：

1. 在 [agent-loop.ts](file:///d:/documents/project/mytest/craft/src/agent-loop.ts) 的**终态收敛处**（熔断触发后 / 正常结束时）调用 `decideExperienceCapture`。
2. **信号来源必须明确且可审计**（这是用户在文档里要求「先定信号从哪来」的部分）：

| 信号 | 来源（全部来自 loop 自身状态，非模型自述） |
|---|---|
| `outcome` | 终态 verdict（passed / failed / inconclusive） |
| `retries` | 同一 `hash(action+args)` 的重复计数（已有 `repeated_action` 闸） |
| `corrections` | 外部观测摘要发生变化后模型改变动作的次数 |
| `distinct_tools` | 本 loop 内 `invokeAction` 的不同工具名计数 |
| `novel` | 该 `scenario_key` 是否首次出现（查 `experience_observation`） |
| `user_explicit` | 本轮 prompt 是否含显式「记住」意图标记 |
| `duration_minutes` | 墙钟 |

3. **产出候选，不静默写入**：高分时调用 `experienceLedgerObserve`（`content_free: true`，`diagnostic_only`），**不**直接写 memory。
4. `requires_review` 只对 `failure_lesson` / `correction` 为真（沿用 v01234 已校准的语义）。
5. **`execution_authority: false`** 贯穿。

**关键**：绝不把模型自述当信号。这正是 [internal-host.md](file:///d:/documents/project/mytest/craft/docs/technical/modules/internal-host.md) 已经确立的原则。

---

### 改动 7（A1）：`knowledge_relation` 轻量关系表 + 多跳查询

**Why**：`surface-registry.ts` 里 `relation` 已预留但无实现——这是唯一一处「零实现」的 A 类缺口。

**What**：

1. 新建 `src/knowledge-relation.ts`，`KnowledgeRelationKernel`：

```ts
export const RELATION_KINDS = ["derives_from", "supersedes", "contradicts", "supports", "refines", "references"] as const;

// 记录形状（沿用 CraftStore.create 惯例）
{
  source: { kind, id, version },
  target: { kind, id, version },
  relation: RELATION_KINDS,
  valid_from: ISO8601,
  valid_to: ISO8601 | null,     // bi-temporal：软失效而非删除
  evidence_ids: string[],       // 复用 Evidence 门禁
  confidence: "confirmed" | "bounded" | "unverified"
}
```

2. 方法：`relate` / `retract`（设 `valid_to`）/ `neighbors`（一跳）/ `traverse`（多跳，`max_depth` 默认 2，硬上限 3）/ `get`。
3. **多跳必须有界**：`max_depth ≤ 3`，且**检测环**（访问集），超限抛错而不是无限展开——与仓库「最多 2 个设计轴」「max 4 changes」的有界风格一致。
4. **接入检索**：`knowledgeSearch` 结果携带 `relations` 字段（一跳邻居摘要），供循环决定是否深入。
5. **不引入图库**：SQLite 表 + 内存邻接即可。bi-temporal 用 `valid_from` / `valid_to` 表达，查询支持 `as_of` 时间点。
6. MCP 工具名 `craft_relation_*` 落地后，`surface-registry.ts` 已有的 `relation` 正则**自然生效，无需改动**。

---

### 改动 8（A3）：记忆衰减

**Why**：`valid_until` 字段存在但无人扫描；`forgetExpired` 只删投影。

**What**：

1. `KnowledgeMemoryRuntime` 新增 `decay` 策略（**显式调用，不做后台定时器**——保持确定性，与仓库「无隐式副作用」风格一致）：

```ts
export function decayScore(input: {
  now: string;
  created_at: string;
  last_referenced_at: string | null;
  reference_count: number;
  confidence: "confirmed" | "bounded" | "unverified";
  kind: "working" | "episodic" | "preference" | "procedural";
}): { score: number; action: "keep" | "demote" | "expire" };
```

2. 半衰期按 `kind` 分档：`working` 最短（小时级）、`episodic` 中等、`preference` / `procedural` 最长（近似永久）。`confirmed + procedural` **永不自动过期**。
3. `consolidate` / `resolve` 前调用 `decay`，把 `expire` 的记忆置 `status: "expired"`（**不物理删除**，与既有状态机一致）。
4. 新增 `craft_memory_decay_apply`（candidate 级授权），并由 `agent-loop` 在长任务收尾时可调用。
5. 记录 `last_referenced_at` / `reference_count`：`resolve` 命中时更新——这是衰减的数据基础，本轮必须一起加。

---

## 四、Assumptions & Decisions

| # | 决策 | 理由 |
|---|---|---|
| 1 | 就地改既有内核，不建 `v01235-runtime.ts` | 用户选择；本轮改动本质是「接线」，纯函数内核已存在 |
| 2 | 降级链用 `actual_mode` + `degraded_reason` 记录在既有 receipt 上 | 扩展而非新概念，兼容既有 receipt 消费者 |
| 3 | `governed` 工具默认不注册，需显式开关 | 保留「自跑循环不自动获得审批权」边界 |
| 4 | 记忆投影方向单向 `episodic → semantic → ledger` | 避免写放大与同步循环 |
| 5 | 关系多跳 `max_depth ≤ 3` 且检测环 | 有界，与仓库既有风格一致 |
| 6 | 衰减不物理删除，只改 status | 与既有 `MEMORY_STATUS` 状态机一致 |
| 7 | 衰减显式调用，不装定时器 | 保持确定性、可测试 |
| 8 | BM25 若回归变差则降级为增强信号而非替换 | 遵循仓库「无对照数据不换线上路径」原则 |
| 9 | 不改 `MCP_MIGRATION_STATUS` | 本轮与协议迁移无关 |
| 10 | 不引入外部向量库/图库，全部落在单一 `CraftStore` | 与既有架构一致 |
| 11 | 测试策略：新内核 100% 覆盖 + 端到端证据 | 用户要求「两者都要」 |

---

## 五、Verification（验收）

### 5.1 门禁（必须全绿）

```bash
cd d:\documents\project\mytest\craft
node scripts/lint.ts
node scripts/test.ts
node scripts/check-version.ts
node scripts/audit-v01234-layering.mjs
node scripts/check-plugin-package.ts
```

覆盖率沿用既有口径：`--test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100`。

### 5.2 新增测试

| 文件 | 断言 |
|---|---|
| `tests/internal-tool-authorization.test.ts` | `forbidden` 集合每个工具都抛错；默认配置下 `governed` 不可寻址；`read` / `candidate` 可用 |
| `tests/craft-run-context.test.ts` | **端到端**：`craft run` 产出的 manifest 中 `knowledge_refs` 非空；`selection_rationale` 无占位符；空项目时记录 `no_match` 而非假装有上下文 |
| `tests/catalog-search-regression.test.ts` | 固定语料 + 固定查询的 RRF 融合前后 top-k 对照 |
| `tests/knowledge-index-bm25.test.ts` | 标识符查询（如 `sha256:...`）命中率优于纯 substring |
| `tests/unified-memory-search.test.ts` | 两套记忆经统一检索返回带 `source` 的合并结果；投影单向无循环 |
| `tests/vector-retrieval-degradation.test.ts` | 无 provider → `actual_mode: "bm25_only"`；有 provider 未 eligible → 同样回退；eligible → `hybrid_rrf` |
| `tests/experience-auto-capture.test.ts` | loop 终态触发捕获；产出 `experience_observation` 而非 memory；模型自述不构成信号 |
| `tests/knowledge-relation.test.ts` | 多跳 `max_depth` 超限抛错；环检测生效；`as_of` 时间点查询正确；`retract` 是软失效 |
| `tests/memory-decay.test.ts` | `confirmed + procedural` 永不过期；`working` 最快过期；expire 只改 status 不删除 |
| `tests/v01235-integration.test.ts` | 经真实 MCP server 的端到端：`craft run` → 记忆写入 → 检索命中 → 关系查询 |

### 5.3 端到端证据（用户要求「两者都要」）

必须能演示并留痕：

1. `craft run` 在**有知识库的项目**上产出非空 `knowledge_refs`，且 manifest 中可见 `actual_mode`。
2. 一次失败任务结束后，`experience_observation` 中出现一条候选（`content_free: true`）。
3. 对写入的记忆做 `craft_relation_traverse`，返回邻居。
4. **在未配置 embedding provider 的环境**下，上述三项**全部仍可工作**，receipt 中 `actual_mode: "bm25_only"`——这是「增量配置」诉求的直接证据。

### 5.4 必须回归验证的既有边界

- [ ] `invokeInternalAction` 对未授权动作仍抛错
- [ ] `context_resolution_receipt` 仍为内容无关
- [ ] Experience Observation 仍要求 `confirmed | bounded` Evidence
- [ ] `noSecret` 仍拦截密钥
- [ ] `execution_authority` 仍为 `false`
- [ ] `design_axes ≤ 2` 仍生效
- [ ] `MCP_MIGRATION_STATUS` 仍为 `assessed_deferred`

---

## 六、实施顺序（依赖驱动）

```
1. 改动 1（B2 工具面）        ← 前置：不动它，其余能力无法被循环调用
2. 改动 2（B1 craft run 上下文）
3. 改动 3（B3 BM25 接入）
4. 改动 7（A1 关系表）        ← 与 3 共用 BM25 基础设施
5. 改动 4（B4 记忆打通）
6. 改动 5（A2 向量 + 降级链）
7. 改动 8（A3 衰减）          ← 依赖 4/5 的检索路径
8. 改动 6（A2' 自动捕获）     ← 依赖 1（工具面）与 7（关系）
9. 门禁 + 端到端验收
10. 更新 docs/technical/modules/ 与 docs/research/ 记录
```

每一步完成后跑 `node scripts/test.ts`，不留到最后一次性验证。

---

## 七、明确不做（Non-goals）

1. **不升级 MCP 协议到 2026-07-28**——独立议题，状态保持 `assessed_deferred`。
2. **不引入外部向量数据库 / 图数据库**——与单一 `CraftStore` 架构相左。
3. **不实现 Windows Job Object 隔离后端**——`isolationCapability` 如实返回 `enforced: false` 即可。
4. **不把 LLM Judge 当发布 Gate**——延续 `ineligible` / `inconclusive` 语义。
5. **不做后台定时衰减任务**——只做显式调用。
6. **不物理删除任何记忆或知识**——只改 status / `valid_to`。
7. **不让内部循环自动获得受治理写权限**——`governed` 需显式开关。
8. **不新增版本 runtime 模块**（用户选择就地修改）。
