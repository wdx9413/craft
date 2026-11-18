# 通用自进化缺口：场景覆盖、价值沉淀与业界对照

调研日期：2026-11-18。范围：agent memory / self-evolving agent 的近期论文、综述、基准和开源项目。资料来自 AnySearch 检索到的论文摘要、项目页与官方仓库链接；本文区分“资料的结论”和“由资料推导的 Craft 设计判断”，不把论文结果当成 Craft 已实现或已验证的运行证据。

## 结论

**Craft 现在有了“记下来”的写入口，但还没有“跨场景判断什么值得长期保存、如何变成可复用技能、如何跨会话复用、如何评测是否真正有用”的通用自进化层。** 也就是说：对话里明确说出的规范/偏好/事实可以进入账本，但办公、编程、旅游、AI 创作、科研这些场景里大量“做过一次就知道怎么做”的运行经验，仍然缺一条从轨迹到技能、从技能到验证晋升的稳定通路。

一句话：当前像“有账本 + 有写入规则”，业界正在做的是“有记忆治理 + 有技能/程序记忆 + 有跨场景评测 + 有归档/遗忘/权限”。

## 一、资料脉络

### 1. 记忆是长任务 agent 的一等原语

- [Agent Memory Research in 2026: A Data-Driven Survey and Extended Taxonomy](https://doi.org/10.5281/zenodo.20780689) 与[伴随数据集](https://github.com/tobias-weiss-ai-xr/agent-memory-research)：把 220 篇论文按 Forms × Functions × Dynamics 组织，并补充 Temporal Dynamics、Modality、Biological Inspiration；明确指出缺少统一评测标准。
- [Graph-based Agent Memory: Taxonomy, Techniques, and Applications](https://arxiv.org/abs/2602.05665)：把记忆分为短期/长期、知识/经验、非结构化/结构化，并按生命周期拆成 extraction、storage、retrieval、evolution。
- [A Survey of Agent Memory in the Second Half](https://arxiv.org/abs/2602.06052)：强调记忆不只是被动存储，而是 agent 从经验中自我进化的基座；短期记忆筛选经验，长期记忆固化成可复用知识与技能。

Craft 对照：已有 Knowledge/Memory/Experience 三分和本体论概念层，但缺“按生命周期主动管理”的闭环：提取质量、价值评估、晋升/淘汰、跨场景迁移都还弱。

### 2. 程序记忆（know-how）是通用能力的关键缺口

- [Procedural Memory for Persistent LLM Agents: Know-How as the Missing Component](https://doi.org/10.5281/zenodo.18770868)：指出 agent 只有情景/语义记忆时，每次都要重新发现做法；提出从重复经验中抽取、存储、增量精炼程序记忆。
- [LongMemEval-V2](https://doi.org/10.48550/arxiv.2605.12493)：网页环境中，长期记忆要记住 interface affordances、state dynamics、workflow knowledge、environment gotchas、premise awareness；AgentRunbook-C 用轨迹文件 + coding agent 取证的思路明显优于纯 RAG。
- [Metis](https://arxiv.org/abs/2606.24151)：文本经验（计划、环境事实、常见坑）与代码工具互补；只有重复复用被证明有价值时，才把计划结晶为可调用工具。
- [MOBIMEM](https://arxiv.org/pdf/2512.15784)：移动端/桌面自动化里，Profile Memory、Experience Memory、Action Memory 三类记忆 + record/replay + 异常处理，能不重训模型而自进化。

Craft 对照：有 `procedure`/`workflow` 的治理结构，但目前主要靠显式提交或成功任务 finalize，缺“从重复轨迹自动提炼、按价值保留、必要时结晶为工具”的通用管线。

### 3. 跨场景通用性取决于“agent 能主动管理自己的记忆”

- [Exploring Cross-Scenario Generality of Agentic Memory Systems](https://doi.org/10.48550/arxiv.2606.04315)：在单轮 QA、多会话聊天、agent 轨迹 QA、压力测试、长任务五类场景里，自管理文本文件的 agentic harness 反而跨场景最好；关键是让 agent 主动控制存储与检索，而不是固定流水线背后的被动 store。
- [Agentic Memory (AgeMem)](https://arxiv.org/pdf/2601.01885)：把 store/retrieve/update/summarize/discard 暴露为工具动作，让 agent 策略自己决定何时存什么。
- [EvoMemBench](https://doi.org/10.48550/arxiv.2605.18421)：按 in-episode/cross-episode 与 knowledge/execution 两轴评测；没有单一记忆形式在所有场景最好，检索型更适合知识密集，程序/长期记忆更适合结构匹配的执行任务。

Craft 对照：工具面已有很多存取动作，但默认路径仍偏“context  reads + hook 窄写入”；缺一套场景无关的 memory operations policy：什么时候写、写到哪、什么时候不写、何时提升为 procedure/skill。

### 4. 自我进化需要“经验 + 资产”共进化

- [Mem²Evolve](https://arxiv.org/pdf/2604.10923)：把 Experience Memory 与 Asset Memory 联动，用经验指导动态创建工具/专家 agent，同时用新经验反哺资产，优于只积累经验或只造资产。
- [MAGE](https://arxiv.org/abs/2605.10064)：用四子图协同知识图保存失败纠正、成功推理轨迹、任务/技能路由信号，冻结 backbone 也能稳定提升。
- [EXG](https://arxiv.org/pdf/2605.17721)：把成功/失败组织成 experience graph，支持在线增长与离线复用。
- [Memento-Skills](https://arxiv.org/abs/2603.18743)：结构化 markdown skills 作为持续演化的记忆，通过 Read–Write Reflective Learning 更新扩展技能库。
- [OPD-Evolver](https://arxiv.org/pdf/2606.17628) 与 [MemEvolve](https://doi.org/10.48550/arxiv.2512.18746)：不只存经验，还要学会“选取经验、使用经验、写知识、维护仓库”这类 evolve 能力，甚至元进化记忆架构。

Craft 对照：Mod 是认知约束；Knowledge/Memory/Experience 是账本；Workflow/Skill Candidate 有治理晋升。但“经验 → 新工具/新能力 → 再产生经验”的共进化闭环还没有连起来，尤其缺自动创建/验证轻量能力资产的通道。

### 5. 多模态/创作/科研场景：目前基本未覆盖

- [M3-Agent](https://arxiv.org/pdf/2508.09736)：以实体为中心组织 episodic/semantic 多模态长期记忆，处理长视频与视觉听觉输入。
- [WorldMM](https://arxiv.org/abs/2512.02425)：长视频推理同时使用文本、视觉、多时间尺度记忆。
- [V-Mem](https://arxiv.org/abs/2608.01543)：指出多模态记忆的 modality gap 与 similarity-relevance gap，需要按查询/证据模态路由检索。
- [MMA](https://arxiv.org/pdf/2602.16493)：多模态记忆要动态可靠性评分、来源可信度、时间衰减、冲突共识，必要时 abstain。
- [ Talk, Imagine, Evolve](https://doi.org/10.1145/3746027.3754467)：统一对话式图像/视频生成与编辑，说明创作场景需要“意图—素材—版本—工具路径”的连续状态。

Craft 对照：当前 ontology 和 context 投影本质文本化；没有图像/视频/音频/幻灯片等 artifact 的版本记忆、风格偏好记忆、工具链 procedure，也没有多模态检索路由和可靠性评分。

### 6. 办公/共享/治理/遗忘是生产落地门槛

- [GateMem](https://doi.org/10.48550/arxiv.2606.18829)：医疗、办公、教育、家庭等多主体共享记忆，必须同时满足效用、访问控制和主动遗忘；现有方法难以三者兼得。
- [PM-Bench](https://arxiv.org/abs/2607.12385)：prospective memory（到未来某个线索/状态时执行意图）仍很弱，最好方法也只有 65.1 F1。
- [Agent Memory: Characterization and System Implications](https://doi.org/10.48550/arxiv.2606.06448)：系统视角下，记忆构建、检索、生成的成本分布差异很大，需要 freshness-latency 权衡、构建调度、fleet 管理。
- [Cognis](https://doi.org/10.48550/arxiv.2604.19771)：生产级对话记忆使用 BM25 + 向量 + RRF， ingested 前先查已有记忆做版本跟踪，temporal boosting 与 rerank。

Craft 对照：已有 scope/expiry/revoke/conflict/evidence，这是好基础；但还缺多主体权限评测、主动遗忘评测、prospective memory（提醒/定时/条件触发）、构建成本与新鲜度调度。

## 二、按用户列出的场景看覆盖度

| 场景 | 现在能积累什么 | 缺口 | 业界方向 |
|---|---|---|---|
| 编程 | 用户明说的规范/偏好；部分成功任务的 Experience finalize | 库/框架事实、调试策略、错误模式、代码 patch 与测试证据未自动结构化；重复修复不会自动变工具 | LongMemEval-V2 的 environment gotchas/workflow；Metis 文本→代码工具；EXG 经验图 |
| 办公 | 明说的流程和偏好 | 文档/PPT/表格模板、会议决议、项目状态、附件版本与权限未见结构化记忆；跨会话续写弱 | GateMem 多主体治理；PM-Bench 意图/提醒；MOBIMEM record/replay |
| 旅游 | 偏好/预算/目的地事实可进账本 | 行程动态状态、地理/时间约束、临时变更、预订证据、警告与失效未建模 | LongMemEval-V2 dynamic state tracking；Cognis temporal boosting |
| AI 创作（文本/视频/图片/文章） | 文本偏好/规则可进账本 | 风格档案、素材引用、生成参数、版本谱系、失败/成功 prompt 与 tool chain 未沉淀；多模态记忆几乎空白 | M3-Agent/WorldMM/V-Mem 多模态记忆；Talk Imagine Evolve 的创作状态 |
| 科研 | 明说的事实/术语/决定可进账本 | 文献证据、实验假设、参数、结果、反例、可复现步骤未形成研究记忆图；失效传播不够 | MAGE 四子图；EXG 成功/失败图；Graph-based Agent Memory |

## 三、对“重复度高、有效、有价值的内容是否都要沉淀”的判断

**不应该全部沉淀，但应该全部经过价值判定。** 业界经验一致：把所有轨迹存起来会产生噪声、权限/遗忘风险和高成本；只把能重复复用的 know-how、被证据支持的事实、稳定偏好、已验证的工作流沉淀，才是有效自进化。

建议把“值得沉淀”拆成五个gate：

1. **可独立理解**：能通过 ontology 的 readability check，不是 “这个/上面那个”。
2. **重复或高价值**：同类信号出现次数达阈值，或由明确用户指令/强结果证据标记。
3. **可验证或有来源**：事实有 evidence；过程有成功/失败轨迹和 verifier；偏好由用户明确表达。
4. **可迁移**：带 scope/domain/device/repo/artifact 等适用边界，避免跨域污染（项目已有 domain isolation 基础）。
5. **可治理**：能被 review、expire、revoke、supersede、rollback；推理结果不直接当事实。

落地形态建议：

- `fact/rule/decision/term/preference` → Knowledge/Memory ledger（已有基础）。
- **procedure candidate** → 由重复轨迹提炼，先 diagnostic，不直接执行；验证后晋升为 workflow/skill/tool。
- **gotcha/failure mode** → 失败归因 → Mod 候选或 Experience observation，必须过 shadow/eval 才能影响行为（已有 Mod 门禁基础）。
- **artifact/style/version** → 新增创作场景记忆：素材、生成参数、版本关系、用户选择原因，人和模型都可读。

## 四、Craft 下一步演进建议（按优先级）

### P0：把“价值决策”做成统一内核，而不是散落在 hook 里

新增一个场景无关的 `EvolutionValueGate` / `learning-signal` 模块：

- 输入：用户陈述、工具轨迹、验证结果、重复次数、scope、证据。
- 输出：`store_as_fact` / `store_as_preference` / `candidate_procedure` / `candidate_mod` / `ignore` / `needs_review`。
- 约束：只输出候选和理由，不直接发布行为改变；结果带 digest 和证据引用。
- 这让办公/编程/创作/科研共用一套“什么值得学”的判断标准。

### P0：程序记忆自动提炼（know-how pipeline）

- 从 `PostToolUse + Stop` 的已验证轨迹中提取步骤模板、前置条件、适用域、失败模式、证据。
- 重复出现 >= N 次或带明确成功验证时生成 `procedure candidate`。
- 用现有 eval/signoff/canary 晋升为 routeable procedure / workflow；失败候选保留为 diagnostic。
- 这与 Mem²Evolve、Metis、EXG、Procedural Memory 的共识一致。

### P1：领域自适应与通用记忆操作策略

- 借鉴 AgeMem/AutoMEM：把 remember/forget/supersede/promote/scope/attach_evidence 做成 agent 可调用动作，但所有动作进 receipt。
- 按场景注册 domain adapter：coding/office/travel/creation/research 只提供提取提示词、价值阈值、证据类型，不复制存储内核。
- 新增 cross-scenario eval suite，复用 EvoMemBench 的 knowledge/execution × in/cross-episode 二维。

### P1：创作与多模态记忆

- 为图片/视频/文章/PPT 增加 artifact lineage：输入素材、prompt/参数、生成工具、版本、用户评价、最终选择。
- 增加 style/preference profile：可迁移的是偏好与约束，不是具体像素或某次 prompt 原文。
- 检索时先按模态/artifact 类型路由，再做文本相似；不可靠记忆要降权或 abstain（V-Mem/MMA）。

### P1：办公与共享治理

- 把会议/文档/表格/邮件类的多主体记忆纳入 scope + principal + ACL；支持 deletion request 的主动遗忘。
- 加 prospective memory：到时间点/文件变更/状态条件时提醒或恢复任务（PM-Bench 明确指出这是弱项）。
- 构建成本调度：哪些记忆同步写、哪些后台批量提炼、哪些只按需展开。

### P2：科研记忆图

- 论文/实验/假设/结果/反例/复现步骤作为结构化节点，沿 derives_from/supports/contradicts 做失效传播（Craft 已有 lineage impact 可扩）。
- 区分“文献事实”“本实验结论”“个人解释”，避免把推理写成事实。

### P2：评测

- 新增五类真实/模拟 case：coding、office、travel、creation、research；每类都测 write、recall、apply、forget、scope leak。
- 不追求一次覆盖所有场景；先每个场景一个最小闭环，用 craft-eval 固化可复现断言。

## 五、对当前实现的直接判断

- **能满足**：明确口述的 rule/fact/preference 入账本；带 evidence 与可复核的 claim；基于成功/失败轨迹的受治理经验；scope/expiry/revoke 与 Mod shadow gate。
- **半满足**：Knowledge/Memory/Experience 的概念统一和 lineage；从 prompt 到 ledger 的 hook 写入；跨域隔离的基础设施。
- **不满足**：跨场景程序记忆提炼、技能/工具共进化、多模态创作记忆、prospective memory、多主体办公治理、跨场景评测和遗忘测试。

因此，下一步不是再做更多“存进去”的字段，而是补齐 **value gate + procedure extraction + domain adapter + cross-scenario eval + multimodal artifact memory**。这才是通用自进化从“能记”走向“会学”的关键。
