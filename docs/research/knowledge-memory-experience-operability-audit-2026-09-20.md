# Knowledge、Memory、Experience 可运行性审计（2026-09-20）

## 范围与结论

本记录审计三个可独立安装的 Craft 产品：`craft-knowledge`、`craft-memory`、`craft-experience`。结论是：当前本机已经有历史知识正文，但它尚未成为可供日常 Context 使用的已复核知识；Memory 与 Experience 也尚未积累到可证明收益的程度。问题不只是“没有数据”，还包括产品入口、读取路径和已安装版本之间的断链。

## 本机已验证事实

- Codex 已启用三个插件，但缓存包是 `0.12.33`；工作区的 `0.12.34` 日常精简工具面尚未成为用户实际运行的包。
- `~/.craft_data/knowledge/md/` 有 53 个历史迁移正文，主库有 53 条 `knowledge_claim`；它们全部是 `candidate`，没有 `reviewed` Claim。
- 历史导入没有丢失正文：正文是版本化 Markdown，索引持有 `content_ref` 和 digest。但导入只创建候选，符合“不自动信任历史内容”的安全边界。
- `craft_knowledge_search` 查询的是由 `craft_knowledge_index_sync(project_root)` 建立的项目 Markdown FTS 投影，不查询 `knowledge_claim`；迁移正文不在该投影中。因此“Knowledge 没有命中”不能被解释为“没有历史知识”。
- `wikiContextCompile` 只接受 `reviewed` Claim，且目前读取旧的 `claim.content` 内联字段；新内容存储把正文放在 `content_ref`。任何把新格式 Claim 复核为 `reviewed` 后的 Context 编译都需要读取 Content Store，不能继续依赖内联字段。
- `ContextResolutionKernel` 当前选择 `memory_ledger`，并可附带 Experience 的内容无关引用；它没有选择 Knowledge Claim 的贡献者。因此默认 Context Receipt 不是三者统一的实际读取闭环。
- 本机没有 `memory_ledger`、`memory_candidate`、`memory_usage_signal`、`experience_pattern` 或 Workflow Proposal；只有 3 条 Workflow Evolution Observation，且 scenario 各不相同，不能满足“同场景两条独立观察”这一草案前提。
- 现有 `craft_project_bundle_export` 只是带 digest 的引用清单，没有 Bundle 文件内容导出、导入或冲突合并。因此它不能解决两台机器的数据同步。

## 组件契约应收敛为

```text
Knowledge Source / reviewed Claim ┐
Memory Ledger                     ├─ KnowledgeMemoryResolver ─ Context Receipt ─ Host
verified Experience routeability ┘

Trace / Outcome ─ Observation ─ Pattern ─ Workflow Candidate ─ Eval / Signoff / Canary
```

`craft_knowledge_search` 应明确是“外部 Markdown Source 的 FTS 搜索”；受管 Claim 应由独立的 `KnowledgeMemoryResolver` 检索，并在 Receipt 中保留 Claim 版本、正文 digest、来源、scope、选择理由和遗漏理由。Memory 与 Knowledge 的 scope 必须为结构化 `{kind,id}`，不应让 Host 仅传模糊字符串。

## 跨机器建议：不要合并 SQLite 文件

SQLite/WAL 是本机事务与索引，不是同步协议。应增加一个 `CraftDataBundle` 深模块：

1. `export`：导出版本化 Markdown 正文、最新不可变领域记录、Evidence/Artifact 引用、Schema 版本、来源 digest、设备/导出 ID；Trace 全文和受限正文默认不出包。
2. `verify`：校验 Manifest、正文 digest、签名（若配置）与兼容版本。
3. `import --dry-run`：只展示新增、重复、冲突、过期、不可移植的环境/凭据引用。
4. `merge`：Knowledge、Memory、Observation 均追加版本，不使用 last-write-wins；冲突创建 Conflict Set。撤销优先于使用，跨 scope 不合并，Workflow/Canary 必须在目标机器重新评测。
5. Storage Adapter：本地目录/Git、受信任对象存储或用户配置的同步盘只承载加密 Bundle；Craft Core 不保存凭据。

## 评测建议

先建立固定的脱敏编码和文件交付 Case，再做真实 Host 的配对试验：同 Case、Host、模型版本、环境指纹、能力版本和预算，只改变一个变量。

- Knowledge：Recall@K、Evidence 覆盖、时效/冲突、跨项目泄漏率（必须为零）、终态提升。
- Memory：写入精确率、召回 Precision/Recall、过期/撤销/冲突拒绝、跨 scope 泄漏率（必须为零）、重复失败下降、Token/延迟。
- Experience：候选重复率、Shadow/Held-out 回归、Pass@1、Pass^3、成本、恢复率和 Canary 退化。

确定性 Fixture 只能验证机制；真实模型、真实 Host 和真实 Outcome 才能证明产品收益。主观质量可用校准后的 Judge 或人工盲评诊断，但不能替代确定性的终态验收。

## 外部资料

- Anthropic 对 Agent Eval 的 Task/Trial/Trace/Outcome/Harness/Suite 定义，以及多 Trial 和隔离环境：[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- OpenAI 将可脚本化运行时测试与真实 Provider/Sandbox 集成测试分开：[Testing](https://openai.github.io/openai-agents-python/testing/)，并以 Trace/Span 记录一次端到端运行：[Tracing](https://openai.github.io/openai-agents-python/tracing/)
- Google 的 `generate → grade → compare → analyze` 评测闭环：[Evaluation Guide](https://google.github.io/agents-cli/guide/evaluation/)
- Mem0 的记忆评测将 ingest、search、evaluate 分层，并比较混合检索的端到端结果：[memory-benchmarks](https://github.com/mem0ai/memory-benchmarks)
- WikiSkill 的“原始经验 / 持久知识 / 可执行 Skill”三层是值得借鉴的研究方向，但仍不是生产发布 Gate 的替代品：[WikiSkill](https://arxiv.org/abs/2608.27454)

## 非结论

本记录不证明历史候选正确、向量必然优于关键词、自动生成 Workflow 有业务收益，或当前三个组件已经改善 Codex。上述结论均需要按本记录的真实 Host 配对评测获得。
