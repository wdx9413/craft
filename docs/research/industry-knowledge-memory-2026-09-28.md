# Knowledge / Memory 业界对照与实际缺口

核查日期：2026-09-28。范围：当前工作区源码、隔离临时数据库探针、业界官方文档。不读真实用户 Ledger，不运行外部产品性能测试，不修改产品实现。文档描述可证明产品提供什么，不能证明其效果优于 Craft。

## 判断

Craft 已有证据、作用域、候选审核、撤销、TTL、内容摘要及检索回执等基础；主要问题是**已存在的能力没有全部进入默认读取路径**，以及检索规模、历史语义、资料接入和质量评估还不足。不能继续用“有没有 Memory/Graph/Hybrid API”判定完成度。

## 精选四个对照

| 项目 | 本次确认的能力与边界 | 对 Craft 的意义 |
| --- | --- | --- |
| Mem0 | scoped vector search、可选 reranker、threshold/top-k；平台和 OSS 的筛选表达能力不同，不能混算。文档还提供 explain score。 | 对照可运行的检索路径及排序解释，不照搬 SaaS 全部能力。来源：[Search Memory](https://docs.mem0.ai/core-concepts/memory-operations/search)。 |
| Zep / Graphiti | Zep 事实同时记录业务生效/失效时间和系统获知时间；官方明确时间字段不等于事实为真。 | 对照历史时点读取，而不是认为有 graph 就能自动消除矛盾。Zep 是托管产品，不能把它的全部特性算作 Graphiti OSS 默认能力。来源：[Temporal Facts](https://help.getzep.com/facts)、[Graphiti 官方仓库](https://github.com/getzep/graphiti)。 |
| Letta | 当前主文档采用 Git-backed MemFS，常驻 system 目录、按需读取其他文件、dreaming 归纳与 doctor 整理；MemFS 默认无向量索引，需扩展。旧 memory blocks 在 V1 legacy 栏。 | 最值得借鉴的是日常整理和可见性，不是必须迁移成 Letta Runtime。来源：[MemFS](https://docs.letta.com/concepts/memfs)、[Memory & dreaming](https://docs.letta.com/configuration/memory)、[V1 blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks)。 |
| LlamaIndex | IngestionPipeline 有可组合 transformations、缓存、docstore、upsert/delete；是否启用取决于配置，不能把库可配置能力等同于默认运行。 | 对照来源更新后如何增量转换、保留结构和处理删除。来源：[当前 ingestion API 与源码](https://developers.llamaindex.ai/python/framework-api-reference/ingestion/)。 |

## 已存在，不能再列成“缺失”

- Knowledge：来源注册/信任边界、不可变 revision、fragment→Evidence→candidate、旧审核 Claim 标为 stale；只把 reviewed 且来源可用的 Claim 放入执行上下文。[来源接入](../../capability/craft-knowledge/knowledge-source-registry.ts)、[实际读取路径](../../capability/craft-knowledge/contribution.ts)。
- Memory：working/episodic/preference/procedural、TTL、observed_at/effective_from、替代/撤销、expected_version、scope precedence、同 topic 冲突弃答。[Ledger](../../capability/craft-memory/memory-ledger.ts)、[时间选择](../../core/retrieval-port.ts)、[冲突治理](../../core/memory-governance.ts)。
- 检索：真实 OpenAI-compatible embedding 请求、响应验证、进程缓存、Memory 的 RRF hybrid、熔断和可解释降级。**不是一个空的 vector 配置壳。**[检索适配器](../../core/retrieval-port.ts)、[Context resolution](../../core/context-resolution.ts)。
- Knowledge Markdown 索引有真正的 Bm25Index 排序；`LIKE` 是其候选预筛。不要把这一事实推广到另一个 governed Claim 检索路径。[KnowledgeIndex.search](../../core/knowledge-index.ts)。
- 维护：已有去重、过期、孤立语义记忆诊断及 proposal-only deep maintenance。不能说 Craft 完全没有 consolidation/maintenance。[维护](../../core/memory-maintenance.ts)、[consolidation](../../core/memory-consolidation.ts)。

## 具体缺口与优先级

### P0：统一读取路径与预算竞争

**已证实实现缺口。** `KnowledgeContribution.search` 扫描最多 10,000 条 Claim，按 query term `includes` 个数排序；不会调用已有 KnowledgeIndex 或配置的向量适配器。`ContextResolutionKernel` 的向量/hybrid 只对 Memory documents 运行，随后顺序拼接其他 contribution。Mem0 的向量+可选重排提供的是检索路径上的能力；Craft 目前只有部分路径达到这一层。[Craft Claim 检索](../../capability/craft-knowledge/contribution.ts)、[Memory 路由与顺序预算](../../core/context-resolution.ts)、[Mem0 对照](https://docs.mem0.ai/core-concepts/memory-operations/search)。

还有一个命名误导：`KeywordRetrievalPort` 输出 `reason: keyword_bm25`，实现其实是关键词命中计数，没有 BM25 的词频、逆文档频率或长度归一。独立 KnowledgeIndex 才是真 BM25。[两种实现](../../core/retrieval-port.ts)、[真实 BM25 索引](../../core/knowledge-index.ts)。

**隔离运行已证实预算饥饿。** `max_items:1`、query=`alpha beta gamma` 时，只含 `alpha` 的 Memory 先拿到槽位，三词全匹配的 reviewed Knowledge 被遗漏；切到 `members:["knowledge"]` 可取回该 Claim。当前顺序可视作确定性策略，但产品没有给出“Memory 永远优先于更相关知识”的合理性或效果证明。应先各成员召回，再做去重、相关性/权威性比较和预算分配；明确 pinned/required 项的优先级，不把来源顺序当相关性。

验收：同一标注集覆盖 memory-only / knowledge-only / mixed；混合查询不能被无关偏好挤掉关键事实；回执显示统一排序依据、预算遗漏及实际检索模式。此处不要求马上引入大型向量数据库。

### P0：历史读取的公开语义不完整

**隔离运行已证实。** `history_view:true` 之前，resolver 已按 `status===active` 和当前 `valid_until` 过滤。于是 superseded/revoked/expired 记录根本到不了时间选择器；选择器本身在 history 模式也会去掉 expired。`now` 参数不足以重建当时的状态，当前状态和业务有效时间被混用。[预筛与 history_view](../../core/context-resolution.ts)、[时间选择器](../../core/retrieval-port.ts)。

对照 Zep 的四时间字段，Craft 不需要先建时态图；先明确 `current`、`history`、`as_of` 的不同用途即可。历史数据可供诊断，不能因此重新成为当前执行指令。已有 content/version/provenance 可以复用。[Zep 时间语义](https://help.getzep.com/facts)。

验收：同一偏好先 A 后 B 再撤销，分别询问当前、变更前、变更后及“系统当时已知什么”，得到一致的受限结果，历史回执不能被当作当前授权。

### P1：规模化检索与质量门禁的真实性

**实现能力有限，效果未验证。** Embedding 适配器使用静态进程 Map 缓存，冷启动对 query+全部合格正文一次请求，再逐条 cosine 排序；没有持久向量索引、批次大小控制或缓存淘汰。读取列表也限制 10,000。小规模可用不等于支持长期大规模资料库。[适配器](../../core/retrieval-port.ts)、[候选列表](../../core/context-resolution.ts)。

`retrievalEvaluate` 接收调用方提交的 recall/leak/latency/cost 数值并设置 eligible，没有在该路径运行数据集，也没有绑定 dataset/corpus digest、逐条结果或证据 ID。已有验证门不能直接宣称真实召回率达标。[门禁实现](../../core/context-resolution.ts)。另外 usage/decay 信号函数存在，但 resolver 最终排序只用 retrieval hit score，未消费它们；“记忆会随成功使用变得更有效”还不是默认读取路径的事实。[信号](../../capability/craft-memory/memory-signals.ts)、[默认排序](../../core/context-resolution.ts)。

建议先补可复跑评估：同义问法、中文+代码符号、跨 scope 泄漏、时间变化、错误记忆反例；记录 Recall@k/MRR、任务正确率、token、P95 与真实成本。实现持久索引或 reranker 前后用同一数据集比较。不能引用 Mem0/Zep 自报分数替代 Craft 实测。

### P1：来源摄取仍是受限文本扫描

**已证实实现缺口。** 当前 sourceIngest 支持目录里的 `.md/.mdx/.txt`，按固定字符数切片；没有在此路径实现结构化 PDF/表格解析、远程 connector 增量游标或 ACL 变更同步。一次 revision 绑定所选文件集合，集合变更会使旧 revision 的已审核 Claim stale，包括没有改变的文件内容；治理安全但重复审核成本高。`max_files` 截断也未返回 has_more/cursor，不能把一次 completed 当作整源已摄取。[扫描与 revision 实现](../../capability/craft-knowledge/knowledge-source-registry.ts)。

对照 LlamaIndex 的 per-document hash、转换缓存、upsert/delete：Craft 应补文档级稳定身份、结构边界、增量依赖失效和显式未完成状态，保留 Source→Evidence→reviewed 的既有门禁。[LlamaIndex 当前 API](https://developers.llamaindex.ai/python/framework-api-reference/ingestion/)。

验收：一百份文档只改一份，不重新审核其余九十九份；删除或权限撤销后旧结果立即不可用于当前上下文；分页/上限必须在回执可见。这里优先做真实来源的一条完整链路，暂不堆几十个 connector 名称。

### P1：日常记忆整理仍需 Host 补足

**已有维护 API，自动效果未验证。** deep maintenance 当前产物是 content-free candidate；legacy consolidation 是传入摘要或拼接，不能等同于持续完成“抽取→归纳→比较旧记忆→验证→生效”。Letta 的 dreaming/doctor 是可参考的用户流程，但它由自己的 Host 执行；Craft 仅靠 MCP 暴露工具不会获得每轮触发保证。[Craft 维护](../../core/memory-maintenance.ts)、[Craft consolidation](../../core/memory-consolidation.ts)、[Letta 流程](https://docs.letta.com/configuration/memory)。

建议保留 Skill+MCP 可移植边界，以显式 checkpoint/end-task 协议和外部调度完成可重试整理；低风险、高证据项可走已有 governed policy，高风险仍留候选。验收看新会话是否能正确用到已整理记忆，而不是只看 maintenance 返回 completed。无需为了追平 Letta 引入强制 Hook 或重建一个完整聊天 Host。

## 两项隔离复现

运行环境为当前工作区 Node，使用 `mkdtemp` 的临时 CraftStore，finally 关闭并删除；仅写合成 fixture。2026-09-28 执行输出：

```json
{
  "history_view_ids": ["current"],
  "mixed_one_item": {
    "memories": ["current"],
    "knowledge": [],
    "knowledge_omitted": 1
  },
  "knowledge_only_one_item": ["specific-knowledge"]
}
```

可复跑核心（使用仓库内模块与 `CraftStore(craftPaths(tempRoot)).open()`，并在 finally 清理 tempRoot）：

```ts
store.create("knowledge_source", "s", { status: "active", trust: "verified" });
for (const [id, status, valid_until] of [
  ["current", "active", null], ["superseded", "superseded", null],
  ["revoked", "revoked", null], ["expired", "active", "2026-08-01T00:00:00Z"],
]) store.create("memory_ledger", id, {
  source_id: "s", scope: { kind: "project", id: "fixture" }, status,
  valid_until, effective_from: "2026-01-01T00:00:00Z", topic: id,
  content: "alpha", content_digest: id, kind: "preference", sensitivity: "internal",
});
store.create("knowledge_claim", "specific-knowledge", {
  source_id: "s", scope: "project:fixture", status: "reviewed",
  content: "alpha beta gamma", content_digest: "knowledge", evidence_ids: [],
});
const reader = new ContextResolutionKernel(store, [new KnowledgeContribution(store)]);
const args = { query: "alpha beta gamma", scope_kind: "project", scope_id: "fixture",
  now: "2026-09-28T00:00:00Z", max_items: 10, max_chars: 10000 };
await reader.resolve({ ...args, history_view: true });
await reader.resolve({ ...args, max_items: 1 });
await reader.resolve({ ...args, max_items: 1, members: ["knowledge"] });
```

此探针证明当前调用链的返回行为，不证明数据量增长时的性能，不代表对真实私有数据完成了验收。

## 建议先后顺序

1. 修清历史读取契约及实际返回；把检索原因标签改成事实名称。
2. 接通 Knowledge 的真实检索策略，并让混合 Context 有统一选材与预算规则。
3. 用真实代表性但隔离的数据集跑质量、泄漏、规模和成本；让 eligible 门禁引用可复跑结果。
4. 做一条来源的文档级增量、删除/权限变化链路，再补跨 Host 的整理触发与结果验证。
5. 多跳实体图、全面多模态、自动记忆自治可后置；当前优先级证据不足，不能为了功能矩阵把架构做大。
