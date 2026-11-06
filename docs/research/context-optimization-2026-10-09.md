# Context 与子能力优化验收

日期：2026-10-09。基于[源码与一手资料评审](context-industry-capabilities-2026-10-09.md)落实本地优化；发布版本保持 **0.12.39**。本记录区分 implementation、隔离验收和真实 Host 证据，后者没有因本地测试而自动成立。

## 验收合同与实现

| 验收条件 | 实现与测试入口 |
| --- | --- |
| 独立 Knowledge SDK 等待期间撤销 Claim/Source/Document/alias 或删除后不返回旧材料 | common-store-local 的 ContextReadGuard；KnowledgeContribution 在授权时保存精确依赖，await 前后复核；context-optimization、context-revocation-race |
| 相同 approved Memory 候选顺序或双进程重试只有一个 Ledger；替代或关联失败整体回滚 | MemoryGovernance 确定性身份与 Store 事务；memory-commit-optimization 注入替代与发布失败；保留不可变文件供同身份重试复用 |
| 必需材料无关键词命中仍可选入，省略计数非负（外部 contributor 非法计数拒绝）；Host/KME/code 总预算一致 | ContextBudget 和 WorkingSet.resolve 集中必选/选配、代码重平衡及总计数；context-working-set-budget、context-optimization；预算异常使用明确类型 |
| 当前/历史范围与记录时间先筛选，授权后才读正文，候选数量有界 | Store.listScoped 的时态选择和 512 条 metadata 游标分页（固定 rowid 水位）；Knowledge Claim 列表先验证 ACL/Source；context-candidate-scope、context-aggregation-policy、context-optimization |
| Source/Document 变更可限定反向依赖待重验 Claims，避免全量正文读取 | Store.list 的依赖 SQL 选择；Claim synchronize 与 SourceRegistry ingestion 使用 metadata；craft_knowledge_expiry_sweep 可传 source_ids/document_ids |
| 召回期间复核整个授权候选 corpus，发布后的 Receipt 只依赖最终材料及必要 Source/alias | scoped Guard 只固定适用材料与其依赖，在一个短事务中按 250 引用批量复核；selected read_refs 不包含未选候选；未选 Claim 修改不会使旧 pack 授权失效；context-read-snapshot 覆盖分页与批间跨进程写入 |
| 显式确认参与同版本 Memory 排序及维护，并发确认幂等，但不续有效期 | latestMemoryConfirmation 限定 id/version/digest 和时间；Resolver 与 Maintenance 接入；回执记录确认时间；memory-commit-optimization、context-optimization |
| 大仓库纯 query 切换不改变事实 Checkpoint/Index；分析不持有发布写事务 | repository-files 确定性事实选集，任务词只作用于索引视图；basic 与 TS/JS semantic 准备移出事务，发布复检禁用/Checkpoint/源码摘要；506 文件与准备后漂移负例 |
| 定位除词匹配外覆盖已有依赖邻域，明确 partial 与省略 | context-search 返回有界单跳 repo_map 和 lexical_match/dependency_neighbour；Open 只注入已扣预算的结构引用（kind/language/location/reason），不额外注入未预算的 graph edges |
| Host 发现、注入成本和结果可核对，缺证据不冒充真实收益 | [Host/Eval 验收](context-host-evaluation-acceptance-2026-10-09.md)：登记完整 MCP/原生 deferred 合同，原消融 Runner 可执行 observe_context；观测失败保留 pending、不重复任务执行 |
| Knowledge 检索相关与引用支持分开评测 | 现有 craft_knowledge_evaluation_run(mode=citation_support)，绑定 emission 与支持 Evidence；人工/程序标注不自动变成经校准的事实正确性 |
| Experience 失败建议受控进入 Candidate，跨入口/场景外拒用有独立评分 | 现有 Graph inspect/edit 动作；真实非成功 Outcome → pending_review → 磁盘 draft 对照 → CAS submit；不改正式指针、不增加执行器 |

ADR-0016 的 Claim 归属示例已按当前 Knowledge SDK 更新；ownership 与产品投影不同的原则保持。

## 可复现检查

`tests/coverage-gates.json` 将新增负例纳入原有行为门禁，并要求行、分支、函数覆盖率均 100%。本轮验证只覆盖受影响门禁，不声称全仓遗留代码已有 100% 覆盖。

```sh
node --test --test-isolation=none --test-concurrency=1 tests/context-optimization.test.ts tests/context-revocation-race.test.ts tests/memory-commit-optimization.test.ts tests/codebase-view-lifecycle.test.ts tests/context-working-set-budget.test.ts tests/context-host-evaluation.test.ts tests/component-ablation-execution.test.ts
pnpm run typecheck
pnpm run build
node scripts/smoke/component-conformance.ts
node scripts/release/check-plugin-package.ts
node scripts/ci/audit-layering.ts
node scripts/ci/audit-surfaces.ts
```

受影响的 **11 个覆盖门禁全部通过**；重复出现在不同门禁中的测试不累计为独立用例。

| 门禁 | 行为测试 | 覆盖率 |
| --- | --- | --- |
| context-revocation-race | 39/39 | 行/分支/函数 100% |
| knowledge-contribution | 86/86 | 行/分支/函数 100% |
| common-store-local-package | 177/177 | 行/分支/函数 100% |
| universal-runtime | 193/193 | 行/分支/函数 100% |
| memory-governance | 57/57 | 行/分支/函数 100% |
| observability-memory | 56/56 | 行/分支/函数 100% |
| control-plane | 69/69 | 行/分支/函数 100% |
| repository-context-products | 92/92 | 行/分支/函数 100% |
| context-remediation | 134/134 | 行/分支/函数 100% |
| context-host-evaluation | 12/12 | 行/分支/函数 100% |
| component-ablation | 21/21 | 行/分支/函数 100% |

类型检查、构建、层级/工具面/文档/版本及插件包检查通过。五个产品的冷 stdio MCP 初始化、tools/list、真实业务调用通过，共 103 次调用；host_session_verified=false。新增生产文件没有 coverage inventory 遗漏；全仓仍存在 196 个既有覆盖欠账模块，不把本轮受影响门禁当作全仓覆盖证明。

独立复核还补齐了 Source 缓存饱和时的授权依赖、跨进程分页漂移、批间撤销、alias 捕获错版本及并发确认；相应负例进入 context-optimization/context-read-snapshot/memory-commit-optimization。Host 观测必须沿真实 TaskRun → WorkLaunch → TaskControl → Task 记录链绑定，Pack 与 Working Set 的任务、会话、作用域与材料一致；1038 工具的完整注册合同通过。

本次任务启动使用的 Native Context 回执：`context_resolution_06b5021bc4c741829bcfafab140ad6d3`，Pack：`context_pack_a48a400130ce2ea09a7b4766`（basic/partial）。它来自启动时的缓存插件，仅作召回记录，不作为本轮源码修复或模型收益的验收凭据。

## 证据边界

- Hooks 可选，Skill + MCP 独立合同保持；本地打包或冷 MCP 成功不证明正在运行的 Codex/Claude/dsh 会话已重载。
- 500 文件、8 MiB 总量及单文件上限保持；未索引区域明确 omitted，basic 没有分析出的关系不伪造。外部 language server 的完整工程语义与真实 Host/model 任务效果仍需对应环境验收。
- Host 注入/Schema/history token、费用和正文摘要是绑定任务的 Host 报告；实际模型使用未知，费用未知时是 null。max_tokens 限制材料投影的估计值，不包含协议 envelope、完整 Host 消息正文或平台实际计费。
- Memory 回滚后的不可变文件用于恢复；永久放弃重试可能留有未引用文件。本轮没有自动全局 GC，避免误删历史证据。
- Experience 泛化验收区分路由判断与完整任务终态；失败位置不等于根因，建议不会自动晋级正式 Graph。
