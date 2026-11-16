# ADR-0030：概念标签落盘、类型化关系与诊断式一致性

状态：Accepted

## 背景

ADR-0029 建立了六概念分类与写入校验，但它是"只校验、不落盘"的过滤器：
`validateConcept` 的结果被丢弃，记录里没有 `concept_kind`。于是下游 context
装配看不到概念、知识图谱无法识别节点概念、自进化 Mod 也不挂概念——本体论只
优化了写入端可读性，没有参与召回与推理。

## 决策

1. **概念标签作为非身份元数据落盘。** Knowledge claim、Memory candidate/ledger、
   Experience procedure、自进化 Mod 写入时把 `concept_kind` 存进记录，但**不进
   identity digest**。加强分类不使旧记录失效；历史记录允许没有标签。
2. **类型化关系约束放在共享包。** `craft-common-ontology` 新增 `RELATION_KINDS`
   与 `RELATION_TYPES`，声明每种关系允许的概念端点。`checkRelationConcepts` 是
   **软校验**：端点概念未知（历史数据）时通过；两端都已知且约束排除时才失败。
3. **失效传播读取概念标签。** `craft_knowledge_lineage_impact` 报告每个节点的
   `concept_kind` 及 `type_issues`（违反类型约束的关系），仍是只读、有界、
   零模型调用。
4. **概念进入 context 装配。** Knowledge/Memory 的检索项携带 `concept_kind`；
   core 投影附加 `concept_selection_reason`（人和模型都能读懂的选中理由）。
   这是**附加投影**，不改变排序、不改变 receipt digest。
5. **跨记录一致性是诊断，不是门禁。** `checkConceptConsistency` 报告同一 term
   多定义、互斥 rule，但不删除、合并或改写任何记录。
6. **长正文复用可读性契约。** `validateConceptBody` 对 Mod overlay 复用空泛词/
   指代校验，但不套用 300 字符上限（规则正文可到 20k）。

## 原因

这直接回应研究报告点名的"可选 Typed Ontology Adapter"缺口：给既有 lineage 图
加一层轻量、可选的类型约束，而不是新建全局本体树。所有能力仍保留自己的治理
流程，共享包只提供词汇与诊断。

## 非目标

- 不做全局强制分类树；不把推理结果写成事实。
- 不改变任何组件的写入/发布门禁；历史数据不回溯。
- 不把 concept 变成排序权重；`concept_selection_reason` 只解释，不决策。

## 后果

新增记录带 `concept_kind`，旧记录读取兼容。craft-eval 的 `CraftServiceShim`
同步为真实映射与类型约束的实现，使 `knowledge_lineage.typed_relation_flags_incompatible_concepts`
成为可复现的确定性评测（fact/term 的 `contradicts` 被报告，fact/fact 不报告，
关系数量不变）。
