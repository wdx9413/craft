# Verified Work Loop、知识与记忆：v0.12.18 架构调研

> as_of: 2026-09-14
> 范围：回答九段工作循环是否属于 Codex、`kefu_llm_wiki` 应如何进入 Craft、以及 Craft 的知识与记忆现状和收敛方向。
> 证据规则：标为“外部事实”的内容来自一手资料；标为“代码事实”的内容来自本机 `craft` 与 `kefu_llm_wiki`；标为“建议”的内容是架构推论，不代表已经实现或已证明业务收益。

## 结论先行

1. `意图 → 条件澄清 → 最小激活 → 预检 → 执行 → 再观察 → 验收 → 埋点/评测 → 受限演进` **不是 Codex 固定流程**。它是 Craft 将通用 Agent tool loop、可靠执行和评测治理组合出的 **可选 Verified Work Protocol**。
2. `kefu_llm_wiki` 的核心知识治理逻辑已经有大半以更强的证据/评测形式存在于 Craft；不应复制 Python MCP 或再建第三个 Wiki。应把 Craft 的 Evidence Knowledge 作为默认内置组件，把 `kefu_llm_wiki` 做成可审计的**迁移/外部来源 Adapter**。
3. Craft 不是没有记忆：已有 `memory_item`、`episodic_memory`/`semantic_memory`、Project Brain、Work Session、Checkpoint 和 Serena 项目记忆适配。但它们目前存在两套记忆账本和多个未统一的检索入口；下一步重点是**统一生命周期、出处、权限、失效和检索评测**，而不是先接向量库。

## 1. 九段循环：不是 Codex 特有，应该是通用且可跳过的协议

### 外部事实

- [OpenAI：Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) 将 Codex 的基础循环描述为：用户输入、模型推理、工具调用、工具输出回灌、重复，直至最终回复或追问。它没有规定九段业务状态机。
- [OpenAI Agents SDK：Tools](https://openai.github.io/openai-agents-js/guides/tools/) 支持依据 Run 条件启用工具；这证明“按需暴露能力”可实现，但“最小激活”是产品策略，不是 SDK 强制语义。
- [OpenAI Agents SDK：Guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/) 支持工具调用前后检查和阻断；[Running Codex safely](https://openai.com/index/running-codex-safely/) 区分 Sandbox 与 Approval 边界。这对应预检/受控执行，但不自动给出领域验收。
- [OpenAI Agents SDK：Tracing](https://openai.github.io/openai-agents-js/guides/tracing/) 将模型、工具、交接、Guardrail 与自定义事件纳入 Trace。
- [Anthropic：Agent Evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) 明确 Outcome 是 Trial 结束时环境的真实最终状态，而非 Agent 说“已完成”；Harness 负责运行、记录、评分、聚合。Google 的 [Harness Engineering](https://developers.googleblog.com/the-anatomy-of-harness-engineering-how-to-evaluate-iterate-and-guard-ai-coding-agents/) 也把“信息不足先澄清”“修改后运行验证器”视为可评测行为。

### 正确的产品分层

```text
所有 Host 都可实现的 Agent Turn
输入 → 推理 → 0..N 次工具调用/结果回灌 → 回复或追问

需要可靠交付时才启用的 Verified Work Protocol
意图 → [澄清] → [最小激活] → [预检] → 执行
     → 再观察 → [验收] → [埋点/评测] → [受限演进]
```

方括号表示条件阶段，而不是每个对话必走的流程：

| 任务 | 必要阶段 | 不应强加的阶段 |
| --- | --- | --- |
| 简单问答/解释 | Agent Turn、必要时澄清 | 预检、验收、评测、演进 |
| 只读检索/分析 | 最小能力激活、来源/版本观察 | 写入审批、事务补偿 |
| 文件或代码修改 | 预检、执行、再观察、验收、Receipt | 默认多 Agent、长期 Campaign |
| 外部写入/高风险动作 | 明确审批、Effect Policy、再观察、验收、补偿/人工处置 | 静默执行或以模型自述结案 |
| Harness 改造 | 固定 Case/环境/预算、重复 Trial、Signoff | 直接修改默认 Prompt/Skill/拓扑 |

**建议**：继续保留 `Task / State / Policy / Receipt / Evidence / Outcome / Eval Gate` 为稳定内核；将九段命名为 `VerifiedWorkLoop` 的“可靠性协议”。Codex、Claude、Serena、MCP、Skill 都是 Host 或 Capability Adapter，不能把某个宿主当前行为固化为产品内核。

## 2. `kefu_llm_wiki` 与 Craft：应收敛，不应整体搬运

### 代码事实：`kefu_llm_wiki` 已解决什么

`/Users/didi/Documents/kefu_llm_wiki` 是一个小而清晰的共享知识库：

- `data/pages/**/*.md` 是正式知识的事实源，SQLite 是可重建的确定性检索索引；
- 知识先写结构化 Draft，再经 AI Review，只有 `reviewed_promote` Draft 才可 Distill 为 Confirmed Page；支持 Retract；
- 捕获时要求知识类型、证据类型/引用、复用理由、scope 与有效期，并拒绝计划、会议纪要、个人材料、秘密和原始对话；
- 离线 Skill Evolution 使用 `trace → proposal → 外部目标评测 → gate → accepted/rejected → rollback`，通过内容哈希防止覆盖并发修改。

它的边界也很明确：不运行模型、不执行评测命令、普通搜索不触发演进；Skill Gate 主要比较通过数、回归数和 Token 预算。

### 代码事实：Craft 已有的对应能力

| `kefu_llm_wiki` 能力 | Craft 当前对应 | 判断 |
| --- | --- | --- |
| Evidence-backed Draft/Review/Confirmed Page | `knowledge_claim`（candidate/reviewed 等）、`wiki_page`、`knowledge_relation`、`wiki_context_bundle` | 已覆盖且可引用 Craft Evidence、版本、scope、有效期 |
| Markdown 人工可读事实源 | `~/.craft_data/wiki/<page>.v<version>.md`；数据库保存摘要与审计元数据 | 已覆盖，但存储位置不同 |
| 检索、Context 编译、知识绑定执行 | `wikiContextCompile`、Knowledge-bound Work Launch、Knowledge Evaluation | Craft 更完整：精确 Claim 版本、执行前再校验、Recall/Evidence Coverage 评测 |
| Skill/Workflow 候选 | `wiki_skill_candidate` + evaluation attestation + publication authorization/package | Craft 已有更完整 Gate，不应引入第二套 Gate |
| 离线 Trace/Proposal/哈希回滚 | Trial/Trace/Outcome、Candidate、Signoff、Canary、精确版本/摘要校验 | 保留 Craft 原生实现；可借鉴 Wiki 的外部文件哈希保护 |
| 项目 Markdown/Serena 记忆 | `ProjectKnowledgeKernel` 发现/解析 `.serena/memories`，1–3 条、摘要固定、只读 | 已有正确的窄边界 |

静态只读检查还发现：本机 `~/.craft_data/db/craft.db` 已有这些记录类型的表结构，但截至本次检查没有 `knowledge_claim`、`wiki_page`、`memory_item`、`episodic_memory`、`semantic_memory` 或 Project Brain 记录。这说明**能力已存在，真实知识/记忆资产尚未开始沉淀**；不能把“有模块”误称为“已有可用知识库”。

### 建议：默认内置 Knowledge Core，`kefu_llm_wiki` 做 Adapter

```text
Craft Evidence Knowledge Core（唯一治理与评测 Gate）
  ├─ 内置 Craft Wiki Source
  ├─ Serena Project Knowledge Source（只读）
  ├─ 项目 Markdown/README/AGENTS Source（只读、按 scope）
  └─ kefu_llm_wiki Legacy Source / Import Adapter（只读优先）
```

具体边界：

1. **默认内置，不默认注入。** Evidence Knowledge 应随 Craft 提供，但只有 Task、scope、权限、版本和 Context Budget 都匹配时才进入 Context Profile；不能把全部项目/全局 Wiki 塞进模型上下文。
2. **先接只读来源，后做一次性导入。** Adapter 枚举 Confirmed Page 的路径、摘要、项目/category、证据引用和状态。人选定后才复制为 Craft Claim/Page，并保留 `source_uri`、源摘要和导入时间；源变更进入 `needs_replan` 或待复核。
3. **不直接提升旧 Draft。** Wiki 的 Draft、Rejected、Promoted-Draft 和旧 Skill Proposal 只能作为候选材料，不能因为历史 Review 自动获得 Craft `reviewed`、发布或执行权。
4. **不搬 Python 服务。** `kefu_llm_wiki` 的 Markdown 约束、敏感内容边界、Review/Distill/Retract 语义值得复用；其 MCP、SQLite 索引器和 Skill Gate 代码不应复制，否则会有两份 Search、两份证据状态、两套发布/回滚事实。
5. **只保留一条能力演进链。** 外部 `SKILL.md` Publisher 可以借鉴 Wiki 的“目标现有内容必须仍匹配基线摘要”保护，但认证、held-out、Signoff、Canary 和回滚必须继续由 Craft 的 Gate 决定。

## 3. 知识不是记忆：建议的六层模型

| 层 | 回答的问题 | Craft 现状 | 正确所有者 |
| --- | --- | --- | --- |
| 当前工作状态 | “这一步要做什么，环境现在怎样？” | Task、Work Session、State Snapshot、Receipt、Checkpoint | Control/State Kernel，不叫记忆 |
| 项目知识 | “这个仓库/项目有哪些约定与背景？” | Project Brain；只读 Serena `.serena/memories`；可索引 Markdown | Project Knowledge Source，按项目/版本/权限 |
| 证据化事实知识 | “哪些规则、故障结论、决策可以复用？” | `knowledge_claim`、Wiki Page、Evidence、关系、Context Bundle、Knowledge Eval | Evidence Knowledge Core |
| 情景记忆（episodic） | “上次在相近情境发生了什么？” | `episodic_memory`、Trace、Outcome、Checkpoint | Memory Ledger，必须带出处、scope、TTL |
| 语义/偏好记忆 | “用户或工作空间长期偏好/稳定选择是什么？” | `memory_item`（fact/preference/decision/experience）和 `semantic_memory` | Memory Ledger，用户可见可纠正 |
| 程序经验 | “什么策略/Workflow/Skill 已在何种条件下验证有效？” | Experience Pattern、Workflow、Skill Candidate、Script Proposal | Evaluation & Evolution Plane，绝不由普通记忆直接执行 |

这一区分很重要：Task State 必须是事实源；Evidence Knowledge 必须可质疑和撤销；Memory 是有限范围的经验/偏好；Procedure 必须经过评测。把它们统称“长期记忆”会导致模型把过期笔记、个人偏好和验证结论混为一谈。

### 代码事实：当前记忆的优点和缺口

已有优点：

- `memory_item` 支持 `fact/preference/decision/experience`、user/workspace/task scope、来源、Evidence、有效期、替代和 supersede/expire/reject；`ContextProfile` 能按 scope、种类、预算和必选项装配。
- `MemoryConsolidationKernel` 能把 `episodic_memory` 合并为 `semantic_memory`，保留来源 Episode；Project Brain 保存目标、资料引用、决策、Outcome 和候选 Experience；Serena 解析限定 1–3 条项目记忆、摘要固定且不自动写回。

主要缺口：

1. **两套记忆账本未统一。** `memory_item` 与 `episodic_memory`/`semantic_memory` 的状态、证据、scope、检索和废弃语义不同；这会使同一事实被重复保存、更新后只失效一边。
2. **检索与 Context 入口分散。** `ContextProfile` 装配 `memory_item`，而 `memory_search` 只搜 `semantic_memory`；Project Knowledge 与 Wiki Context 又各自独立。没有一个统一的“本次为何选择/排除这些信息”的跨来源 Receipt。
3. **缺少一等的记忆治理。** 已审代码中 `memory_item` 写入路径未见与 Knowledge Claim 同等级的敏感文本校验、审阅/置信分层、冲突关系、可见的 list/export/forget API 和检索质量评测。文档提出这些目标，但不应当作已实现。
4. **没有真实运营数据。** 当前本机 Craft 数据库还没有上述知识/记忆记录；无法判断自动整理、排序或向量检索的真实收益。

## 4. 推荐的收敛顺序（比先上向量库更重要）

### P0：定义一个 `KnowledgeSource` 与一个 `MemoryLedger` 契约

- `KnowledgeSource` 至少固定：`source_id/type/owner/scope/trust/content_digest/version/expiry/evidence_refs/permissions`，支持 Craft Wiki、Serena、项目 Markdown 和 `kefu_llm_wiki`。
- `MemoryLedger` 统一 episode、semantic、fact、preference、decision、experience 的公共字段：来源、适用条件、scope、TTL、置信、Evidence、替代/冲突、删除与导出权。保留旧记录类型的兼容读取，再逐步迁移，不做破坏性重写。
- 新增一个 `Context Resolution Receipt`：固定所选的 Knowledge/Memory/Project Note 精确版本、选择理由、预算、排除理由与失效条件。它只做选择，不授予 Tool/写入权限。

### P1：将 `kefu_llm_wiki` 变成受控来源

- 实现 `discover → diff → selected import → revalidate`；默认只读，默认不递归读取 Draft/演进目录。
- 将 Page 的项目/category 变为可过滤 metadata，不把它们固化成全局行业分类或强制路由。
- 给迁移写专门的 fixture：重复标题、源摘要漂移、撤回页、过期页、无证据页、敏感文本、跨项目污染。

### P2：让记忆变得可验证而非“越存越多”

- 用户可查看、纠正、禁用、导出、按 scope 忘记；敏感数据默认拒绝或仅留安全引用。
- 为 Memory/Knowledge 分别维护 development 与 held-out Recall、Precision、过期命中、跨项目泄漏、必选约束遗漏和人工纠正成本 Case；向量检索只是该评测通过后可选的 `Retrieval Adapter`。
- 只有多次有 Evidence 的 Outcome 才可生成 Procedure Candidate；普通 memory 永远不能直接改变 Prompt、Skill、Workflow、权限或默认多 Agent 拓扑。

## 5. 本次不建议做的事

- 不把所有 `kefu_llm_wiki` 页、Serena 记忆、README 或聊天记录自动复制到 Craft；这会造成过期、敏感信息和跨项目污染。
- 不先做“全局知识图谱”“静态行业树”或默认向量数据库。它们是检索/展示实现，而不是可信事实或权限模型。
- 不把记忆等同于永久上下文；模型每次只获得有预算、有版本、有选择原因的最小 Context Capsule。
- 不把旧 Wiki 的 Review 或单次 Skill Gate 等同于 Craft 的 `verified`、Signoff 或发布权。

## 可验收的下一版定义

当下列事项有测试和真实脱敏数据证据时，才可称为“知识与记忆平台收敛完成”：

1. 一个 Craft Wiki、一个 Serena 项目记忆、一个 `kefu_llm_wiki` Confirmed Page 能以同一 Source 契约发现、选择、固定版本、再校验和失效；
2. 同一条事实不会同时作为 `memory_item`、`semantic_memory` 和 `knowledge_claim` 被静默当作三个权威版本；
3. 每次 Context 都能解释选择了什么、为何选择、何时失效以及是否拥有 Evidence；
4. 人工更正/撤回、源文件改变、权限变化或 TTL 到期后，旧上下文不能继续用于执行；
5. 引入向量/重排/自动整理前后，能在固定 Case 上比较召回、错误引用、泄漏、成本和人工纠正，而不只比较“回答看起来更像”。
