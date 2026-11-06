# Craft 现状差距与下一版本迭代方案

> as_of: 2026-09-12
> 代码基线: v0.11.62（`main` @ `05f096e`）
> 方法: 通读 `src/` 89 个 TS 文件 + `docs/` 76 篇文档 + 业界一手资料；所有结论标注可查依据。
> 本文是工程判断，不是对运行时效果的断言。

## 结论（先看这段）

**Craft 的问题不是"缺东西"，是"多东西"。**

在治理、证据、评测这三个维度上，Craft 已经**超前于业界主流实践**——业界 2026 年才形成共识的 Harness 分层、验证循环、held-out 门禁，Craft 早已有完整实现且有 100% 覆盖率门禁兜底。全库零 `TODO/FIXME`，485 个 MCP 工具**全部有 handler，没有一个是空壳**。

但有一个错位极其刺眼：

> **Craft 全身上下都在承诺"最小安全面"，唯独它自己的工具面是 485 个全量注入（≈57.4k tokens）。**

这与三重证据同时冲突：

1. 与自己的 skill 契约冲突 —— `craft-route/SKILL.md` 开篇即写 "Route substantial work through Craft's **smallest safe** MCP surface"；
2. 与自己的研究结论冲突 —— `industry-agent-runtime-next-2026-09-11.md:62` 要求"仅向当前 Host 交付有预算、理由、版本和 scope 的**少量**材料"；
3. 与业界硬数据冲突 —— Vercel 移除 80% 工具后效果更好；Claude Code 延迟加载实现 95% 上下文削减；Anthropic 明示"只暴露当前步骤所需的最小工具集"。

**所以下一版（v0.11.63）的主线建议：把"最小安全面"从口号变成机制。**

---

## 一、现状盘点

### 1.1 代码侧：完成度比文档承诺的更高

| 维度 | 事实 | 依据 |
| --- | --- | --- |
| 规模 | 89 个扁平 TS 模块，无子目录；`service.ts` 3382 行主门面，`service-foundation.ts` 组合 68 个 kernel | `src/service.ts`、`src/service-foundation.ts` |
| 占位代码 | **全库 `TODO`/`FIXME`/`HACK` = 0**；唯一的 `PLACEHOLDER` 是 `workflow.ts:6` 的模板变量替换功能，非占位 | 全库检索 |
| 工具面 | 同一份代码 + 白名单，非两套清单。`mcp.ts:29` `TOOLS`(485) → `mcp.ts:693` `CORE_TOOL_NAMES` → `mcp.ts:696` `CORE_TOOLS` | `src/mcp.ts` |
| 死代码 | 除入口 `cli.ts` 外，所有模块均被 import | — |
| 持久化 | `node:sqlite` `DatabaseSync`，`~/.craft_data/db/craft.db`，三表 `meta`/`records`/`events`，records 按 `(kind,id,version)` 版本化 | `src/store.ts:2,37-48`、`src/paths.ts:34` |
| 测试门禁 | lines/functions/branches **均 100%**，`scripts/test.ts:30-32` 硬编码 | `scripts/test.ts` |

**代码级缺口几乎不存在。** 真正的"预留"集中在产品能力，不在代码占位。

### 1.2 文档侧：规划清楚，但基线滞后

- 权威差距分析是 `docs/research/industry-agent-runtime-next-2026-09-11.md`，其**读取基线是 v0.11.41**，而当前已是 **v0.11.62**——滞后 21 个版本。
- `agent-harness-capability-gap-2026-09-08.md` 是 v0.9.4/v0.9.5 时期的历史基线，文档自己已标注"时效警示"（:6），**不应再作为当前差距依据**。
- N1–N4 切片规划明确（`industry-...-next-2026-09-11.md:93-152`），顺序结论是**先 N1+N2，再 N3，N4 最后**（:152）。
- **但文档中 N1–N4 无一条标注完成状态**，包括 N1。

### 1.3 关于"N1 已跑通"的更正

本地记录（`.workbuddy-ai/memory/2026-09-12.md:49-58`）记载 N1 闭环已跑通，证据链完整：

```text
source(1) → capability(3) → task(1) → route(1) → checkpoint(5)
→ route_receipt(6) → artifact(7) → evidence(8) → trial(1)
→ outcome(1, passed)，route.status=completed
task_id  task_3f3e989bfc1546a1a4b58e914ab68061
route_id route_e8e05f867eaf41ff9f46c162ef0ad4e4
```

**但这只验证了 happy path，N1 的验收标准一条都没过。** N1 原文验收要求（`industry-...-next:109`）：

> 选择一个研发任务和一个视频/文件任务；中途**人工修改、Host 中断、审批过期和输入漂移**均能如实进入重新规划/人工处理；不得把进程完成当交付完成。

对照实际：只跑了一个任务、没有人工修改、没有 Host 中断、没有审批过期、没有输入漂移、没有视频域任务。而且这次运行是**通过 `.workbuddy-ai/tools/craft-call.mjs` 手动逐阶段驱动 MCP 工具**完成的，并非 Craft 自主闭环，也不是真实 Host（Codex/Claude）执行。

**准确表述应为：N1 的机制链路被手动验证过一次 happy path；N1 验收未达成。**

这条更正很重要——否则会在"已完成"的错误前提上规划下一步。

---

## 二、业界坐标（2026 年 agent harness 共识）

### 2.1 核心范式

**Agent = Model + Harness**（LangChain Vivek Trivedy: "如果你不是模型，你就是 Harness"）。术语由 Mitchell Hashimoto 于 2026-02 提出，OpenAI 于 2026-02-11 发布完整方法论。

三层同心圆：提示工程 ⊂ 上下文工程 ⊂ **Harness 工程**（工具编排、状态持久化、错误恢复、验证循环、安全执行、生命周期）。

### 2.2 量化证据（全部来自公开一手数据）

| 结论 | 数据 | 来源 |
| --- | --- | --- |
| 只改 Harness，不动模型权重 | Terminal-Bench 2.0: 52.8% → 66.5%，**+13.7 个百分点**（相对提升约 26%） | LangChain DeepAgents, 2026 |
| 同上（另一口径） | 同一模型换 harness 基础设施，从 30 名开外 → 第 5 名 | LangChain, TerminalBench 2.0 |
| 验证循环的价值 | "给模型一种验证工作结果的方式可以将质量提高 **2 到 3 倍**" | Boris Cherny, Claude Code 创造者 |
| 工具越多越差 | Vercel 从 v0 移除 **80% 工具**，结果更好 | Vercel |
| 延迟加载工具 | Claude Code 实现 **95% 上下文削减** | Anthropic |
| 上下文压缩收益 | ACON: 减少 **26–54% token** 同时保留 95%+ 准确率 | ACON 研究 |
| 上下文腐烂 | 关键内容落在窗口中间位置时，模型性能下降 **超过 30%** | Chroma / "Lost in the Middle" |
| 错误复合 | 10 步流程每步 99% 成功率 → 总成功率仅约 **90.4%** | 业界测算 |
| 计划-执行分离 | LLMCompiler 比顺序 ReAct **快 3.6 倍** | LLMCompiler |

### 2.3 七个架构决策（业界共识）

1. **单 Agent vs 多 Agent** —— Anthropic 与 OpenAI 都说：**首先最大化单 Agent**；只在工具负载超过约 10 个重叠工具、或存在明显分离的任务领域时才拆分。
2. **ReAct vs 计划-执行** —— 各有适用面。
3. **上下文管理** —— 五种生产方法：基于时间清除、对话总结、观察掩码、结构化笔记、子 Agent 委托。
4. **验证循环** —— 计算验证（测试/linter）给确定性 ground truth；推理验证（LLM 裁判）补语义但增延迟。ThoughtWorks 框架：**指南**（前馈）vs **传感器**（反馈）。
5. **权限架构** —— 宽松（快但险）vs 限制（安全但慢）。
6. **工具范围** —— **更多工具通常意味着更差性能**；原则是"只暴露当前步骤所需的最小工具集"。
7. **Harness 厚度** —— 薄 Harness 赌模型进步 vs 显式控制。Anthropic 定期从 Claude Code 删除规划步骤，因为新模型已内化该能力。

### 2.4 对未来 12–24 个月的判断

- **模型能力提升会压缩固定 Harness。** 复杂 role-play、冗长 planning、固定上下文重置会被更强模型淘汰；**持久状态、动作边界、证据与评测会保留**，因为它们描述的是外部世界而非模型能力。
- **脚手架会被拆除。** Manus 六个月内重建五次，每次重写都在**去除**复杂性；复杂工具定义 → 通用 shell 执行。
- **"未来验证测试"**：如果性能随更强模型提升而**不需要增加 Harness 复杂性**，这个设计就是合理的。
- **竞争点从"会不会调用工具"转为"能否在真实状态中连续、可审计地完成工作"。**

### 2.5 Craft 与业界坐标对照

| 业界共识 | Craft 现状 | 判断 |
| --- | --- | --- |
| 验证循环是分水岭 | `verified-work-loop` + Acceptance Adapter + 100% 覆盖率门禁 | ✅ **超前** |
| held-out / 多次 Trial / Signoff / Canary | Trial/Trace/Outcome/Signoff/Canary 全链路 | ✅ **超前** |
| 单 Agent 优先，多 Agent 非默认 | 文档明确反对默认多 Agent | ✅ 对齐 |
| 长任务靠外部结构化状态 | Task Contract + Snapshot + Context Capsule + Checkpoint | ✅ 对齐 |
| 分布式指令手册，单片不超 200 行 | `craft-route` 单 skill，已收窄 | ✅ 对齐 |
| 确定性传感器先行 | 覆盖率门禁 + `file_artifact`/`media_probe`/`coverage_report` 检查器 | ✅ 对齐 |
| **工具面只暴露当前所需最小集** | **485 工具全量注入 ≈57.4k tokens** | ❌ **反向** |
| 硬边界（沙箱/目录/网络） | 有协议与 Profile，但**真实隔离未做 Conformance 验证** | ⚠️ 待验证 |
| Harness 变薄 | 68 kernel + 485 工具，仍在增长 | ⚠️ 需警惕 |

**一句话：Craft 在"治理与评测"上领先业界，在"工具面经济性"上落后业界。**

---

## 三、差距清单

按"该不该做"分三类，避免把有意设计误当缺陷。

### 3.1 真实缺口（建议处理）

| # | 缺口 | 依据 | 严重度 |
| --- | --- | --- | --- |
| G1 | **工具面未最小化**：485 工具全量注入，与自身"最小安全面"承诺及业界方向冲突 | `mcp.ts:29,693`；实测 core 69 工具 = 26,316 字符 ≈7.5k tokens，full 485 工具 = 201,018 字符 ≈57.4k tokens | **高** |
| G2 | **N1/M1 未真实验收**：只跑过 happy path，中断/漂移/审批过期/人工修改/双领域全未验证 | `industry-...-next:109`、`roadmap:111` | **高** |
| G3 | **文档基线滞后 21 个版本**：权威差距文档读取基线 v0.11.41，当前 v0.11.62；N1–N4 无完成状态标注 | `industry-...-next:6` | 中 |
| G4 | **无 SQLite 迁移机制**：`SCHEMA_VERSION=3` 但只有 `CREATE TABLE IF NOT EXISTS` + 版本上界校验，无逐步迁移脚本 | `store.ts:5,50-56` | 中 |
| G5 | **若干"薄壳"模块**：功能完整但仅 store 直读/投影，无独立业务逻辑 | `work-delivery.ts`(25行)、`adaptive-harness.ts`(26行)、`delivery-loop.ts`(34行)、`eval-campaign-report.ts`(40行) | 低 |
| G6 | **`host-driver.ts` 只有接口无实现** | `src/host-driver.ts`(12行) | 低（属预留设计） |

### 3.2 有意留白（**不建议**当缺陷处理）

这些都是文档中明确"先不做"或"按依赖后置"的，属于清醒的架构决策，不是遗漏：

- **standalone model loop 未实现** —— `cli.ts:92,266` 明示 "standalone model loop is not included yet"。这是**长期目标**（自主 Agent 平台）的核心，短期定位是跨宿主治理层，**现在做反而违反路线 A**。
- **onboarding UI 未实现** —— `README.en.md:87`。属产品化后置。
- **远程 Hub / A2A 商店、多 Agent、自动自进化、直接执行模型生成代码** —— 文档明确反对或要求前置条件（`industry-...-next:132-139`）。
- **沙箱真实隔离未验证** —— 对应 N3，文档要求"不满足 Conformance 的后端无法领取 Ticket"，是**正确的不作为**。
- **内容创作方向空白** —— `小说` 在 docs/ 与 src/ 中零出现；视频仅做验收不生成。属"后续领域扩展"，非当前主线。

### 3.3 一个需要警惕的结构性风险

Craft 的 Harness **在持续变厚**（68 kernel → 485 工具），而业界共识是**模型变强时 Harness 应变薄**。

这不是说 Craft 做错了——治理层的厚度是它的**差异化价值**，且业界也承认"持久状态、动作边界、证据与评测会保留"。但需要区分：

- **该保留的厚**：治理、证据、评测、状态（描述外部世界，与模型能力无关）
- **该收窄的厚**：工具暴露面、提示词堆叠、固定流程（描述模型能力假设，会被模型进步淘汰）

**G1（工具面）恰好属于后者。**

---

## 四、版本迭代方案

### v0.11.63 —— 最小安全面（Minimal Safe Surface）

**主题**：把"最小安全面"从文档承诺变成可验证机制，同时补齐 N1 验收。

**为什么是这个而不是别的**：

- 它是唯一"自身承诺 × 业界数据 × 可量化验收"三者同时指向的缺口；
- 它是 N1 的前置条件——`Activation Plan` 的核心语义就是"最小激活"，工具面不收窄，激活治理就是空转；
- 它可以**在本机完整验证**（不需要 Codex/Claude/Docker）；
- 它直接降低每次会话的固定成本（57.4k → 约 7.5k tokens），对老板日常使用是**立刻可感的收益**。

### 4.1 主线 A：工具面分片（Profile-based Sharding）

**问题**：宿主在会话启动时固定工具面，无法运行时动态加载。所以"渐进披露"在本机不可行，**只能预先分片**。

**方案**：把 485 个工具按域切成若干自包含入口，每个入口是一个独立的 MCP server 定义。

```text
现状:  craft-mcp(69)  craft-mcp-full(485)
目标:  craft-mcp(69, 常驻)  +  按域分片的可选入口
```

建议分片（按 `src/mcp.ts` 已有语义聚类）：

| 入口 | 覆盖域 | 预估工具数 |
| --- | --- | --- |
| `craft-mcp` | 路由 / 任务 / 检查点 / 证据 / 验收（**默认面，保持不变**） | 69 |
| `craft-mcp-governance` | Capability / Connector / Source / Certification / Supply Chain | ~90 |
| `craft-mcp-execution` | Sandbox / Effect / Egress / Credential / Fabric / Managed Run | ~85 |
| `craft-mcp-eval` | Evaluation / Campaign / Benchmark / Judge / Harness / Signoff | ~95 |
| `craft-mcp-knowledge` | Wiki / Claim / Context / Knowledge / Domain Kit | ~80 |
| `craft-mcp-enterprise` | A2A / Enterprise / Hub / Federation / Autonomy | ~70 |
| `craft-mcp-full` | 全量（保留，供管理场景） | 485 |

**硬约束**：

- 分片必须**完全覆盖** 485 个工具，无遗漏、无重复——用测试断言（`union(shards) === TOOLS`）；
- 每个分片是**同一份代码 + 不同白名单**，不复制实现（延续 `CORE_TOOL_NAMES` 模式）；
- 100% 覆盖率门禁**不得放宽**；
- 分片定义放在 `src/mcp.ts`，新增 `SHARD_TOOL_NAMES` 映射。

**收益**：默认面从 57.4k tokens 降到 7.5k；需要哪个域时挂哪个域，单域最坏情况 ≈10k tokens。

### 4.2 主线 B：N1 验收补齐

把 N1 的验收标准真正跑一遍，**用 WorkBuddy 作为 Host**（本机唯一可用 Host，且符合路线 A）：

| 验收项 | 做法 |
| --- | --- |
| 研发任务闭环 | 一个真实小任务走完 Brief → Activation → Preflight → Dispatch → Receipt → 再观察 → Acceptance → Outcome |
| 视频/文件任务闭环 | 用 `file_artifact` 或 `media_probe` 做确定性验收（不生成视频） |
| 人工修改 | 任务中途改文件，断言产生 `HumanStateEvent` 且旧路径转 `needs_replan` |
| Host 中断 | 中断后恢复，断言不把进程完成当交付完成 |
| 审批过期 | 构造过期授权，断言失败关闭 |
| 输入漂移 | 改变输入摘要，断言拒绝复用旧事实 |

**产出**：一份带真实 task_id/route_id/receipt 的验收报告，并**在文档中标注 N1 真实状态**。

### 4.3 主线 C：文档与实现对齐（低成本高价值）

- 更新 `industry-agent-runtime-next-2026-09-11.md` 读取基线至 v0.11.62；
- 为 N1–N4 增加**状态标注**（未开始 / 进行中 / 已验收），避免下次再从错误前提出发；
- 在 `roadmap.zh-CN.md` 补 v0.11.63 条目。

### 4.4 验收标准

| 项 | 标准 |
| --- | --- |
| 工具覆盖 | `union(所有分片) === TOOLS`(485)，且分片间无重复，测试断言 |
| 默认面 | `craft-mcp` 仍为 69 工具，`tools/list` 字符数不增加 |
| 单域开销 | 任一分片 `tools/list` ≤ core 的 1.5 倍 |
| 覆盖率 | lines/functions/branches 保持 **100%**，不新增 ignore 指令 |
| N1 | 六项验收全部有真实 receipt，报告落盘 |
| 回执 | 按 craft route 要求产出 `git_diff` / `focused_test` / `coverage` / `review` |

### 4.5 明确不做（本版本）

- ❌ 不做 standalone model loop（违反路线 A，属长期目标）
- ❌ 不做沙箱真实隔离验证（属 N3，前置未满足）
- ❌ 不做多 Agent / 远程 Hub（N4，需 N1–N3 数据）
- ❌ 不重构 68 个 kernel（现状健康，无收益）
- ❌ 不放宽覆盖率门禁

---

## 五、优先级建议

| 顺序 | 内容 | 理由 |
| --- | --- | --- |
| 1 | **A：工具面分片** | 唯一"承诺 × 业界 × 可验收"三重指向；立刻降低会话固定成本 |
| 2 | **B：N1 验收补齐** | 文档自己定的下一步；不做则所有"已跑通"表述都不可信 |
| 3 | **C：文档对齐** | 低成本，防止后续在错误基线上规划 |

A 与 B 可并行（A 是工程改动，B 是验证工作）。C 随 A/B 完成同步落地。

---

## 附：本文依据索引

| 类型 | 路径 / 来源 |
| --- | --- |
| 权威差距分析 | `docs/research/industry-agent-runtime-next-2026-09-11.md` |
| 历史基线（已过时） | `docs/research/agent-harness-capability-gap-2026-09-08.md` |
| 产品路线与 M1–M3 | `docs/product/roadmap.zh-CN.md` |
| 工具面定义 | `src/mcp.ts:29,693,696,703-706` |
| 持久化 | `src/store.ts:2,5,37-56`、`src/paths.ts:34` |
| 覆盖率门禁 | `scripts/test.ts:30-32` |
| N1 本地运行记录 | `.workbuddy-ai/memory/2026-09-12.md:49-58` |
| 业界：Harness 解剖 | lilinji.github.io/2026/05/agent-harness 的解剖（2026-05-21） |
| 业界：Harness Engineering | api.treerouter.ai/en/blog/harness-engineering-ai-agent-guide（2026-09-05） |

---

## 六、实施记录（v0.11.63，2026-09-12）

主线 A（工具面分片）已实施，并全程走 Craft route 治理。

**改动**（4 文件，+88/-7）：

| 文件 | 变更 |
| --- | --- |
| `src/mcp.ts` | 新增 `SURFACE_RULES` / `SURFACE_NAMES` / `domainSurfaceOf` / `surfaceToolNames`；`McpServer` 改用 surface 解析工具集；二次校验由 `mode === "core"` 放宽为 `mode !== "full"` |
| `src/mcp-stdio.ts` | `Mode` 由 `"core" \| "full"` 放宽为 `string` |
| `bin/craft-mcp.ts` | 支持 `--surface <name>` 与 `CRAFT_MCP_SURFACE`，默认仍 `core` |
| `tests/mcp.test.ts` | 新增 2 个测试：分片划分正确性 + 分片挂载与越界拒绝 |

**实测分片开销**：

| surface | tools | 字符 | ≈tokens |
| --- | --- | --- | --- |
| core | 69 | 26,246 | 7.5k |
| governance | 68 | 28,993 | 8.3k |
| evaluation | 86 | 33,755 | 9.6k |
| execution | 83 | 37,051 | 10.6k |
| knowledge | 46 | 18,549 | 5.3k |
| workspace | 31 | 12,593 | 3.6k |
| collaboration | 38 | 16,227 | 4.6k |
| workflow | 64 | 27,118 | 7.7k |
| **full** | **485** | **200,532** | **57.3k** |

**验证证据**（route `route_8aafd4ada82747afa9054a339d198c30`）：

- baseline：`git diff --check` exit=0；`tests/mcp.test.ts` 6/6
- verification：全量 **341/341** 通过、覆盖率 lines/functions/branches **均 100.00**、`tsc --noEmit` exit=0
- review：`git diff --check` exit=0，未验证风险已如实记录
- outcome：`verdict = passed`；Craft 自动产出 experience candidate（该 route_strategy 累计 2 次通过，状态 `ready_for_workflow_draft`）

**真实入口实测**（重建产物后，用 `dist/plugin/*.cjs` + stdio 协议跑 `tools/list`，而非进程内构造）：

| 入口 / 参数 | tools | 字符 |
| --- | --- | --- |
| `craft-mcp.cjs`（无参数） | 69 | 26,316 |
| `--surface governance` | 68 | 29,062 |
| `--surface evaluation` | 86 | 33,842 |
| `--surface execution` | 83 | 37,135 |
| `--surface knowledge` / `CRAFT_MCP_SURFACE=knowledge` | 46 | 18,596 |
| `--surface workspace` | 31 | 12,625 |
| `--surface collaboration` | 38 | 16,266 |
| `--surface workflow` | 64 | 27,183 |
| `--surface full` | 485 | 201,018 |
| `craft-mcp-full.cjs`（无参数） | 485 | 201,018 |
| `--surface no-such-surface` | — | 失败关闭，EXIT=1 |

默认行为与改动前**完全一致**（69 / 26,316）。

**未验证风险**（诚实记录）：

1. 仅在本机 Node 22.22.2 验证，CI 的 Node 24 未跑；
2. ~~`--surface` 未在真实入口验证~~ → **已消除**（见上表）。仍未在 WorkBuddy 的 `mcp.json` 里实际挂载，因为那是一次配置变更，需老板决定是否切；
3. 分片规则是启发式正则，未来新增工具若两条规则都不匹配会落入 `workflow` 兜底而非最优分片，目前无自动告警；
4. 未重跑 `pack:adapters`（适配器 MCP 配置未改动）；若后续要在适配器暴露分片入口需同步。

**未做 / 待办**：

- 主线 B（N1 验收补齐）**已完成**，见 §七；
- 主线 C 已**完成**：`industry-agent-runtime-next-2026-09-11.md` 已加 N1–N4 真实状态标注并更新为"N1 已验收"；
- **版本号未 bump**：代码仍为 `0.11.62`，`v0.11.63` 是本次迭代的**目标版本号**。bump 涉及约 45 处（30 个测试断言 + `scripts/check-version.ts` 校验的 6 个文件 + adapters 元数据），属发布动作，建议与 commit 一并执行，不要混进已验收的功能改动。

---

## 七、实施记录（主线 B：N1 验收，2026-09-12）

**N1 六项验收全部通过：40/40 断言。** 完整报告见 [`n1-acceptance-report-2026-09-12.md`](n1-acceptance-report-2026-09-12.md)。

验收没有走进程内直调 service，而是驱动**真实入口**：打包后的 `dist/plugin/craft-mcp-full.cjs`（stdio MCP 协议）+ `dist/src/cli.js worker tick`（CLI 维护 worker，跑内建确定性判据），数据目录用 `CRAFT_DATA_DIR` 隔离。

**Host 接入方式**：本机无 Codex CLI / Claude Code 且无网络，因此做了替身——`codex.exe`（node.exe 副本）+ 工作区内 `exec` 入口脚本，按 `N1_CODEX_MODE` 分 `ok` / `slow` / `fail` 三种行为。Craft 侧的 spawn、JSONL 解析、receipt 落盘、失败归因走**真实代码路径**，被替掉的只有"模型真的干活"。

**过程中发现并修复 2 个真实缺陷**：

| # | 缺陷 | 根因 | 修复 |
| --- | --- | --- | --- |
| D1 | **回执与观测脱钩，审计链会说谎**（严重） | 回执默认 ID 用 `snapshot.version` + `state.version` 做身份，但版本号在多次观测间会重复（新建快照版本恒为 1，内容未变的状态幂等也保持 1），第二次观测 `find` 到旧回执直接返回。实测：loop 已 `needs_replan`、最新快照 `…1ad4b22e…`，唯一回执却是 `{status:"running", snap:"…ddae77ab…"}` | 回执默认 ID 改为由观测内容寻址：`digest({task_run_state_id, snapshot_id, status, reason})`。重放同观测保持幂等，新快照/新状态/新原因必然新回执 |
| D2 | **人工修改原因被覆盖**（轻） | `decide(human_change)` 写入 `needs_replan_reason="human_change"`，随后内部 `advance` 无条件重算并覆盖成派生原因；而 `human_change` 必然伴随工作区变化，故该原因在实践中永不保留 | `advance` 改为"首个原因优先"：loop 已处于 `needs_replan` 时保留既有原因，不被派生原因覆盖 |

**验证证据**：

- 新增测试 1 个（`tests/verified-work-loop.test.ts`：回执绑定单一观测 + 显式原因优先）
- 全量 **342/342** 通过（原 341）
- 覆盖率 lines/functions/branches **均 100.00**，未新增 ignore 指令
- `tsc -p tsconfig.build.json` exit 0
- N1 验收重跑 **40/40**（D1/D2 对应断言由 FAIL 转 PASS）

**复现**：`node .workbuddy-ai/tools/n1-acceptance.mjs`（脚本自动重建隔离数据目录与工作区）。

**产物同步**：`dist/plugin/craft-mcp.cjs` / `craft-mcp-full.cjs` 已用 esbuild 重建（含 D1/D2 修复），`scripts/pack-adapters.ts` 已重跑，`dist/craft-workbuddy-expert-v0.11.62.zip`（8 项）与 `dist/craft-workbuddy-connector-v0.11.62.zip`（6 项）已刷新。`version:check`、`tsc --noEmit`、全量测试均 exit 0。

**诚实边界**：Host 是替身而非真实 Codex CLI（JSONL 事件形状的真实性未验证）；没有真实研发任务，验的是机制闭环不是生产力；视频域只验了 `file_artifact` 判据机制，未跑真实视频任务；仅在本机 Node 22.22.2 验证（CI 用 24）；未验证多 Host 并发。
