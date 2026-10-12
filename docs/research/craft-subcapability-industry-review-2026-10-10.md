# Craft 四子能力：一手资料对照与最小优化建议

调研日期：2026-10-10。范围：Knowledge、Memory、Experience、Codebase 及 Context 组合边界。本文保留首次调研的差距分析；后续修复状态以末节验收记录为准。工作区修改尚未发布；命令回放不等于桌面应用完成注册验收。

## 一手资料与访问结果

以下四项在本轮通过网络实际读取官方仓库原文，不使用二手文章作为依据：

1. [Graphiti 官方 README](https://github.com/getzep/graphiti/blob/main/README.md)：明确描述双时间追踪、历史查询、增量更新以及语义＋关键词＋图遍历检索。用于比较时间语义和演进边界，不能把其 README 中的性能声明当成 Craft 的实测结果。
2. [Mem0 官方 memory prompts](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)：默认更新提示包含 ADD、UPDATE、DELETE、NONE；同文件也包含 ADD-only＋linked_memory_ids 的抽取方式。说明业界存在不同记忆更新策略，不能据此推断 Mem0 始终自动删除冲突记忆，更不能要求 Craft 复制删除策略。
3. [Serena 官方 README](https://github.com/oraios/serena/blob/main/README.md)：提供基于 LSP／其他后端的符号、引用导航，说明不同语言和后端支持程度不同。用于比较语言覆盖与关系证据强度。
4. [OpenAI Evals 官方 README](https://github.com/openai/evals/blob/main/README.md)：支持自定义评测和私有业务数据集。用于比较评测是否反映真实工作流，不要求安装其框架。

尝试读取 LangGraph 官方 memory 页面和 Anthropic agent eval 页面时，网络代理返回 403；LlamaIndex 及旧版 LangGraph 文档路径返回 404。因此本文不引用这些页面作本轮已核查证据。上述 GitHub 链接指向 main，后续可能变化。

## 不能误报为缺失的现有能力

| 子能力／公共能力 | 仓库已有实现与证据 |
|---|---|
| Memory 时间与治理 | `capability/craft-memory/contribution.ts` 已接受 `as_of`、`known_at`、`history_view`，按有效时间过滤；`memory-governance.ts` 已有冲突候选、显式 keep/supersede/dismiss 和替代记忆生命周期。不是只有简单键值存储。 |
| 检索与评测 | `common/craft-common-base/src/retrieval-port.ts` 已有 BM25、可选 embedding、SQLite 缓存、模型身份、批量预算和失败标识；`core/retrieval-evaluation.ts` 已统计 recall、precision、MRR、无答案误报、成本及延迟，`core/context-retrieval-capture.ts` 已有融合。不能建议“从零增加向量／混合检索”。 |
| Codebase 结构理解 | `typescript-analysis.ts` 已使用 TypeScript checker；`lsp-adapter.ts` 已接受 LSP 符号与关系；`codebase-index.ts` 的 importAnalysis 校验 checkpoint、摘要及范围。不能误称全部是正则或缺少 adapter。 |
| Codebase 增量处理 | `basic-analysis.ts` 已按文件 digest＋analyzer_version 复用符号缓存；`repository-onboarding.ts` 已复用 checkpoint/index 并处理 stale 状态。不能误称每次无缓存全量分析。 |
| Experience 质量门控 | `experience-ledger.ts` 已有观察／模式／干预幂等和评估生命周期；仓库还有 held-out、signoff、verified receipt 与 Context host evaluation 测试。不能把“增加评测平台”当成最小修复。 |

## 五项真实差距及优先级

### 1. P1：Knowledge 直接读取和 Context 召回必须一致执行正文限制

现有边界：`capability/craft-knowledge/contribution.ts` 在组装候选时检查 source、scope、trust，并使用 ContextReadGuard 防止读取期间权限漂移。本轮此前复现的 restricted 正文召回问题说明，正确的检查存在于一条读取路径不等于其他读取路径也完整。

最小建议：在任何正文访问前检查 restricted，包括显式请求 ID、required_refs、candidate mode；重检当前版本的 sensitivity，防止读取期间条目升级为 restricted。不要把权限裁决移到远程检索器或只在最终输出过滤。验收：普通请求不读取／不返回 restricted 正文；显式授权路径正常；漂移后 fail closed；禁止项不写入缓存／日志。

与业界资料的关系：这是 Craft 的安全一致性缺陷，不是从 Graphiti 或 Mem0 推导出的竞品缺项。

### 2. P1：Experience 的实际宿主事件身份比功能数量更重要

证据：`core/interfaces/codex-hook-bridge.ts` 负责开始、工具、结束事件桥接；此前无宿主 turn_id 的夹具复现了自动 ID 未被后续事件接续。`tests/context-host-evaluation.test.ts`、`tests/codex-hook-bridge.test.ts` 的存在不能替代实际宿主无 ID、跨进程、并发输入的证据。

最小建议：持久化同轮身份映射；宿主明确 ID 优先；只有唯一活动轮次时才补缺失 ID；多个活动轮次时拒绝猜测；结束事件幂等；失败不得记录成执行成功。验收覆盖开始→工具→结束、重复 Stop、缺开始、并发歧义。真实 Codex／Claude 加载仍需宿主验收。

对照 OpenAI Evals：补充能代表真实事件负载的私有回放数据集，复用当前评测设施；不要增加第二套评测框架。

### 3. P2：Memory 冲突判断必须覆盖整个有效集合

证据：`common/craft-common-base/src/retrieval-port.ts` 的 temporalMemorySelect 是当前时间选择入口；此前 A、A、B 夹具证明仅比较前两项会漏掉 B。当前工作区已改为检查全部 content_digest，并已有相关回归测试；未宣称真实宿主已验证。

最小建议：先排除未生效／过期项，再在同 topic、同作用域有效集合中比较所有 content_digest；存在多个值时 abstain 并报告全部冲突引用；已由 governance 显式 supersede 的历史值不应继续阻断现行值。验收包括 A/A/B、A/B/A、同值去重、作用域覆盖、有效期边界和历史查询。

对照 Graphiti 与 Mem0：Craft 已有时间查询和显式冲突解决。安全的改善是补全集合判断、保持历史，不是用 LLM 自动删除所有矛盾。

### 4. P2：Codebase 的路径边界与“支持”的定义需要更精确

证据：`repository-files.ts` 中此前使用 startsWith("..") 导致合法 `..helpers.ts` 被排除；应判断完整父目录路径段。`basic-analysis.ts` 明确 relations:not_analyzed、certainty:partial；semantic 自动路径只分析 TS／JS，非 TS 默认是粗略符号发现。`lsp-adapter.ts` 已提供外部 LSP 归一化，但不自动启动语言服务器。

最小建议：修合法路径且保持 symlink／真实越界拒绝；确保 onboarding 摘要和宿主文案区分文件被纳入、基础符号支持、语义关系支持。只有实际非 TS 项目需求和回归集出现后，才使用现有 importAnalysis 接一个语言后端。验收不只检查 status:ready，还检查 analyzer、certainty、omitted count 和实际关系边。

对照 Serena：差距是自动语言后端覆盖及证据透明度，不是完全缺少结构导航，也不是必须引入整个 Serena。

### 5. P2 优化候选：LSP 关系归一化存在可以局部消除的重复扫描

证据：`capability/craft-codebase/lsp-adapter.ts` 支持最多 10,000 nodes、20,000 relations。每条关系两个 endpoint 都调用 nodes.find，随后调用 documents.find 找源文档。最大预算下查找工作量随 nodes×relations 增长；本轮未进行性能测量，不能宣称已有线上性能回归。

最小建议：在节点生成时建立 path＋start_offset 索引、文档路径 Map；一次建索引后执行等价查找，不增加依赖或新抽象。需要保留现有重复起点行为或明确拒绝歧义，不能通过 Map 覆盖悄悄改变选择语义。验收：嵌套符号、缺失端点、相同起点、无效范围行为一致；用规模夹具比较归一化耗时。这是可单独落地的性能优化，不要求系统性重构。

## 分层判断

总体责任划分合理：各 Contribution 管本能力可读性与快照；Context 负责工作集和融合；Host bridge 负责宿主事件；Store 管本地持久化。`docs/adr/0025-context-working-set-is-the-retrieval-seam.md` 已定义唯一检索 seam，`scripts/ci/layer-graph.ts` 已检查向上引用、循环和兼容 barrel 的实际目标。保留这套结构比新增统一“大脑”服务更稳妥。

首次调研发现：`common/craft-common-base` 名称及 description 表示共享确定性 primitives，但 `src/retrieval-port.ts` 同时包含 fetch、SQLite、OpenAI-compatible adapter 和 memory 时间政策。它实际承载公共契约、业务政策、外部基础设施三个角色，文件较难单独理解和替换。当前依赖图允许 base→store-local，这是显式设计，不能仅凭命名判成循环。

建议在下一次真实 adapter 变更时，将 HTTP／SQLite provider 实现放入基础设施模块，保持 RetrievalPort 和公共导出兼容；将时间政策作为 Memory 内部策略或专用纯模块。迁移前核对包 exports、编译产物和 boundary tests。后续实施已按这些职责拆分文件并保持公共导出，详见末节；未新增框架或依赖。

## 推荐落地顺序与未验证范围

1. 先修并验证正文限制和 Hook 事件身份。
2. 修 Memory 集合冲突与 Codebase 合法路径，运行直接相关／受影响测试和项目静态检查。
3. 若成本可控，补 LSP 索引和规模夹具；不要默认扩大语言后端或启用付费 reranker。
4. 复用现有 Context host evaluation 加入真实宿主回放，建立升级前后结果比较。

本文负责一手资料调研和源码对照。主执行任务已报告前四项修复落地，相关 42 项测试通过，并将时间分组改为线性追加以避免反复复制数组；最终总验证以主任务日志为准。LSP 端点和文档索引现已落地，保留同起点符号首匹配语义，并补充 20,000 条关系规模夹具；尚无性能基准对比。真实宿主回放和基础设施职责迁移仍是后续建议。不宣称整体召回提升、真实宿主兼容、远程多租户或规模性能已验证。


## 后续修复与代码质量验收（2026-10-10）

| 验收条件 | 实现 | 验证证据 |
|---|---|---|
| Knowledge 受限内容在正文加载前过滤 | Contribution 和诊断搜索应用 restricted 开关；诊断搜索拒绝非法有效期；保留诊断查看撤销来源的已有语义 | `knowledge-contribution.test.ts`、`knowledge-memory-operability.test.ts` 的禁止加载夹具、显式开启和撤销来源兼容测试 |
| Memory 时间策略先于作用域覆盖、冲突检查覆盖所有有效摘要 | `memory-temporal-policy.ts` 专用纯模块；Contribution 按作用域执行时间选择 | `retrieval-port.test.ts` 的 A/A/B、反向排列、历史视图；`memory-contribution.test.ts` 的过期/未来/有效任务偏好 |
| 检索契约与实现解耦，旧导出和独立包兼容 | 分为 `retrieval-contract`、`keyword-retrieval`、`embedding-retrieval`、`memory-temporal-policy`；保留 `retrieval-port` 兼容入口；Knowledge/Memory 使用本地子路径 | 全量分发构建；真实 npm tarball 在仓库外类型检查及运行，包含四个新增子路径 |
| 主服务收敛职责 | 提取 `CognitiveSearchCoordinator` 和 `EvaluationRunCoordinator`；现有公共方法保留为委托；主服务从 4,750 行降至 4,405 行 | service、integration、Knowledge scope/relation、loop-memory-access、evaluation、closed-loop、capability-access 相关回归 |
| 参数和记录处理复用，热点减少重复扫描 | 复用同语义 array/finiteInteger 与 payload；Embedding 输入按缓存键查找；Memory 验证反馈按条目/摘要统计且每条反馈去重；评测聚合线性追加 | validation、retrieval-port、memory-contribution、evaluation 回归；反馈覆盖重复、旧摘要、缺失及无效引用 |
| Hook 无 ID、并发、重复结束和迟到信号正确处理 | 唯一活动轮次补 ID；歧义拒绝猜测；信号事务累积；结束与学习原子执行并关闭日志；日志键含 session identity，旧日志兼容读取 | `codex-hook-bridge.test.ts` 的跨会话同名 turn/旧日志夹具；`codex-hook-process.test.ts` 按 Codex/Claude manifest 启动独立进程，回放开始→编辑→两项并发验证→结束→重复结束/迟到事件 |
| 大规模和遗留评测不产生错误结论 | 配对符号检验使用对数求和；旧比较记录缺失配对时报告 inconclusive、拒绝 promotion；现行比较仍拒绝 case_ids 不一致 | `evaluation.test.ts` 的小规模精确值、10,000 项规模数值稳定性、旧比较记录和公共比较校验 |
| 代码索引路径与 LSP 输出兼容 | 合法 `..helpers` 路径纳入；LSP 端点和文档用 Map，保留同起点符号的首匹配 | repository lifecycle、LSP adapter、industry-gaps 测试；10,000 符号/20,000 关系基准完全输出对比 |
| 质量门禁覆盖四子能力 | lint 覆盖 common 和四个 capability；TypeScript 开启 erasableSyntaxOnly 以阻止 Node strip-only 不支持的参数属性等语法；历史本机路径改为文本，内部 Skill 链接指向源码 | 类型检查、构建、lint、文档链接、分层、工具表面、声明一致性审计 |

### 运行结果与复现

- 扩大受影响回归：226 项通过；独立包、五个插件、Codex/Claude Hook 进程回放与复制运行时：35 项通过。新增跨会话轮次测试后另重跑 43 项相关测试，均通过；新增 tarball 子路径断言也单独通过。重复执行项不累计成额外覆盖率。
- `pnpm run build` 成功，包含公共包、插件、DSH 及适配器产物；Hook 身份修复后重新执行 `build:core`、`build:plugin`、`pack:plugin`。
- `pnpm run test:plugin` 成功：版本/包装一致性、无 node_modules 启动、所有子插件 initialize/tools-list/tools-call 和 full MCP 冒烟。
- 分层审计：413 模块、0 违规，无 import exemptions；文档链接审计清洁；工具表面审计清洁；声明一致性 9/9 变异被捕获；lint 已覆盖公共包和四子能力。
- LSP 基准：Node 24.19.0，基线取 Git `3be188b` 的原实现；100 个文档、10,000 符号、20,000 关系，三次样本。原实现中位数 1,582.90 ms，新实现 50.84 ms，约 31.14 倍；完全归一化输出相同。它是本机合成夹具的改善，不代表所有项目或线上端到端性能。
- 复现基准：`git show 3be188b:capability/craft-codebase/lsp-adapter.ts > /tmp/craft-lsp-baseline.ts`，然后 `node scripts/eval/lsp-normalization-benchmark.ts /tmp/craft-lsp-baseline.ts`。

### 仍未验证的部署范围

当前验证覆盖打包产物的真实命令与协议执行，不包含用户桌面应用实际安装、注册、热加载或由真实 UI 产生的事件负载。没有发布 npm/GitHub，也没有替换用户电脑安装。未调用在线付费 embedding/reranker；非 TS 语义关系仍通过已有 LSP importAnalysis 接入，本轮没有扩展语言服务器覆盖。主服务剩余 Host、Work Launch、配置等编排继续保留原功能；本轮移出的是已确认需要独立维护的查询和评测职责。
