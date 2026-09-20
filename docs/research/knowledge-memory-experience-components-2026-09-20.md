# Knowledge、Memory、Experience 单点能力调研与设计结论（2026-09-20）

## 范围

本调研回答三个问题：三个组件单独挂到 Codex 是否有产品价值；怎样证明它们确实改善工作；以及它们如何受控地长出 Workflow。资料优先使用官方文档、开源项目的一手仓库和论文原文；预印本不作为生产有效性证明。

## 可核验事实

1. Anthropic 将 Agent Eval 区分为 Task、Trial、Trace、Outcome、Harness 与 Suite，并强调 Outcome 是环境最终状态，不是 Agent 的完成自述；随机性需要多次 Trial，环境应隔离以避免相互污染。[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
2. OpenAI Agents SDK 将 Trace/Span 用于记录 Agent、模型、函数工具、Guardrail 和 handoff，并提示敏感数据是否进入 Trace 需要显式配置；其测试文档明确将确定性 test double 与真实外部 Provider/Sandbox 验证分开。[Tracing](https://openai.github.io/openai-agents-python/tracing/) · [Testing](https://openai.github.io/openai-agents-python/testing/)
3. Google Agents CLI 将生成、评分、比较、失败聚类分析分成可重跑阶段；其指标包含工具选择、参数、轨迹质量和多轮任务成功，不止最终文本质量。[Evaluation Guide](https://google.github.io/agents-cli/guide/evaluation/)
4. Mem0 的开源 benchmark 把记忆系统拆为 ingest、search、evaluate，并用语义、BM25 与实体信号组合检索。这说明向量是可替换的检索 Adapter，不应取代 scope、来源、冲突和撤销账本。[memory-benchmarks](https://github.com/mem0ai/memory-benchmarks)
5. WikiSkill、SkillWiki 等 2026 论文提出“原始轨迹 / 持久知识 / 可执行 Skill”分层，以及从经验生成技能；它们仍是研究证据，不能替代 Craft 的 held-out、Signoff 和 Canary 门禁。[WikiSkill](https://arxiv.org/abs/2608.27454) · [SkillWiki](https://arxiv.org/abs/2606.16523)

## 对 Craft 的推论

- **知识**要解决可复核事实，不解决“把所有材料记下来”。它必须用来源 digest、Evidence、时效、冲突和 scope 保住可追溯性。
- **记忆**要解决有边界的长期上下文，不解决聊天归档。缺少 scope 时跳过比猜测全局 scope 更可靠。
- **经验**要解决“何种改变值得重复”，不能直接给执行 Agent 注入未验证的复盘内容。它应通过可执行的、版本化 Workflow/Skill 派生价值。
- **Context**只是给某个 Host 的预算化投影；Receipt 是复现/诊断依据，不是另一个知识库。
- **默认工具面应小**。单独组件的日常路径不应要求模型从几十个生命周期与诊断工具中猜下一步；完整高级面仍应保留给人工、自动化和兼容调用。

## 当前实现审查与 v0.12.34 收口

截至本次审查，Craft 已有 KnowledgeSource、Claim、MemoryLedger、Context Resolution Receipt、Experience Observation、Workflow Draft 与 Gate 模块，也有确定性 Fixture。但本地真实数据没有已写入的 `memory_ledger`、`experience_observation` 或 `experience_pattern`，因此不能声称插件已经给 Codex 带来可测收益。

本次收口：

- `craft-knowledge`、`craft-memory`、`craft-experience` 的 public product 改为小型 daily surface；显式 `component-*` 保留完整高级面。
- 新增无正文 `craft_component_readiness_get`，报告前置条件、记录数、下一安全动作以及 `model_effect_proven: false`。
- Memory Maintenance 优先评估受管 Ledger；Legacy episodic 仅在 Ledger 为空时兼容读取。
- 用固定代码/文件 Fixture 先验证机制，再以同 Host/model/环境/预算的 3–5 次 baseline/candidate 配对 Trial 验证是否真的提升 Outcome。

## 非结论

本调研不证明：任何向量模型优于关键词、自动生成 Workflow 一定提升质量、独立组件必然改善 Codex、或研究论文可以替代真实业务评测。这些都必须由后续脱敏 Case 与真实 Host 对照运行给出证据。
