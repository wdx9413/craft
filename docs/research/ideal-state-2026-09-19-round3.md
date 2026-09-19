# 理想态评估（第三轮）：用 Harness 五层坐标系重新定位

调研日期：2026-09-19 · 承接 `ideal-state-2026-09-19.md` 与 `-round2.md`
本轮聚焦：**最近一个月（2026-08 ~ 2026-09）**的公开信息

## 0. 本轮找到了什么：一个外部坐标系

前两轮我用的是"能力清单对标"（业界有 A/B/C，craft 有没有）。这一轮的收获是找到了一把**标尺**，让判断从"缺什么功能"升级为"在哪一层薄弱"。

业界已经收敛到一个公式：

> **Agent = Model + Harness**（[Cycode, 2026-09-18](https://cycode.com/blog/ai-agent-harness/)；[Shilong Liu taxonomy, 2026](http://lsl.zone/blog/2026/a-taxonomy-of-self-evolving-agents/)）

且 harness 被明确划分为**五层**（Cycode，上引）：

| 层 | 定义 | craft 现状（实测） |
|---|---|---|
| 1 Context | 智能体行动前知道什么；**"不是检索"**，是维护一个系统模型 | 强（knowledge/memory/receipt） |
| 2 Tooling | 能调用什么；**确定性优先，能由工具答的绝不交给推理** | 强（7 个内循环工具 + 493 个 MCP 工具） |
| 3 Orchestration | 谁在何时跑、什么范围、交接什么 | 中（sub-agent / 委托 / a2a 都有） |
| 4 Verification | **如何证明产出是真的**；coding 有测试绿灯，security 得自己造 | **弱** |
| 5 Governance | 权限、爆炸半径、可审计记录 | **很强（明显领先）** |

这个坐标系立刻暴露了一件事：**craft 是把资源堆在了第 5 层，而第 4 层（Verification）按 Cycode 的说法是"最难最贵的问题"。**

同时，[LangChain 的实测](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness)（经 Cycode 转述）给了本轮最强的量化论据：2026 年 3 月他们把 coding agent 从 Terminal Bench 2.0 的 **Top 30 提到 Top 5，没有改模型、没有微调任何权重**，只重建了 harness。同一个 Claude Opus 4.6 在 Claude Code 里得分远低于在其他 harness 里——**"包住模型的产品决定上限，而不是模型本身"**。

**这直接支持我第一轮的结论**（craft 的投入方向对：harness 才是杠杆），但**推翻了优先级**：我前两轮把 G3（失败归因）当作"让 G1 可证伪的前提"，现在看它其实是**第 4 层 Verification 的一部分，而第 4 层才是 harness 工程的胜负手**。

## 1. Verification 层：craft 最实质的缺口

Cycode 的论证很硬：

- Coding agent 有**现成的确定性传感器**（测试绿、编译过、lint 过），便宜、快、二元
- Security **没有等价物**，所以"必须自己造 ground truth"（可达性分析、可利用性分析、变更影响推理）
- 结论：**一个说不清自己信号是否真实的传感器，不算闭环，只是把噪声提前了**

craft 的处境**更接近 security 而不是 coding**：craft 治理的是"智能体做的工作是否可信"，而这件事没有现成的绿灯。craft 已有的 `evidence`、`signoff`、`held_out evaluation`、`acceptance_check` 都是**证据基础设施**——但它们的定位是"让人类批准"，**不是"让智能体自己知道这次做对了没有"**。

**这就是缺口 V1**：craft 有 verification 的**记录**，没有 verification 的**传感器**。具体表现：

- `agent-loop.ts` 的 `observeStep` 用 `progress_digest` 判"有没有进展"，但那只检测**是否重复**，不检测**是否正确**
- `halt_reason` 里没有一项是"验证失败"，只有 `no_progress` / `repeated_action` / `budget_fuse`
- 经验捕获 `decideExperienceCapture` 的 `WEIGHTS` 里有 `failure: 30`，但**failure 从哪来**？来自调用方自报的 `outcome`，不是来自 harness 自己观测到的验证结果

也就是说：**craft 的自进化闭环，其"成功/失败"信号是外部喂进来的，不是自己测出来的。** 这正是 Cycode 说"必须自己造传感器"的那个点。

**可验证判据**：能否在一个没有人类介入的循环里，由 harness 自己产出一个二元/分级的验证结论，并用它驱动 `decideExperienceCapture`——而不是等调用方传 `outcome`。

## 2. 记忆侧：Mem0 自报的三个最难开放问题，craft 命中两个

[Mem0《State of AI Agent Memory 2026》（更新于 2026-09-18）](https://mem0.ai/blog/state-of-ai-agent-memory-2026) **自报**（其自身口径，非独立复现）：

- 三个基准已成标准：**LoCoMo、LongMemEval、BEAM**（BEAM 测 1M/10M token 量级）
- 自报分数：LoCoMo **92.5**、LongMemEval **94.4**、BEAM(1M) 64.1、BEAM(10M) 48.6，约 **6,900 tokens/query**
- 提升最大的两类：**temporal reasoning +29.6**、**multi-hop +23.1**
- **仍最难解决的开放问题：cross-session identity、temporal abstraction at scale、memory staleness**

**命中分析**：

- **memory staleness（记忆陈旧）**：craft 已有 `valid_until`、`superseded`、`expired`、`revoked` 状态与 `knowledge-index` 的过期清理（`expired(now)`），v0.12.35 又加了衰减加权。**这一点 craft 做得比 Mem0 的"三个开放问题"描述的要好**——craft 是显式时间语义，不是统计衰减。
- **temporal abstraction at scale**：craft **没有**。这与第一轮的 G1（跨轨迹抽象）是同一件事的两个侧面——Mem0 从检索角度说"时间维度的抽象难"，ACL 2026 从演化角度说"跨轨迹抽象缺失"，**两个独立来源指向同一缺口**。这提高了 G1 的置信度。
- **cross-session identity**：craft 的 scope（user/project/workspace/task）是**显式作用域**，比依赖 `user_id` 派生更严格。**这一点 craft 不弱**。

### 2.1 一个必须记录的自我纠正：G4（多跳检索）方向被推翻

我第二轮把 **G4「图只走一跳，缺多跳/实体图加权检索」** 列为缺口，理由是 Eywa 和 GraphRAG 都用图。

但 Mem0（**产业界最大规模的记忆实现之一**）明确报告他们做了**相反**的迁移：

> "we replaced external graph store support with **built-in entity linking**... this is **no longer a queryable graph interface**. The `relations` field from prior versions is **gone**."

即：**从可查询图 → 内建实体链接**。实体关系只影响**检索排序**，不再可遍历。Mem0 承认这是对需要图接口的团队的 regression，但对大多数团队是净收益（省掉 Neo4j 的运维）。

**所以 G4 应降级**：多跳图检索是**少数场景的专门需求**，不是普遍理想态。craft 已有 `knowledge-relation.ts` 的一跳遍历 + 6 种关系（含 `supersedes`），**在这个问题上处于合理位置**，不该按"缺多跳"来投入。这是我第二轮判断偏了——我把**学术系统的取向**当成了产业取向。

### 2.2 一个值得注意的产业做法：procedural memory 被单独拎出来

Mem0 明确说：大多数系统只有 episodic + semantic，**生产环境还需要第三类 procedural memory**（学到了工作流、编码模式、工具使用习惯、评审约定、部署步骤），并**坦承"支撑概念但专用工具仍处早期"**。

craft 的 `MEMORY_KINDS = ["working","episodic","preference","procedural"]` **已经有 procedural**，且 `knowledge-memory-runtime.ts:91` 强制"procedural 或 confirmed 必须有 Evidence"——**比 Mem0 自报的状态更严谨**。这一点 craft 不欠。

而 Mem0 的 **multi-signal retrieval**（semantic + BM25 + entity 三路融合）与 craft 的 `hybridMemoryScores`（keyword + vector RRF 融合）+ `catalog.searchHybrid`（lexical + bm25 + semantic 三路）**方向一致**。差别是 craft 缺 **entity 那一路**。

## 3. 自进化：taxonomy 指出了我前两轮漏掉的整整一层

[Shilong Liu 的 self-evolving agents 分类学（2026）](http://lsl.zone/blog/2026/a-taxonomy-of-self-evolving-agents/) 给出三层演化位置：

1. **Artifact iterative optimization** —— 优化**产出物**（AlphaEvolve、auto-research）
2. **Harness self-improvement** —— 优化**智能体自身**，又分两路：
   - **Prompt learning / memory**（GEPA、ACE、Mem0）
   - **Tool and Skill Creation**（Alita、Mem-UI；skills 已被 Claude Code 形式化，Codex/OpenClaw/Hermes 均支持）
3. **Model learning without gold answers** —— 改权重（RL/self-play/TTT）

并给出三个判断问题：**What evolves? What feedback drives it? Where does the loop close?**

**对照 craft**：

- craft **有** harness self-improvement 的骨架，而且相当完整：`continual-harness.ts` 有 `viewCreate`/`refine`/`submit`，`CHANGE_KINDS = ["prompt_note","memory","skill","workflow","subagent_spec"]` —— **五个轴都覆盖了**
- craft **有** Tool/Skill Creation：`skillProposalCreate`（从 Experience Patterns 产出 SKILL.md 候选）、`wikiSkillCandidate*`（从 ≥2 条已评审 claim 造候选）、完整的 attest → authorize → package 门禁
- 但 `refine` 的约束很紧：**changes 1~4 条、最多动 2 个轴、必须有 confirmed/bounded evidence**（`continual-harness.ts:42-47`），且 `risk === "low"` 才可 session 级，否则走 governed

**所以 craft 在"harness 自我改进"上并不缺骨架，缺的是 taxonomy 的第一个问题："What feedback drives it?"** —— 回到第 1 节：驱动它的 feedback 是外部喂的 `outcome`，不是 harness 自测的验证信号。

**这使 V1（Verification 传感器）成为本轮的核心结论，而不是并列缺口之一。**

同时该文提出一个 craft 完全没有的角度：**multi-agent self-evolving 与 routing**——"一个只关心股票的 agent 不需要烹饪工具；塞进去只会让 agent 更慢更困惑"。craft 有 sub-agent / `harness_topology` / a2a 委托，但**没有按任务域路由到专精 agent 的机制**。这算新缺口 **V2**，但证据等级是 C（单篇博客，虽然作者有 Eevee 等论文背书）。

## 4. 明确不做（含理由变更）

- **G4 多跳图检索**：见 2.1，**因产业反向证据而降级**。这是我本轮主动撤回的建议
- **Model learning（改权重）**：taxonomy 承认这是独立一层，但与 craft 的"证据与治理分离"架构冲突；且本轮所有产业来源都走非参数路线。仍列为非目标
- **BEAM(10M) 级别的规模**：Mem0 自报在 10M 只有 48.6，说明**整个产业都还没解决**。这不是 craft 该追的短期目标

## 5. 修正后的优先级

| 序 | 缺口 | 依据等级 | 变化 |
|---|---|---|---|
| 1 | **V1 Verification 传感器**（harness 自测成败，而非接收 outcome） | B（Cycode/langchain 实测）+ 架构推理 | **新置顶**：它是第 4 层，是 harness 胜负手，且是 G1/G3 的前置 |
| 2 | **G1 跨轨迹抽象** | A（ACL 2026 两篇 + Mem0 独立指向同一处） | 保持，置信度**上升**（双来源交叉） |
| 3 | **G3 失败归因分类学** | A（Eywa 8 类） | 与 V1 合并考虑：V1 产信号，G3 归因 |
| 4 | **G8 声明/实现一致性自检** | 代码实证（第二轮） | 保持，元问题 |
| 5 | **G2 治理护栏** | B（Governance Decay） | 保持 |
| 6 | **G7 MCP 合规** | **规范原文** | 保持，有 12 个月窗口 |
| 7 | V2 任务域 routing | C | 新增，低优先 |
| — | ~~G4 多跳图~~ | 产业反证 | **撤回** |

## 6. 结论

三轮下来，判断收敛得很清楚：

**craft 的 harness 在 Layer 5（Governance）明显领先业界参照物，在 Layer 1/2（Context/Tooling）扎实，真正的薄弱点集中在 Layer 4（Verification）——而 Layer 4 恰好是业界公认最难、也最能决定 harness 优劣的一层。**

具体到一句话：**craft 的自进化闭环，其"对错"信号来自外部自报的 `outcome`，而不是 harness 自己验证出来的结果。** 因此：

- 它的 `failure: 30` 权重可能永远等不到真正的 failure 信号
- 它的 G1 跨轨迹抽象即使做出来，也无法证明抽象"更好"——因为没有内生的成功判据

所以**下一步最高价值的动作是 V1**：让 harness 在没有人类介入时，自己产出一个可信的成败判定，并用它驱动经验捕获。这同时把 G3（归因）变成自然产物，并为 G1（抽象）提供可证伪的基础。

**本轮我撤回一条建议（G4），并修正一条排序（Verification 置顶），这两处都是被最近一个月的产业实证推翻的。**

## 附：本轮来源（2026-08 ~ 2026-09 为主）

| 来源 | 日期 | 等级 | 用于 |
|---|---|---|---|
| [Cycode: AI Agent Harness](https://cycode.com/blog/ai-agent-harness/) | 2026-09-18 | B | **五层坐标系**、guides/sensors、Verification 缺口 |
| [Mem0: State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026) | 更新 2026-09-18 | B（自报） | 三大基准、三个开放问题、graph→entity-linking |
| [Shilong Liu: A Taxonomy of Self-evolving Agents](http://lsl.zone/blog/2026/a-taxonomy-of-self-evolving-agents/) | 2026 | C | 三层演化位置、Tool/Skill Creation、routing |
| [MCP Roadmap](https://blog.modelcontextprotocol.io/posts/mcp-roadmap/) | 2026-09 | **规范原文** | 五个优先域（progressive discovery、agent identity） |
| [LangChain: Anatomy of an Agent Harness](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness) | 2026-03（经转述） | C | Terminal Bench Top30→Top5 |
| [Chroma: Context Rot](https://www.trychroma.com/research/context-rot) | — | C | 上下文填充导致推理退化 |
