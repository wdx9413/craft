# 理想态对照调研：记忆 / 知识 / 自进化 / Harness / Agent

调研日期：2026-09-19 · 对应 craft v0.12.35 之后的评估

## 这份文档的性质与边界

**它是一次外部对标，不是自我表扬。** 上一轮（v0.12.34/35）的评估主要依据 5 篇 Anthropic 工程博客，那是**单一厂商来源**，我当时明确标注了 Caveat，并且明确说过"行业共识"这个词不能用。这一轮 `web_search` 变得可用（上一轮因为没有 `DEEPSEEK_API_KEY` 而不可用），因此拿到了**多来源、含同行评审**的材料，其中两篇直接推翻了我上一轮的判断。

**必须事先声明的证据强度分级**，因为下面每条结论的可信度差别很大：

| 级别 | 含义 | 本文中的例子 |
|---|---|---|
| A | 同行评审 + 公开基准 + 可复现配置 | ACL 2026 Findings 两篇、Eywa（含逐题 artifact） |
| B | 有具体数字但未经独立复现 | Governance Decay（1337 episodes，公开 grader 代码） |
| C | 工程实践文章 / 厂商文档 | MCP 2026-07-28、Oracle Java 迁移文 |
| D | 无来源的单方面说法 | **不作依据** |

数字一律附上原始来源和其自述口径。**任何一条数字都不是我实测的，也不是"业界公认"。**

## 一、外部标尺：三个可直接对照的框架

### 1.1 记忆演化三阶段（ACL 2026 Findings）

[From Storage to Experience: A Survey on the Evolution of LLM Agent Memory Mechanisms](https://aclanthology.org/2026.findings-acl.2069/)（Luo et al., Findings of ACL 2026, pp. 41622–41652）把记忆机制演化形式化为三段：

- **Storage** —— 轨迹保存（只存不提炼）
- **Reflection** —— 轨迹精炼（从轨迹里反思）
- **Experience** —— 轨迹抽象（跨轨迹抽象成可复用经验）

并指出前沿阶段的两个关键机制是**主动探索（proactive exploration）**与**跨轨迹抽象（cross-trajectory abstraction）**。

**对照 craft**：craft 已具备 Storage（evidence + memory_ledger）和 Reflection（`decideExperienceCapture` 经验捕获、`buildExperienceRecord`）。缺的正是**跨轨迹抽象**——craft 的经验记录是**单条轨迹内**的产物（在同一 task 的 outcome/corrections/retries 上打分），没有任何一条路径把**多条**轨迹合并成一个更高层的抽象。这是本轮最重要的结构性发现。

### 1.2 失败分类学（Eywa，含逐题 artifact）

[Eywa: Provenance-Grounded Long-Term Memory for AI Agents](https://ar5iv.labs.arxiv.org/html/2605.30771)（arXiv 2605.30771, 2026-05）给出 8 类失败模式，并强调**端到端单一分数无法定位是哪一层坏了**：

Coverage gap（源里有没有）· Grounding gap（提取的事实是否有源支持）· Revision gap（新纠正是否覆盖旧的）· Scope gap（是否用错了人的记忆）· Temporal gap（时间窗选错）· Retrieval gap（存在但没被检索/被挤掉）· Synthesis gap（给了证据模型仍答错）· Measurement gap（评分指标本身错）

它的核心不变量是 **evidence before belief**：不可变原始证据先落库，LLM 提取出的"信念"只是**可修订、可删除的索引**，绝不是对原始证据的有损替代。

其自报指标（**其自述口径，非我实测**）：LoCoMo C1–C4 judge accuracy 90.19%、LongMemEval-S retrieval-sufficiency 88.2%、BEAM 81.45% mean nugget / 85.29% pass@≥0.5。

**对照 craft**：craft 的失败可定位性**实际强于** Eywa 的描述——`context_resolution_receipt` 已经带 per-memory `reason` 与 `omitted_count`，v0.12.35 的 `memoryUsageEvidence` 进一步区分"成功才算用过"。但 craft **没有这 8 类分类学的显式建模**，因此无法把一次坏答案归因到具体层。另外 craft 的 `planLegacyPromotion` 已是 "belief 是可批准索引" 的思路，方向一致。

### 1.3 自进化闭环（ACL 2026 Findings）

[Towards Self-Evolving Agents (MUSE)](https://aclanthology.org/2026.findings-acl.1522/)（Yang et al., Findings of ACL 2026, pp. 30424–30451）的关键机制是**执行后自主批判（autonomous post-execution critique）**：每个子任务完成后分析执行日志，把原始执行数据蒸馏成结构化可复用知识；并报告**性能随洞察累积而提升**且具备**跨任务迁移性**。

**对照 craft**：craft 有 `evidence_record`、有经验捕获，**但没有"执行后批判"这一步**——即没有一个在轨迹结束后自动检视"这次哪里本可以更好、什么值得沉淀"的环节。这是自进化闭环上最实的一处缺口，且与 1.1 的"跨轨迹抽象"缺口同源。

## 二、必须记录的自我纠正：上一轮有三处判断是错的

这一节比结论更重要。上一轮我（以及用户提供的那份分析）的判断有两处被证伪，另有一处被我自己的过度概括误导。

### 纠正 1：A1「知识图谱 / 双时态缺失」——**判断错误，大部分已存在**

上一轮我把 A1（KG / bi-temporal）当作"真正缺失的能力"，用户的分析也建议把它列为非目标。**这个判断是错的。** 实际检索代码后发现，craft 里双时态与取代语义已相当完整：

- `knowledge-relation.ts`:25 有 `RELATION_KINDS`，:61 按 `valid_from` 过滤，:83 有 `valid_from`/`valid_to` 闭区间维护逻辑，:100–104 有 `valid_to` 必须晚于 `valid_from` 的约束
- `knowledge-relation.ts`:158 明确支持从普通 `neighbors` 调用读出"本条已被 X 取代"
- `knowledge-index.ts`:28 注释说明"悄悄检索到已被取代的决定比检索不到更难调试"
- `craft-service.ts`:54–55 有 `superseded`/`expired` 状态与 `supersedes`/`contradicts` 关系类型
- `workbench.ts`:198–207 维护 `supersedes_id` 并在取代时迁移状态
- 记忆侧 `valid_until` 在 `knowledge-memory-runtime.ts`:162 参与活跃性过滤

所以 A1 不该被列为"缺失"，**至多是"图谱遍历/多跳检索能力偏弱"**（Eywa 的 entity/graph 通道、GraphRAG 式多跳）。我上一轮把它说成缺失，是**没有读到 `knowledge-relation.ts` 就下了结论**，这正是我该避免的错误。

### 纠正 2：v0.12.34 的 "compaction" ——**我用词不当，且真实缺口比我说的更严重**

上一轮我在评估中写过 `agent-loop.ts:142` 的 compaction 是"receipt projection 而非 context compaction"，当时把它当作一个**澄清**（即"我们并没有真的压缩上下文，所以没这个问题"）。

读到 [Governance Decay: How Context Compaction Silently Erases Safety Constraints in Long-Horizon LLM Agents](https://ar5iv.labs.arxiv.org/html/2606.22528)（arXiv 2606.22528）后，这个"澄清"变成了**更严重的问题**：

该文（**B 级证据**，1337 episodes，7 个模型，公开场景与 grader）报告：策略在完整上下文时违规率 **0%**；**单次 compaction 后升到 30%**（DeepSeek-V4 与 Kimi-K2.5 达 59%）；最受影响的模型上"压缩掉策略"甚至**比从没说过这条策略更糟**（59% vs floor 37%）。且衰减集中在**软性组织策略**（+33 到 +67 点），硬性安全规范衰减小（+0 到 +14）。其防御 "Constraint Pinning"（约 47 tokens，声称把违规率恢复到 0%）属于**训练无关**方案。

关键的一点：该文明确验证了**受影响的通道正是 harness 会压缩的那些通道**——策略放在**被保留的 system message** 里衰减为 +0，而放在**standing user instruction**（+50）、**memory 条目**（+45）、**tool output**（+33）里则大幅衰减。

**对照 craft**：我实测确认 `agent-loop.ts` 中**既没有 compaction 也没有 system 消息保护**（grep `compact|summar|truncat` 只命中 budget/halt 相关）。这意味着：

- craft **目前还没有**这个漏洞的触发路径（因为没有压缩，历史不会被静默丢弃）
- 但 craft 的治理约束**恰恰大量存放在 memory 与 tool output 通道**——即该文指出的最脆弱通道
- 所以一旦 craft 引入任何形式的上下文压缩（`ReversibleContext` 的 `project(maxTokens)` 已经是这个方向），**就会立刻继承这个漏洞面**

结论：这不是"我们没这个问题"，而是"**我们正在朝这个问题走过去，且尚未建护栏**"。`ReversibleContext` 的设计（段永不销毁、可 `restore`）**在结构上优于** lossy compaction，但缺 **Constraint Pinning 的完整性校验**（即"跨轮检查治理约束是否仍在上下文里"）。这是一个具体、可实现、有外部证据支撑的缺口。

### 纠正 3：把 Anthropic 单来源当方向性依据

上一轮引用的 49%/67% 检索提升、90.2% 多智能体等数字，全部来自 Anthropic 自家博客与自家 eval，**无独立复现**。这一轮拿到了多来源（含同行评审）材料，结论方向大体一致（provenance、多路检索、RRF、bounded context 都被独立提出），但**具体数字不可跨厂商外推**。此后引用必须注明来源与口径。

## 三、真实剩余缺口（按证据强度与可实现性排序）

### G1（A 级证据）跨轨迹抽象 / 经验提炼缺失 —— 最结构性的一处

- **依据**：ACL 2026 两篇独立指向同一能力（Experience 阶段 + cross-trajectory abstraction；MUSE 的 post-execution critique）
- **现状**：craft 的经验捕获是**单轨迹内**的打分（`decideExperienceCapture` 的 outcome/corrections/retries/breadth/novelty），`buildExperienceRecord` 产出单条 `experience`。没有任何路径把 N 条轨迹合并、去重、抽象成一条更高层经验
- **为什么重要**：这正是"自进化"区别于"记录日志"的分界线。没有它，craft 有 Reflection 但没有 Experience
- **可验证的判据**：能否从 k 条独立轨迹产出一条被复用的抽象，并证明它对**新**任务的首次成功率有提升（MUSE 声称的 cross-task transferability 就是这种检验）

### G2（B 级证据）上下文治理护栏缺失 —— 方向正确但无护栏

- **依据**：Governance Decay（compaction 后违规 0%→30%，软策略 +33~+67 点）
- **现状**：无 compaction（暂无漏洞触发路径），但治理约束存于 memory/tool output 通道
- **缺**：约束的**跨轮完整性校验与重注入**（Constraint Pinning 式）；`ReversibleContext` 只保证"可恢复"，不保证"治理约束仍在视野内"
- **可验证的判据**：构造"策略存在 → 压缩 → 触发请求"的场景，断言违规率不因压缩而上升（该文的 ConstraintRot 就是可直接借鉴的确定性 grader 思路）

### G3（A 级证据）记忆失败分类学未建模 —— 可诊断性缺口

- **依据**：Eywa 的 8 类失败分类学，核心论点是端到端单分数无法定位层
- **现状**：craft 已有 per-memory `reason`、`omitted_count`、`retrieval_mode`——**已有原料**，但没有把它们组织成可归因的分类结论
- **缺**：把一次失败归因到 coverage/grounding/revision/scope/temporal/retrieval/synthesis 的具体一层
- **注**：craft 在这点上**基础好于**多数系统（receipt 文化已经很强），属于"差一层归纳"而非"差能力"

### G4（A 级证据）多跳 / 实体图检索偏弱

- **依据**：Eywa 的多路检索含 entity/graph 通道，并把"多会话/关系型"问题的 graph 权重设为 3.0；A-MEM/GraphRAG/HippoRAG 均以关系结构为核心
- **现状**：`knowledge-relation.ts` 有 `neighbors` 一跳遍历（:180），`RELATION_KINDS` 有 6 种关系——**单跳已具备**
- **缺**：多跳扩展、按查询形状加权、跨知识对象的关系路径检索
- **与纠正 1 的关系**：这是 A1 被证伪后的**真实残量**——不是"没有双时态"，而是"图只走一跳"

### G5（C 级证据）MCP 2026-07-28 只做了评估，未做实现

- **依据**：[MCP 2026-07-28 spec](https://blog.modelcontextprotocol.io/posts/2026-07-28/) 与 [Oracle Java 迁移实践](https://inside.java/2026/08/12/java-mcp-migration/)
- **现状**：v0.12.33 产出的是**评估**（`MCP_ASSESSED_REVISION`、`assessMcpMigration`），不是实现。实测 grep 确认 `Mcp-Session-Id` / `Mcp-Method` / `MCP-Protocol-Version` / `server/discover` **在源码中完全不存在**
- **spec 变化要点（C 级）**：核心转为**无状态 HTTP**，移除 `Mcp-Session-Id` 与 `initialize`/`initialized` 交换；每个请求带 `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name`；`server/discover` 取代握手；`tools/list` 可带 `ttlMs`/`cacheScope`；tool schema 可用 JSON Schema 2020-12，`structuredContent` 不再限对象
- **迁移要点**：把跨调用状态从协议层移入应用层，用显式 id/handle 传递；Roots/Sampling/Logging 已废弃，最早移除窗口 2027-07，但该文建议不要等到那时
- **对 craft 的具体风险**：craft 的 `mcp-http.ts` 是否依赖 session 语义需要单独核实（**本轮未核实，不臆断**）

### G6 删除 / 遗忘语义（Eywa 强调，与合规强相关）

- **依据**：Eywa 把"每个 evidence 记录必须可按用户范围删除"列为设计目标之一；MemoryBank 一系也有 forgetting 机制
- **现状**：craft 有 `revoked`/`expired`/`superseded` **状态迁移**（不删历史，这是对的），但 grep `delet|erase|forget` 在 `workbench.ts` 只命中无关的图遍历变量
- **判断**：craft 的"绝不删除、只标记"在审计上是对的，但**是否满足真实的数据删除请求（被遗忘权）是另一个问题**——状态标记不等于物理擦除。这需要产品层面的决策，我**不主张**现在改

## 四、非目标（明确不做，附理由）

- **A1 原样（"缺双时态/KG"）**：纠正 1 已证伪，不作为缺口。真实残量降级为 G4
- **参数级持续学习 / 权重更新**：与 craft 的"证据与治理分离"架构根本冲突，且本轮所有 A 级来源都走**非参数**路线（external memory + 推理期改进）
- **向量数据库选型替换**：Eywa 的 90.19% 来自其**完整架构**（provenance + 多路 + 确定性规划器），不是来自某个向量库；把分数归因给存储层是误读
- **物理擦除 / 被遗忘权实现**：需要产品与合规决策，非工程单方面可定（见 G6）

## 五、结论：距离理想态还差什么

一句话：**craft 在"治理与审计"上已明显领先于这些外部系统，差的是"从经验中抽象"和"知道自己为什么错"。**

- 外部系统（Eywa、MUSE）在**能力指标**上有公开数字，craft 没有可比的对外基准——这是**测量缺口**，不是能力缺口，但无法证伪就无法进步
- craft 的 receipt / 授权 / tier / 证据链文化**强于**上述论文描述的系统（那些系统多不强调执行授权分层）
- 真正的结构性差距只有两条：**G1（跨轨迹抽象）**与 **G3（失败归因）**；**G2** 是方向正确但缺护栏（且一旦引入压缩就立即暴露）

**因此下一步的最高价值动作不是再补能力，而是：先建 G2 护栏（因为方向已经在走），再做 G1 的跨轨迹抽象，同时用 G3 的分类学把失败变成可归因信号。** 没有 G3，G1 做出来的抽象**无法被证伪**——这也是为什么上一轮那些 Anthropic 数字无法外推：它们缺的正是可归因的中间层。

## 附：本文引用的来源

| 来源 | 类型 | 用于 |
|---|---|---|
| [ACL 2026 Findings 2069](https://aclanthology.org/2026.findings-acl.2069/) | 同行评审综述 | 三阶段框架、跨轨迹抽象 |
| [ACL 2026 Findings 1522 (MUSE)](https://aclanthology.org/2026.findings-acl.1522/) | 同行评审 | 执行后批判、性能随洞察累积 |
| [Eywa (arXiv 2605.30771)](https://ar5iv.labs.arxiv.org/html/2605.30771) | 预印本 + 公开 artifact | 失败分类学、evidence before belief、多路检索 |
| [Governance Decay (arXiv 2606.22528)](https://ar5iv.labs.arxiv.org/html/2606.22528) | 预印本 + 公开 benchmark | 压缩导致的治理衰减、Constraint Pinning |
| [MCP 2026-07-28 spec](https://blog.modelcontextprotocol.io/posts/2026-07-28/) | 规范 | 无状态核心、协议头、discovery |
| [Oracle Java MCP 迁移](https://inside.java/2026/08/12/java-mcp-migration/) | 工程实践 | 兼容优先的迁移做法 |
| [AI Agent Memory Architectures (Zenodo)](https://zenodo.org/records/21921640) | 预印本 | 情景/语义/工作记忆分层（旁证） |
