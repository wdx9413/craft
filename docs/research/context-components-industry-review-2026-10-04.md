# Context 与四子能力：代码审查和业界能力对照

日期：2026-10-04。范围：`craft-context`、Knowledge、Memory、Experience、Codebase，以及 Skill + MCP / Codex / Claude / dsh 的接入边界。

本报告记录本次审查开始时的代码基线。主任务会继续修复，因此这里的“现存缺陷”是发现时的结论，最终修复状态以主任务交付记录和回归结果为准。本报告只新增文档，未修改运行时代码、安装插件或上线。

## 判断

当前实现已经具有受治理的知识与记忆、可组合 Procedure、多入口/出口、持久 Invocation、自动仓库索引，以及五产品四种分发方式。主要不足是能力之间的接线、检索完整性和跨宿主使用成本。继续增加一套图数据库或执行器，不是当前最小有效改进。

优先修复策略参数传递、Memory 维护的权限过滤、已跟踪文件的忽略规则、跨能力同文去重；随后补齐有范围的候选检索、按任务分配上下文预算。长期任务的回执重检、大仓聚焦和动态工具发现适合作为增量增强。

## 业界事实与适用边界

| 一手来源 | 已核实事实 | 对 Craft 的意义 |
| --- | --- | --- |
| [Anthropic：Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 建议以轻量引用按需读取材料，结合预检索、运行时探索、压缩和结构化笔记。文章发布于 2025-09-29。 | Context 应提供小而有用的首包、进一步读取入口和重新检查条件；不必预先装入所有上下文。 |
| [Cursor 当前 Search 文档](https://cursor.com/docs/agent/tools/search) | 当前文档描述本机 Instant Grep、正则/符号搜索与 Explore 子代理；支持多根上下文，但部分功能和 Cloud Agents 有限制。 | 符号索引可以与有范围文本搜索互补，多根支持需要明确能力矩阵。 |
| [Cursor 当前 Ignore 文档](https://cursor.com/docs/reference/ignore-file) | 支持项目及全局忽略、Git ignore 语法；明确终端和 MCP 工具不能由 `.cursorignore` 自动阻止读取。 | Craft MCP 必须自行执行已声明的读取边界，不能依赖宿主忽略设置。 |
| [Graphiti 官方仓库](https://github.com/getzep/graphiti) | 事实带有效时间窗口和来源 episode，支持时序变更、来源追溯与混合检索。 | 可借鉴依赖失效与来源追踪，不等于必须引入其数据库或自动事实合并策略。 |
| [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | 分开提供线程 checkpoint 和跨线程 store，支持中断恢复；提醒长期 checkpoint 累积需要保留策略。 | Craft 的长期积累、任务状态和 Invocation 应继续分工，补齐回执与状态的复用期限即可。 |
| [Claude：Manage tool context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context) | 区分按需工具发现、程序化调用、提示缓存和旧工具结果清理；提示缓存降低重复成本但不减少上下文长度。 | dsh 桥接应避免每次返回全部 schema；宿主能力不同，不能把某厂商的 `defer_loading` 当成 MCP 通用字段。 |
| [MCP 2025-11-25 Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | `tools/list` 支持分页，可返回结构化结果、可选输出 schema 和资源引用；工具名在单服务内唯一。 | 可提供分页、紧凑发现和精确资源引用；无分页的固定小工具面本身不构成协议违规。 |

检索到的 [Cursor 历史索引文章](https://cursor.com/blog/secure-codebase-indexing) 描述了当时的 embedding 索引实现，而当前 Search 文档已描述另一条默认搜索路径。因此本报告不将旧文章的上传或向量化方案描述成 Cursor 当前默认能力，也不借用供应商性能数字证明 Craft 的效果。

## 1. P1：聚合与维护路径没有完整保留访问策略

类型：已确认的实现缺陷。涉及 Context、Knowledge、Memory、Experience。

代码依据：

- [repository-context.ts](../../core/application/use-cases/repository-context.ts) 的 `openContext` 只向 `contextResolutionResolve` 传递 query、scope、预算和 members，未传递现有 `principal_id`、`principal_ids`、`tenant_id`、`cognitive_purpose`。有明确 ACL 的材料会因此被拒绝，表现为“独立能力能查到、聚合查不到”。这是可用性错误，不能据此声称该入口已证明跨租户泄漏。
- [context-resolution.ts](../../core/context-resolution.ts) 将 `scopeAccess()` 结果以 `...access` 传给 contributor，其中用途键为 `purpose`；[Knowledge contributor](../../capability/craft-knowledge/contribution.ts) 与 [Experience contributor](../../capability/craft-experience/contribution.ts) 读取的是 `request.cognitive_purpose`，导致用途过滤丢失。
- [memory-maintenance.ts](../../core/memory-maintenance.ts) 的条件为 `scope === null || scopeMatches && scopeAllows`，省略 scope 就跳过 ACL；返回 run 的 `memory_ids` 和 findings 能透露未授权记录标识。其 legacy/semantic 分支也应同样检查。

隔离复现：临时数据库中建立 Alice / tenant-a 的私有记忆，由 Bob / tenant-b 不带 scope 调用维护，实际得到：

```json
{"case":"unscoped_maintenance_with_other_principal","memory_ids":["private-alice"]}
{"case":"contributor_purpose","received_purpose":"preference","received_cognitive_purpose":null}
```

最小实现：复用现有 `ScopeAccess`，统一 contributor 用途字段；聚合仅显式转发允许的参数，远程身份仍来自已认证传输层；无 scope 不能绕过 ACL。不要把模型提供的身份文本升级成真实认证。

验收：同一 fixture 分别从独立 MCP 与聚合入口请求；正确 principal 可见，错误 principal/tenant 不可见；无 scope 维护不返回其他人的 ID、数量或候选；purpose 对三成员一致生效。MCP 官方安全文档将范围最小化与代理身份边界单独讨论，支持继续保持认证和业务作用域分层，不能用一个字段替代另一层。[MCP Security Best Practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)

## 2. P1：已跟踪文件不受当前 Git ignore 过滤

类型：与“读取前遵循忽略规则”承诺冲突的实现缺陷。涉及 Codebase。

[repository-files.ts](../../capability/craft-codebase/repository-files.ts) 使用 `git ls-files --cached --others --exclude-standard`。`--cached` 包含全部已跟踪文件；Git 的默认忽略机制不排除已跟踪文件。官方 `check-ignore --no-index` 正是为忽略 Git 索引、按规则检查这些路径提供的能力。[git-ls-files](https://git-scm.com/docs/git-ls-files)、[git-check-ignore](https://git-scm.com/docs/git-check-ignore)

隔离复现：在临时 Git 仓库先 `git add secret.ts`，再向 `.gitignore` 添加 `secret.ts`。实际 `repositoryFiles` 仍返回：

```json
{"case":"tracked_file_later_ignored","selected":["secret.ts"]}
```

最小实现：在内容读取前，对候选路径用 Git 的规则引擎批量检查，包括已跟踪文件；复用 NUL 分隔、超时和输出上限。保持默认生成目录、显式排除和 symlink 防护，不自行实现不完整的 glob 引擎。明确“忽略”仅约束后续 Craft 读取，已存历史快照的清理另走既有治理流程。

验收：已跟踪且后来忽略、未跟踪忽略、嵌套规则、否定规则、全局 excludes、包含空格/换行的合法文件名；忽略改变后旧索引不可继续作为当前索引。宿主 `.cursorignore` 不会自动保护 MCP，因此 Craft 自己的测试必须覆盖这些情况。[Cursor Ignore 文档](https://cursor.com/docs/reference/ignore-file)

## 3. P2：Context 尚不能按任务需求分配材料与代码预算

类型：部分为入口能力断层，部分为检索质量增强。

[openContext](../../core/application/use-cases/repository-context.ts) 先让 K/M/E 使用全部条数和字符预算，Codebase 只能使用余量；现有 [repository-context.test.ts](../../tests/repository-context.test.ts) 甚至明确验证“一条知识占满 `max_items:1` 后代码引用为零”。因此 review 一个精确符号时，只要积累材料足够，代码引用就可能长期被挤出。

独立 resolver 已有经过评估才能启用的 vector/hybrid、来源过滤、必选记忆、工作笔记和时间查询，但聚合 schema/调用链没有贯通这些选项。不能将此描述成“Craft 没有混合检索”；正确问题是默认产品无法选择已有检索能力。

最小实现：为聚合显式开放 `retrieval_adapter_id`、`source_ids`、`memory_ids` 等已有选项，并保持原有门禁；提供可选 codebase 条数预算或 task mode，预算不足时始终保留 required memory 的失败语义。对明确符号/changed paths 优先分配代码引用；无代码命中时返还余量。分类应可解释、可覆盖，不需要先引入 LLM 路由服务。

验收：knowledge-heavy、review、纯知识任务三组 fixture；相同总预算下必选材料不会静默丢失，review 能包含目标代码引用，无代码命中不会浪费预算；指定 hybrid 的 receipt 真实记录实际策略/降级原因。基准比较引用准确率、漏召回和总输出大小，不只看调用成功。

这种“先给小首包、再有目的探索”的设计依据来自 Anthropic 的按需上下文方案；具体配额是 Craft 的工程选择，不是供应商规定。[Anthropic Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

## 4. P2：跨能力同文去重没有使用相同内容表示

类型：已隔离复现的实现缺陷；近似语义去重另属可选增强。

[context-resolution.ts](../../core/context-resolution.ts) 对 Memory 使用原始 body 计算去重键，对 Knowledge 使用 `retrieval_text`；[Knowledge contribution](../../capability/craft-knowledge/contribution.ts) 的 `retrieval_text` 会转小写并追加 tags。因此同一正文存在于 Knowledge 和 Memory 时，只要大小写或 tags 不同，就无法去重。

使用真实 contributor 与临时数据库，Memory 和 Claim 都为 `Alpha testing`，Claim 增加 `tags:["tests"]`，实际结果：

```json
{"case":"same_content_memory_and_tagged_claim","total_items":2,"deduplicated_count":0}
```

最小实现：把排名文本和显示正文分开，优先用已验证的正文 digest 或同一规范化正文生成去重键；保留所有来源引用，保证去重不丢失证据链。不要把大小写有语义的代码、不同版本 Procedure 或显式 required item 强行合并。

验收：真实 Knowledge + Memory 同正文、tags不同、纯大小写差异、不同来源同文、相近但相反的结论、不同 Procedure 版本、历史视图与 required memory。先修确定的同文去重，再用标注数据评估近似去重；无需立即引入生成式压缩。

Graphiti 官方实现把来源追踪和事实变化放在模型中，因此可借鉴“一个选中内容保留多来源”，而不是只保留最先命中的来源。[Graphiti](https://github.com/getzep/graphiti)

## 5. P2：全库先截取 10,000 条再按作用域过滤，会造成静默漏召回

类型：可由代码顺序确认的容量边界缺陷，尚未运行大规模端到端基准。

[Knowledge contribution](../../capability/craft-knowledge/contribution.ts)、[Experience contribution](../../capability/craft-experience/contribution.ts) 与 [Context Memory 读取](../../core/context-resolution.ts) 均先 `store.list(kind, 10_000)` 再按 scope/ACL 过滤。[CraftStore.list](../../core/infrastructure/store.ts) 不带 predicate 时先在 SQL 按更新时间 LIMIT。其他项目写入足够多的新条目后，目标项目较旧条目在检索前就消失；当前 `omitted_count` 无法反映这部分未扫描记录。

最小实现：先按作用域与授权候选范围过滤，再应用明确候选上限；短期可复用已有带 predicate 的 list 以修正语义，但它仍读取全表，不能宣称大规模性能已解决。后续可做 scope/source/status 索引或有游标扫描。达到扫描上限必须返回 `partial/candidate_scan_limit`，不能包装成成功空结果。

验收：目标项目一条旧数据，其它项目至少 10,001 条新数据；目标仍可召回，越权项不能参与排名/计数；候选达到上限时有明确截断信息；给出 1k/10k/100k 分级延时和内存实测后再调整默认上限。

命名空间限定长期数据检索是 LangGraph store 的基本组织方式，但本条具体错误来自 Craft 的 LIMIT 顺序，不能用业界功能介绍代替本地测试。[LangGraph Memory overview](https://docs.langchain.com/oss/python/concepts/memory)

## 6. P2：任务回执缺少统一重检；来源时效没有覆盖所有派生材料

类型：生命周期能力增强；不应误判为完全没有时效治理。

当前 Knowledge 已检查来源状态、文档 digest 和过期时间，Memory 已支持 TTL、有效时间/观察时间、冲突弃权，Experience 有版本化定义、按 route 的门禁和独立执行证据。相关实现见 [Knowledge contribution](../../capability/craft-knowledge/contribution.ts)、[Memory Ledger](../../capability/craft-memory/memory-ledger.ts)、[Procedure gate](../../capability/craft-experience/procedure-projection.ts)、[Invocation](../../core/application/procedure-invocation.ts)。这些能力不需要重做。

剩余缺口是默认 `context_pack_receipt` 只有一次选择的快照，未提供“这份首包现在还能用吗”的统一入口。长任务中 Source 撤销、Memory 被 supersede、Procedure 失去 routeable、代码改变后，宿主需自行逐个拼接检查。旧 [ContextPlane audit](../../core/context-plane.ts) 只比较 manifest 自身 digest，不能替代所引用材料的当前状态校验。

Memory 保存 `source_version`，resolve 主要检查当前 source 的 active/trust；事实型派生记忆若来源内容变了，缺少明确的 dependency digest 与重新验证提示。不能简单把 source 元数据版本变化等同于内容失效，也不能让偏好随无关文档更新被自动删除。

最小实现：只读 `context_pack_validate` 或等价 receipt 重检操作，返回每个引用的 current/stale/revoked/unavailable 原因；沿用已有资产/Source/Procedure 校验。对有来源依赖的事实增加显式 digest 与维护候选，重新验证仍走原门禁。模型上下文的清理和压缩继续由宿主掌握，Craft 不声称能删除已经注入的旧内容。

验收：取首包后依次撤销 Source、supersede Memory、回滚 Procedure、改代码；旧 receipt 不再宣称 current，仍可作为历史审计；未经授权的重检不泄露引用；仅来源名称改变不触发内容失效。Graphiti 的有效时间与来源 lineage 可作为数据建模参考，LangGraph 的线程状态与长期 store 分工也支持维持当前边界。[Graphiti](https://github.com/getzep/graphiti)、[LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

## 7. P2：大仓缺少聚焦入口，自动索引的“增量”仅覆盖解析

类型：明确的产品能力限制和性能增强。

[repository-files.ts](../../capability/craft-codebase/repository-files.ts) 按路径排序后选前 500 个源文件；默认入口未接收任务文件范围。排在第 501 个之后的目标可能永远进不了默认索引。每次还会读取并摘要全部选中文件；[basic-analysis.ts](../../capability/craft-codebase/basic-analysis.ts) 复用的是摘要相同文件的解析结果。当前文档对此已有预算声明，不应把它宣传成整个仓库的编译器增量分析。

最小实现：在仓库根身份不变的前提下提供有界 `focus_paths`/changed paths 或一次性范围查询；仍应用统一 ignore 和安全边界，并把 `coverage/omitted_reason` 放入结果。基础缓存键还应固定 analyzer 版本及影响结果的配置，否则升级解析器但文件未变时可能继续使用旧缓存。IO 快速路径须有可靠失效依据，不能只凭 mtime 判断内容完全相同。

验收：超过 500 文件时能定向查看后半部分；切换 focus 不把部分索引说成完整；变更、删除、分支切换、配置和 analyzer 版本变化正确失效；并发读取不发布与 checkpoint 不一致的符号。后续测量冷启动、warm、单文件变更、跨 worktree 的 IO/CPU/锁等待，再决定是否需要独立后台 worker。

Cursor 当前将符号/正则搜索与探索结合，说明有范围的快速查找可补足结构索引，而不必把所有语言关系都先算完。[Cursor Search](https://cursor.com/docs/agent/tools/search)

## 8. P3：多宿主入口已覆盖，工具发现与输出仍可进一步收敛

类型：可选增强，不是 MCP 协议错误，也不等同于真实宿主不可用。

聚合 [surface-registry.ts](../../core/interfaces/mcp/surface-registry.ts) 合并所有 daily 与 Codebase 工具；[dsh adapter-tools.ts](../../adapters/deepseek-harness/adapter-tools.ts) 的 discover 返回全部工具 schema 和 Skill。dsh 外层只有两个工具，降低初始注册成本，但每次 discover 又把完整目录放回对话，长期任务仍可能反复膨胀。现有 `max_chars` 主要控制选择的材料，不覆盖整个 MCP JSON、receipt、schema 和 Skill 文本，因此不应称为精确 token 预算。

最小实现：保持原发现接口兼容，增加 `query/member/tool_names` 和有界结果；默认返回工具名称、用途与 schema digest，按指定名称获取完整 schema。记录目录 fingerprint 以便复用，不让宿主把缓存命中当成工具可调用证明。输出可提供 compact 视图和实际 serialized size；token 数必须标记使用的计数器或估算方法。需要时采用 MCP 分页/资源引用，不能假定所有宿主支持资源订阅或模型供应商的工具延迟加载参数。

验收：五产品发现范围正确；精确工具 schema 可查且可调用；未知工具、旧 fingerprint、分页 cursor 无效均明确报错；紧凑视图维持同一来源/版本回执；真实 Codex、Claude、dsh 模型会话分别验证一次 discover→业务调用→结果读取。测试替换宿主注册函数仍然只能称为适配器契约验证。

按需发现与旧结果清理的分工见 [Claude Manage tool context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context)，跨宿主的通用部分应以 [MCP Tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) 为准。

## 建议实施顺序和非目标

1. 先完成第 1、2、4 项的确定性修复和红绿回归，尤其是维护权限绕过。
2. 将第 3、5 项做成默认入口到现有内核的完整契约，兼顾候选扫描和预算语义。
3. 在第 6、7、8 项中选择已有机制可直接复用的部分交付；更重的数据库、后台服务、语义压缩必须由基准结果证明必要。

不建议当前为“追平业界”重写 Experience 为另一套通用执行图。现有多入口/出口、子 Procedure、branch/fanout、持久 Invocation 和独立 Evidence/Receipt 已覆盖关键结构。真正还需要的，是每种宿主上成功的完整研发或 review 路线、失败恢复，以及与冻结基线比较的效果证据。

本报告只执行了四个针对性隔离复现：已跟踪忽略文件、无 scope 维护权限、真实跨成员同文去重、contributor 用途字段。没有将这些演示称为全量测试、线上验证或完整性能基准。
