# Craft 距离理想态：对照 2026 年业界一手资料的差距评估

- 日期：2026-09-18
- 版本：v0.12.34
- 状态：结论已落到代码与测试

## 这份文档的来源与局限

**必须先说明可信度。** 本环境的 `web_search` 不可用（未配置搜索密钥），因此分析改用
直接抓取一手来源。实际取到的是 **Anthropic 工程博客**的 5 篇文章：

| 来源 | 用途 |
|---|---|
| [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)（2026-04-08） | session / harness / sandbox 三接口 |
| [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（2025-09-29） | 上下文作为可管理资源 |
| [Introducing Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)（2024-09-19） | BM25 + rerank 的量化收益 |
| [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)（2024-12-19） | workflow vs agent 的边界 |
| [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)（2025-06-13） | 多 Agent 的适用面 |

**这是一家之言，且该厂商在推广自家 Managed Agents。** 文中 49% / 67% 等数字是
Anthropic 自己的评测，未找到独立复现。OpenAI、Google 与开源生态的对照**没有做**，
因此"业界共识"这个词在本轮调研中不成立。

本文所有**关于 Craft 的结论都是在仓库中实测的**，不是推测；每条都注明了核实方式。

## 一、能力 vs 形态

调研的总体结论是：**Craft 的差距不在能力，在形态。**

运行时该有的东西基本都在，而且有几处比行业做法更严格（见第三节）。真正的差距是三处
**形状**问题——能力存在，但接错了形态：

1. 上下文只能截断，不能回退；
2. 词法检索没有 IDF，也没有标识符意识；
3. 记忆只能被显式调用写入。

这三条都不是"缺一个内核"，而是"已有的东西用错了接口"。因此本轮全部改动都在
**既有模块的接缝处**，没有引入新的运行时概念。

## 二、三处已闭合的差距

### 差距 1：不可逆的上下文（→ `ReversibleContext`）

**核实**：`src/token-budget.ts:88` 的 `truncateToBudget` 是一次性操作——它返回一个
**新的更短字符串**，原字符串的尾部无法找回。

Managed Agents 那篇直接点了这个问题的要害：

> irreversible decisions to selectively retain or discard context can lead to failures.
> It is difficult to know which tokens the future turns will need.

**做法**：`ReversibleContext` 保留全部 segment，只收缩**投影**。被丢弃的 segment 会被
**具名记录**在 `omitted` 中，而不是消失；`restore()` 能把它取回。权重相同时按新近度
排序，保证同一输入永远得到同一投影。

**一个实现上的修正**：`restore()` 最初用 `weight + 1` 提升目标 segment。这会让结果
取决于**无关 segment 的权重**——目标能否回来，居然由别人的权重决定。已改为提升到
`max(weights) + 1`，使"能否放下"成为唯一的失败原因。这个 bug 是被自己的测试抓出来的。

### 差距 2：词法检索缺 IDF 与标识符意识（→ `Bm25Index`）

**核实**：`src/catalog.ts:32` 的 `rerank` 是**本地打分函数**（substring 匹配 +
exact-name 加权），不是模型 reranker；全仓库 **零 BM25**。同时
`catalog.ts:253` 的 `searchHybrid` **已经有** RRF 融合（`1/(60+rank)`）——这一点我
最初判断错了，融合不是缺口，缺的是词法侧的判别力。

Contextual Retrieval 的论据是：embedding 擅长语义，但**会漏掉精确串**，典型例子就是
`Error code TS-999`。BM25 补的正是这一块。

**这一条对 Craft 比对多数系统更重要**：Craft 存的是 328 种记录类型、receipt digest、
ticket id、sha256——**标识符密集**，恰恰是纯语义检索最弱的地方。

**做法**：标准 BM25（k1=1.2, b=0.75，idf 用 +0.5 平滑），外加**标识符精确命中加权**。
`fuseRankings` 把已有的 RRF 规则提取为可复用、可测试的函数，让新信号接入时不必重写融合。

**一个测试暴露的认知错误**：我曾断言"b=0 时两篇文档同分"。错了——b 关掉的是**长度
归一化**，词频仍然生效，所以重复 20 次 `alpha` 的文档得分更高。这是正确的 BM25 行为，
是我的期望写错了。

### 差距 3：记忆依赖模型自觉（→ 确定性捕获）

**核实全部调用点**：`memoryRemember` 与 `rememberEpisode` **只从 MCP 工具调用进入**
（`craft-service.ts:1476`、`mcp-server.ts:1141`），**没有任何自动捕获路径**。

这意味着"自进化"是被动的：除非模型在对话里主动决定"这个要记"，否则本次任务的教训就
丢了。

**做法**：`decideExperienceCapture` 把"值不值得记"变成**观测事实的确定性函数**
（outcome / retries / corrections / breadth / novelty / explicit），带阈值、可审计。
它不试图聪明：高分产出的是**候选记录**，附带 reasons 与 provenance，而不是静默写入。

**两处校准修正**（均由自己的测试暴露）：

- **corrections 权重过低**：`corrections:1` 得 15 分，低于默认阈值 25，于是
  **最有价值的教训反而不被捕获**——一次 correction 同时编码了失败**和**修法，应当是
  最高价值信号。权重改为 26。
- **`requires_review` 判反了**：原为 `kind !== "routine"`，导致 `working_pattern`
  （用户显式要求）也要复核。但显式要求是**信任度最高**的信号，由提出者背书；反过来
  把失败与修正置于复核之下才是对的。已改为只对 `failure_lesson` / `correction` 要求复核。

## 三、Craft 做对、且与行业同向的地方

这几条是逆共识的，值得记录：

1. **凭证结构性不可达 sandbox。** 与 Managed Agents "解耦 brain 与 hands" 同向，且
   Craft 用 `env:` 引用 + broker，比"存 vault"更少假设。
2. **默认单 Agent。** 多 Agent 那篇的 90.2% 优势是在**研究型** breadth-first 任务上，
   且原文承认它引入协调、评估与可靠性难题。Craft 押"受治理的运行时"，是不同取舍，
   不是落后。
3. **六道熔断可调。** Managed Agents 举了 "context anxiety" 的例子：他们曾为
   Sonnet 4.5 加入 context resets，换到 Opus 4.5 后该行为消失，**resets 变成 dead
   weight**。这说明硬编码的 harness 假设会过期。Craft 把熔断做成可调参数，方向更对。
4. **不把 LLM Judge 当发布 Gate。** 用 `ineligible` / `inconclusive` 而非放行。

## 四、差距 5：harness 能否独立于 session 替换

这是上一轮**没有验证**、本轮**已证明**的一条。

Managed Agents 的论点是：harness 编码了"模型做不到什么"的假设，而这些假设会随模型
进步过期，所以要把 agent 虚拟化成 session / harness / sandbox 三个可互换接口。

**分两层核实：**

**结构层（静态）**：写了 `scripts/audit-v01234-layering.mjs` 检查分层方向。结果是
**只有 7 处** kernel 向上引用，且全部是**组合根**（`service.ts`、`mcp.ts`、
`service-foundation.ts`）或向后兼容 shim。分层基本成立。
`host-session-events.ts` 只依赖 `store.ts` 与 `trace-kernel.ts`，**不依赖任何 harness**。

**行为层（动态）**：结构不耦合 ≠ 行为可替换，所以补了
`tests/v01234-harness-session-decoupling.test.ts`，用**三个独立 store 实例**模拟三次
进程启动，全程**不在两个 harness 之间传递任何内存对象**——store 是唯一通道：

- 新 harness 能从日志恢复上一实例的 session，并**继续**追加；
- paused 状态经关闭/重开后仍在，可被另一个 harness `resume`；
- 第三个 harness 重放出的历史与快照**逐事件一致**，且 trace（独立记录类型）作为
  交叉见证；
- 重复追加已知 event id 是幂等的，**换 harness 不会重复记账**。

**结论：Craft 的 session 确实能在 harness 之外存活。** 这条之前是声称，现在是证据。
同时明确了边界：paused 恢复**必须**给出 reason digest，换 harness 不是跳过审计记录的
后门。

## 五、仍未闭合的部分

诚实地列出：

1. **rerank 仍是本地函数。** 没有模型 reranker。Contextual Retrieval 报告的 67%
   收益**包含** rerank 那一层，Craft 只拿到了 BM25 那一层。
2. **BM25 未接入 `catalog.searchHybrid`。** 本轮交付的是经过测试的独立实现与融合函数，
   但**没有**替换 catalog 现有的词法检索。接入需要回归语料，我没有做——不该在没有
   对照数据的情况下换掉线上检索路径。
3. **捕获路径未自动接入 agent loop。** `decideExperienceCapture` 是纯函数、已接 MCP
   与 service，但**没有**在 `agent-loop` 结束时自动调用。自动捕获是策略决定，需要
   先定"哪些信号从哪来"，我不替你做这个决定。
4. **没有独立来源交叉验证。** 见开头的局限说明。
5. **Windows 隔离仍只是声明。** `isolationCapability` 如实返回 `enforced: false`，
   Job Object 后端未实现（v0.12.33 已如实报告，本轮未推进）。

## 六、本轮交付物

| 文件 | 作用 |
|---|---|
| `src/v01234-runtime.ts` | 三处差距的实现，100% 行/分支/函数覆盖 |
| `tests/v01234-ideal-state-gaps.test.ts` | 20 个测试：单元 + 经真实 MCP server 的端到端 |
| `tests/v01234-harness-session-decoupling.test.ts` | 3 个测试证明 session 独立于 harness |
| `scripts/audit-v01234-layering.mjs` | 静态核验分层方向 |
| `scripts/coverage-v01234-report.mjs` | 把 V8 dump 关联回源码行，定位未覆盖分支 |

覆盖率为**实测值**（`--test-coverage-lines=100 --test-coverage-functions=100
--test-coverage-branches=100`，exit 0），不是估计。

## 七、过程中的自我修正记录

保留这些，因为它们是方法的一部分：

- 误判 `rerank` 为模型 reranker → 实为本地函数；
- 误判 `compaction` 为上下文压缩 → 实为 receipt 投影；
- 误判 RRF 缺失 → 实为已有；
- 误判 "b=0 时同分" → 实为词频仍生效；
- 误判 `restore()` 提升足够 → 实为依赖无关权重；
- 误判 corrections 权重合理 → 实为最有价值信号被阈值挡掉；
- 误判 `requires_review` 条件 → 实为判反。

以上七条**全部由测试或直接核实推翻**，无一是靠推理发现。
