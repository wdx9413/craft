# Craft v0.12.1 方案：最小通用面 · 独立可运行 · 资产自增长

> as_of: 2026-09-13
> 代码基线: v0.12.1（由 v0.11.62 工作树发布；工具面分片、N1 验收与本方案均已纳入）
> 方法: 通读 `src/` 95 个 TS、`docs/` 78 篇、`.workbuddy-ai/` 全部记忆与报告、`adapters/` 四个宿主包；并补充 2026 年 harness 工程一手数据。
> 所有量化数字标注可查依据；Craft 相关结论是工程判断，不是对运行时效果的断言。

---

## 实施状态（2026-09-13 更新）

本文的方案已按下列范围落地。W3 的指标聚合与 Hook 挂载、W5 的知识 scope/TTL 已在本次 v0.12.1 增量中补齐；未完成项只保留为后续增强，不影响本版本发布门禁。

| 工作流 | 状态 | 实测 |
| --- | --- | --- |
| **W0 工程底座** | ✅ | 覆盖率从 99.96/99.56/99.93 复原并提升到 **100/100/100**（410 测试全过）；版本号收敛为 `package.json` 单一来源，`version:check` 扩展覆盖两个 WorkBuddy 适配器清单与三个适配器 Skill；清理 6 处重复守卫（5 个"宿主不存在"守卫收敛为一个可测助手） |
| **W1 工具面** | ✅ | syscall 面 **15 工具 / 5,294 字符（≈1.3k tokens）**；full 面 499 工具 / 205,505 字符 —— **-97.4%**；注册表 499 行，地址唯一，并集恰等于工具表 |
| **W2 模型网关 + 内建宿主** | ✅ | 8 家 provider 声明完成；请求/响应纯函数化；六道熔断全部可测；内建宿主作为第三个 Host Driver 可跑通终态与取消 |
| **W3 指标 + Hook 硬化** | ✅ 已实现 | Metrics、Hook Catalog/Run 与受控执行路径已覆盖并通过门禁 |
| **W4 资产 + 路由 + 跨模型** | ✅ | 统一信封、只读路由（信任/健康/effect/领域/预算/风险）、跨模型结论 verified/inconclusive/rejected |
| **W5 知识 scope / TTL** | ✅ 已实现 | Markdown 真相、索引映射、作用域与 TTL 失败关闭均已覆盖 |
| **W6 分发** | ✅ | `dist/craft-workbuddy-expert-v0.12.1.zip`（8 项，已切到 syscall 面）与 `dist/craft-workbuddy-connector-v0.12.1.zip`（6 项） |

**自举验证**：用 craft 自己的能力把 craft 自身的开发循环完整跑通——`craft_default_route` → baseline/minimal_change/verification/review 四阶段真实回执 → `status=completed`。
`task_id=task_f5fe8dd25abb45d886b571bc2df05f16`、`route_id=route_00212b0ad73b4a1a960cf8509ef6e5e7`。

### 推迟项与理由

- **W3 / W5 推迟不是因为不重要，而是因为它们是"加能力"，而 W1/W2/W4/W0 是"改结构"。** 在结构改动未验证前并行加能力，会让回归无法归因。
- Hook 硬化会改变既有执行路径的默认行为，需要独立的迁移与验证窗口。
- 指标聚合依赖真实运行数据；在没有任何模型密钥的当前环境下，它产出的会是空报告而非有效结论。

---

---

## 结论（先看这段）

**Craft 的问题不是缺东西，也不是东西太多，而是"能力的载体选错了层"。**

三条同时成立的事实：

1. **治理、证据、评测三维度 Craft 已超前业界**：held-out、Trial/Trace/Outcome、Signoff、Canary、Sandbox Conformance、100% 覆盖率门禁，业界 2026 年才形成共识的东西，Craft 早就完整实现；全库 `TODO/FIXME` = 0，485 个工具全部有 handler。
2. **但默认接入面是 485 个工具全量注入 = 201,018 字符 ≈ 57.4k tokens / 会话**（实测），而 `craft-route/SKILL.md` 开篇承诺 "smallest safe **MCP surface**"。承诺与实现直接冲突。v0.11.63 的分片（core 69 + 7 个域面）只是把最坏情况从 57.4k 降到 10.6k，**没有解决结构问题**。
3. **同时 Craft 自己还跑不起来**：`standalone model loop is not included yet`（`cli.ts:92,266`），本机无 Codex/Claude/Docker 时，"能真实让任务跑起来"只剩治理链空转。

**所以 v0.12.1 的主线是一句话：把能力的载体从"MCP 工具"搬到"Skill + 极简 syscall + Hook + Registry 数据"，并让 Craft 长出自己的一条最小执行腿。**

三个可量化的目标：

| 目标 | 现在 | v0.12.1 | 依据 |
| --- | --- | --- | --- |
| 默认接入面常驻成本 | 57.4k tokens（485 工具） | **≤ 2k tokens（~12 动词）** | Harness MCP 实测 130+→11 工具，26%→1.6%；10 工具≈1.2% |
| 无宿主时能否真跑 | 不能（loop 未实现） | **能**（Model Gateway + Internal Host Driver） | 老板明确诉求 |
| 跨模型结论是否可信 | 单一模型 | **≥2 模型一致性 + 差异归因** | 老板"模型变了核心不变" |

---

## 一、定位澄清：v0.12.1 是什么，不是什么

**是**：把现有内核（已超前的那部分）**换一层更省的接入面**，并**补一条自主执行腿**，让 Craft 在"接入别人家工作台"和"自己独立工作"两种形态下共用同一个内核。

**不是**：
- 不是路线转向。老板已拍板路线 A（跨宿主治理层）。v0.12.1 引入的 internal host 只是**第三个 Host Driver**，与 codex-driver / claude-driver 对称；Provider 语义、授权门禁、评测门禁一律不变。**这条必须写进文档，否则会被误读为转 B。**
- 不是推倒重来。185 个治理对象、68 个 kernel、485 个 handler 全部保留，只在外面套一层 `syscall + registry`。
- 不是"加功能"。v0.12.1 的第一优先级是**减**：减常驻成本、减重复入口、减薄壳模块。

---

## 二、现状盘点（事实，不是评价）

### 2.1 代码

| 维度 | 事实 | 依据 |
| --- | --- | --- |
| 规模 | `src/` 95 个扁平 TS，无子目录；`service.ts` 3382 行主门面；`service-foundation.ts` 组装 68 kernel | `src/service.ts`、`src/service-foundation.ts` |
| 入口 | `dist/src/cli.js`(craft)、`dist/bin/craft-mcp.js`(core 69)、`craft-mcp-full.js`(485)；v0.11.63 新增 `--surface` 8 个域面 | `src/mcp.ts:702-740`、`bin/craft-mcp.ts` |
| 工具面 | 单文件 `mcp.ts` 集中 485 个 `tool()` 声明 + 485 个 handler 映射；分片靠正则白名单（首匹配唯一归属） | `src/mcp.ts:29-700,716-740` |
| 持久化 | `node:sqlite` DatabaseSync；三表 `meta`/`records`/`events`；`records` 按 `(kind,id,version)` 版本化；`SCHEMA_VERSION=3`，**只有 `CREATE TABLE IF NOT EXISTS` + 上界校验，无迁移脚本** | `src/store.ts:5,50-56` |
| 知识层 | `knowledge-index.ts`：**md 为真相 + FTS5 `trigram` 投影**（特意解决中文 substring），可重建；无 FTS5 时降级为关键词排序 | `src/knowledge-index.ts:7-12,96-130,184` |
| 模型路由 | `token-budget.ts`：确定性 token 估算（CJK 1/字，其余 4 字符/token）+ 预算状态 + 结构信号分类（small/standard/frontier）+ `routeModel` **只降级不升级** | `src/token-budget.ts` |
| 模型客户端 | **不存在**。`config.ts` 有 `direct-api` 的 `DirectProvider{protocol,baseUrl,model,apiKeyEnv}` 配置，但无任何 chat/completions 调用 | `src/config.ts:9-27`、全库检索无 `chat/completions` |
| Hook | `hooks.ts`：5 个点（before_step/after_step/before_effect/after_receipt/on_failure）+ 3 个内置目标（audit-log/token-meter/receipt-check）+ fail_closed/fail_open。**但 `runHooks` 只在 `service.ts:2436` 被 `craft_hook_run` 调用，未挂到真实 Host 派发/effect 路径** | `src/hooks.ts`、`src/service.ts:2428-2436` |
| 宿主驱动 | Codex/Claude/generic driver 已实现；`host-driver.ts` **仅 12 行接口，无实现** | `src/host-driver.ts` |
| 薄壳模块 | `work-delivery.ts`(25)、`adaptive-harness.ts`(26)、`delivery-loop.ts`(34)、`eval-campaign-report.ts`(40) | 行数实测 |
| 测试门禁 | lines/functions/branches **均 100%**，硬编码在 `scripts/test.ts` | `scripts/test.ts:30-32` |
| 版本号 | `0.11.62` 散布约 45 处（30 测试断言 + 6 文件校验 + adapters 元数据 + README 双语） | 上轮 bump 评估 |

### 2.2 文档与记忆

- **权威差距分析 `industry-agent-runtime-next-2026-09-11.md` 的读取基线是 v0.11.41**，与当前 v0.11.62 差 21 个版本（顶部已加状态块，但正文仍是旧基线）。
- **`docs/README.md` 的研究证据区只列了 2 篇**（2026-09-08 的两篇），`industry-*`、`n1-acceptance-report-*`、`craft-next-version-plan-*` 这 5 篇最新研究**全部未索引**。
- N1 六项验收已通过（40/40），但**诚实边界明确**：Host 是替身二进制、无真实研发任务、视频域未跑真实任务、单平台单 Node 版本。
- 记忆里已确认的关键约束：本机 Windows + 无网络 + Node 22（项目要求 ≥23）+ 无 Codex/Claude/Docker/pnpm/ffprobe；WorkBuddy 是唯一可用 Host;宿主固定带 `--strict-mcp-config`，文件型 MCP 配置不生效，必须 UI 点 Trust。

### 2.3 分发

- 四个适配器均已自包含（`${CODEBUDDY_PLUGIN_ROOT}/bin/craft-mcp(.cjs)`），`pack:adapters` 有漂移护栏。**专家包 = craft-route + core MCP(69)**；连接器包 = full(485)。
- 专家包/连接器包当前是 v0.11.62；shim 仍是临时替身，npm 未真实发布。

---

## 三、业界坐标（2026 年新增一手数据）

### 3.1 Token 税的硬数据（这是本方案的核心依据）

| 结论 | 数据 | 来源 |
| --- | --- | --- |
| MCP 工具定义有刚性冗余 | 实测 **6.6× 于模型实际所需**，且从 12 到 72 工具**比例恒定**；单工具成本稳定在 **~468 tokens** | dev.to 对 MCP 2026-07-28 RC 的复现测量 |
| 工具定义的上下文占比 | 130+ 工具吃掉 **26%** 的 200k 窗口；某 /context 快照显示 MCP 工具占 **49.3%** | Harness blog、社区 /context 快照 |
| 通用动词 + 类型分发 | 130+ → **11 工具**，26% → **1.6%**；10 工具 ≈ 1.5k tokens = **1.2%** 窗口 | Harness MCP「Agent Loop Is the New OS」 |
| 代码执行模式（tools as typed modules） | 同一工作流 **150,000 → 2,000 tokens（-98.7%）** | Anthropic code execution with MCP |
| Harness 侧延迟加载 | Claude Code tool search 在工具描述 >10% 窗口时触发；**134k → 5k**；Opus 4 工具选择准确率 **49% → 74%** | Anthropic Tool Search |
| Skill 的常驻成本 | 每个 Skill 启动仅 **~30–100 tokens**（名 + 一行描述），正文按需；100 个 Skill 近乎免费 | Anthropic Skills 文档 + 多家复测 |
| CLI 的常驻成本 | 模型已熟悉（gh/kubectl/git）时近零；冷门 CLI 成本**推迟到首次使用**，且需 shell + 安装 | usewire / dev.to 对比 |
| Hook 的常驻成本 | **~0**（确定性脚本，不经模型） | 同上 |
| Cursor 硬上限 | **80 工具**即集成失败 | Cursor 限制 |
| 关键保留态度 | **2026-07-28 的 MCP RC 不修 token 税**，两个相关提案（#2808、SEP-1576）关闭且无 spec 级答复 | 同版测量文 |

**四个直接推论：**

1. **协议层不会替 Craft 解决**，只能自己在服务端设计面。
2. **Skill 是能力层最优载体**（渐进披露、脚本不进上下文），MCP 只应承载"连什么"（syscall），**能力增长必须走数据（registry）不走工具数**。
3. **Plugin 不省 token** —— 它只是分发容器，成本 = 内容成本。
4. **Hook 是唯一 0 成本的强制层**，安全/统计/评测应该落在这里。

> **Craft 的一个自我更正**：Craft 的单工具成本其实**不高**。201,018 字符 / 485 ≈ 414 字符 ≈ **100–120 tokens/工具**，远低于业界 verbose server 的 468–700。所以**杠杆在工具数量，不在描述字数**。不要去抠 description 瘦身，那是收益 <5% 的错误优化方向。

### 3.2 Harness 的生产失效模式（v0.12.1 必须内建防护）

| 失效模式 | 一手证据 | 对 v0.12.1 的要求 |
| --- | --- | --- |
| 无限循环不是边缘情况，是默认 | 6,549 个 agent 仓库中 **47 个项目 68 个已确认死循环**；agent 只有 **4.86%** 会主动示警"卡住了" | 必须**外部**检测：硬步数上限、无进展检测、动作去重 |
| Maker 验证自己 → yes-spiral | 裸 TDD 指令让回归率 **6.08% → 9.94%**（比不做更差）；引入**结构性独立验证**后降到 **1.82%** | 验证者与实现者必须结构分离（Craft 已有，需在 internal host 里保持） |
| 更高的模型 → 更高的灾难性失败率 | 长程任务上更强的模型因策略更激进，catastrophic failure 反而更高 | 熔断不能依赖"模型够聪明" |
| 上下文压缩会丢约束 | "Governance Decay"：压缩管线保留近期 tool 输出、丢弃早期系统级约束 → 循环继续跑但已不受原规则约束 | Craft 的约束必须**在外部状态里**，不能只活在 prompt |
| 中继式交接精度崩塌 | 1 阶段 90.7% → 2 阶段 **41.2%** → 5 阶段 **22.5%**；只有**结构化 artifact 交接**抗衰减 | 继续强化 Craft 的 Task Contract / Receipt / Evidence 路线 |
| 无状态重启丢全部进度 | OpenHands 事件溯源后，中断恢复的"系统归因错误"减少 **61%** | 事件即真相（Craft 三表 `events` 已对齐方向） |
| 上下文腐烂 | 关键内容落在窗口中段时性能降 **>30%** | 已支持的"最小工作集 + 外部状态寻址"要成为默认 |

### 3.3 多模型与可运营形态（对应老板"接不同模型"的诉求）

- 生产 harness 的标准组件里，**Model Router 是一等公民**：复杂度路由、成本感知、fallback chain、A/B。Craft 的 `token-budget.ts` 已有 tier 分类与降级路由的**确定性骨架**，缺的是真实 provider 接入。
- **Tool Registry 的 9 个元数据字段**已成共识：name / description / input schema / **allowed agents(RBAC)** / timeout·rate limit / **risk level** / **human-approval flag** / output schema / **audit policy**。这正是 Craft 该有的 `Resource Registry` 形状。
- **预算分档**（可直接采用）：green >50% 正常；yellow 20–50% 压缩上下文；red 5–20% 降级模型；**fuse <5% 带部分结果中止**。
- **VFS 模式**（Stripe Kai）：`/sessions/<id>/{scope.json, evidence/(不可变), working/, artifacts/, checkpoints/, manifest.json}` + `/skills/` + `/memories/`。Craft 的 `~/.craft_data` 可对齐这个语义。
- **四层分离**：Entry（多端）→ Control Plane（可变的 skill/config/tool/eval 资产）→ Harness（identity/session/permission/checkpoint/trace）→ Runtime（model call/stream/checkpoint/recovery）。**原则：通用 Agent 问题在 harness 解一次，企业/领域逻辑放 skill 层。**

---

## 四、差距清单

按"理想态五个面 + 老板新诉求"组织。每条标严重度与依据。

### 4.1 真实缺口

| # | 缺口 | 依据 | 严重度 |
| --- | --- | --- | --- |
| **G1** | **工具面是"数量问题"**：485 全量注入 57.4k tokens，与自身承诺、自身研究、业界三方冲突。v0.11.63 分片只把最坏降到 10.6k，未解决结构 | `mcp.ts:702-740`；§3.1 | **高** |
| **G2** | **Craft 不能独立运行**：无 model client，无 internal host driver，`host-driver.ts` 12 行接口无实现 | `cli.ts:92,266`、`src/host-driver.ts` | **高** |
| **G3** | **Hook 未挂真实执行路径**：`runHooks` 仅被 `craft_hook_run` 调用；老板要的"安全/统计/评测挂 hook"目前只是"可用"不是"强制" | `service.ts:2428-2436` | **高** |
| **G4** | **无 store 迁移机制**：`SCHEMA_VERSION=3` 但无逐步迁移脚本，大版本新增表有数据风险 | `store.ts:5,50-56` | **高**（大版本前置） |
| **G5** | **资产未统一**：capability / knowledge / workflow 三条链各自成对象，无统一 `Asset` 信封、无统一健康/成本/路由 | `capability-kit.md`、`wiki-*`、`workflow-signoff.md` | 中 |
| **G6** | **无跨模型可比性**：所有评测是单模型；老板明确"不同模型机制结果会轻微不同，但核心不变"，这需要显式契约 | 全库无跨模型评测对象 | 中 |
| **G7** | **无运维度量**：无 token/cost/latency/每成功 outcome 成本的聚合投影 | 全库无 metrics kernel | 中 |
| **G8** | **跨平台只验了 Windows**：macOS/Linux 无 CI，无平台 Conformance；Windows 上 A1+ 无人值守写入失败关闭 | `platform-execution.ts`、CI `windows-latest` | 中 |
| **G9** | **src 扁平、门面 3382 行、485 工具单文件**：增长风险 | `service.ts`、`mcp.ts` | 中 |
| **G10** | **薄壳模块与死接口**：4 个 25–40 行模块 + `host-driver.ts` 12 行 | 行数实测 | 低 |
| **G11** | **文档索引与基线滞后**：`docs/README.md` 漏索引 5 篇最新研究；权威差距文档正文基线 v0.11.41 | `docs/README.md` | 低（但影响后续判断） |
| **G12** | **版本号 45 处无单一源**、npm 未真实发布、专家包仍 v0.11.62 | 上轮评估 | 低（发布动作） |

### 4.2 有意留白（**不要**当缺陷处理）

- standalone model loop —— 曾属长期目标；但老板本次明确要求"独立运行也允许接不同模型"，**故在 v0.12.1 转为在办**（作为第三个 Host Driver，不改变路线 A）。
- onboarding UI、桌面 Canvas —— 老板明确"UI 先不急"。
- 远程 Hub / A2A 商店、默认多 Agent —— 前置未满足，继续留白。
- 沙箱的"强隔离"宣称 —— Craft 刻意不宣称，继续保持。
- 内容创作领域知识 —— 属领域扩展，本版只保证"行业工作流可新建可淘汰"的机制可用。

### 4.3 结构性风险（本版必须正视）

**Craft 的 Harness 在持续变厚（68 kernel → 485 工具），而业界共识是模型变强时 Harness 应变薄。**

需要区分两类厚：

- **该保留的厚**：治理、证据、评测、状态、权限 —— 这些描述**外部世界**，与模型能力无关，会一直有价值。
- **该收窄的厚**：工具暴露面、提示词堆叠、固定流程 —— 这些描述**模型能力假设**，会被模型进步淘汰。

**G1（工具面）恰好属于后者，G5–G8 属于前者。**

---

## 五、核心决策（回答老板的直接提问）

### 5.1 `skill + mcp` 组合不行？Plugin 更好？

**结论：组合没错，全量注入错了。Plugin 不省 token。**

| 机制 | 常驻成本 | 加载方式 | 本质 |
| --- | --- | --- | --- |
| **Skill** | ~30–100 tokens/个 | 名+描述常驻，正文按需，脚本**永不进上下文** | **怎么做 / 何时做**（procedure） |
| **MCP** | ~100–700 tokens/**工具**，全量常驻 | 会话启动即注入全部 schema | **连什么**（connection） |
| **CLI** | 近零（模型熟悉时） | 首次使用时 `--help` 学习 | **确定性重活** |
| **Hook** | **~0** | 事件触发确定性脚本 | **铁律**（必须发生的事） |
| **Plugin** | = 内含物成本之和 | 随包加载 | **分发容器**，不是能力机制 |

三条判定：

1. **"用 Plugin 替代 MCP"是误解。** Plugin 装的东西一样要付上下文成本；换壳不省钱。正确说法是"**用 Plugin 分发 Skill**"。
2. **"Skill + MCP"依然是正确组合**，但要改比例：**Skill 承接全部 procedure，MCP 收缩到 O(1) 的 syscall 面**。现在的问题是 Craft 把 procedure 全塞进了 485 个 MCP 工具里。
3. **红线（架构不变量）**：**工具数 O(1)，能力数 O(n)。** 新能力 = registry 加一条数据，不是加一个工具。

**目标形态（四层各司其职）：**

```text
Skill    ── 怎么做 / 何时做（渐进披露，主载体）
MCP      ── 连什么（~12 syscall 动词 + resource_type 分发，常驻极小）
Hook     ── 铁律（安全 / 统计 / 评测在这里强制，0 token）
CLI      ── 确定性重活（本机执行，不依赖宿主）
Plugin   ── 把上面四者打包分发的容器
```

### 5.2 「厚」与「冗余」的判定表

| 对象 | 判定 | 处置 |
| --- | --- | --- |
| 治理 / 证据 / 评测 / 状态对象 | **该保留的厚** | 不动，只加统一信封 |
| 权限 / 预算 / 审批门禁 | **该保留的厚** | 不动，补 hook 强制点 |
| 知识层（md 真相 + 索引/向量投影） | **该保留的厚** | 补 scope / TTL / 写入路径 |
| MCP 工具数 485 | **冗余** | 收窄到 ~12 动词；能力走 registry |
| 单文件集中 485 工具 + 485 handler | **冗余** | 按域拆 registry 文件 |
| 重复的 entry 面（core/full/8 域面/legacy） | **冗余** | 保留 core(新) + legacy(迁移期) + full(管理) |
| 重叠提示词（每宿主复制 skill / 多 skill 叠指令） | **冗余** | 单一 `craft-route`，其余 opt-in（v0.11.62 已对） |
| 每目录复制 Workflow | **冗余** | 参数化全局模板 + scoped revision |
| 4 个薄壳模块 + 12 行死接口 | **冗余** | 合并到宿主域；接口落地实现 |
| 68 个 kernel（无分层） | **该保留但需分层** | 按 domain 归目录，不改逻辑 |

### 5.3 跨平台策略

| 平台 | 现状 | v0.12.1 目标 |
| --- | --- | --- |
| 通用 | TS/Node 共享；junction 而非 symlink；运行时能力探测而非平台名分支 | 保持；补三平台 CI |
| Windows | 只能 A0 只读 + 人工批准 A1；无强隔离 | Job Object + 受限令牌 + 目录 ACL + 网络出口拒绝；**只宣称"可证明边界"，不宣称强隔离** |
| macOS | 未验 | seatbelt/sandbox-exec profile + Conformance |
| Linux | 未验 | bubblewrap/unshare namespace（无需 Docker）+ Conformance |

**原则**：能力矩阵**可查询**，每个 `PlatformProfile` 由 Conformance Suite 证明；不满足的后端**失败关闭**，不降级成裸跑。A0 只读必须全平台可用。

### 5.4 架构分层与代码设计原则

**目标分层（`src/` 从扁平改为六层）：**

```text
surface/    入口适配：mcp（syscall 面）/ cli / workbench / adapters
application/ 按域的用例编排（取代 service.ts 的 3382 行大函数）
kernel/     纯逻辑，无 IO：policy / budget / hook / registry / router
store/      sqlite + 迁移 + 投影索引（FTS5）
host/       driver 协议 + codex/claude/internal 三个实现
assets/     capability / knowledge / workflow 三类资产的统一信封
```

**七条代码设计原则（延续并显式化现有约定）：**

1. **失败关闭默认**：未知 surface、越界 effect、漂移摘要、未知枚举一律拒绝，绝不静默放宽。
2. **声明 ≠ 执行、发现 ≠ 授权**：Capability 被索引不代表可执行；是 Craft 的核心语义，不得为了便利削弱。
3. **观测即事实**：只有 Receipt / Observation / Artifact / Grader 能形成 Outcome；模型自述永不作为完成依据。
4. **能力走数据**：新增能力 = registry 一条声明，不改工具数、不改面。
5. **约束存外部状态**：安全/预算/权限不能只活在 prompt 里（Governance Decay 证据），必须落在可校验的外部对象 + hook。
6. **单一版本源 + 纯函数可测**：版本号一处导出；平台不可达分支导出纯函数 + 构造入参断言（不用 `coverage ignore`）。
7. **平台能力探测而非平台名分支**：跨平台差异靠运行时探测（如 `createFifo()`），不靠 `if (win32)`。

**明确反对**：每目录复制 Workflow、默认多 Agent、工具与会话强耦合、把聊天历史当状态真相、把固定流程当内核。

---

## 六、v0.12.1 工作流

七个工作流（W0–W6），每个给目标 / 交付 / 验收 / 不做。

### W0 工程底座（前置，必须先做）

**为什么先做**：W1 之后要新增 registry / metrics / router / asset 表，没有迁移机制就是裸奔；src 扁平会让新增域继续堆进 `service.ts`。

**交付**
1. **Store 迁移机制**：`SCHEMA_VERSION` 升级 + 有序迁移注册表（v3→v4）+ 事务 + 迁移前备份 + 失败回滚 + `dry-run`。
2. **单一版本源**：`src/version.ts` 唯一常量 + `scripts/bump-version.ts` 一键改 45 处；`version:check` 改为校验"无散落字面量"。
3. **src 六层分层骨架**：先建目录 + barrel 导出，分批搬迁（不一次性大改 import）。
4. **三平台 CI**：windows / macos / ubuntu × node 22/24，跑 typecheck + 100% 测试 + plugin smoke + pack:adapters。
5. **冗余清理**：4 个薄壳模块合并到宿主域；`host-driver.ts` 由 W2 落地实现；删除重复入口。

**验收**：迁移正/反向测试通过；`version:check` 绿；三平台 CI 绿；覆盖率 100% 不降；薄壳模块清零。

**不做**：不重写 kernel 逻辑；不改变现有表结构语义（只做可增量迁移）。

### W1 工具面坍塌（最高杠杆，老板立刻可感）

**目标**：默认接入面 57.4k → **≤2k tokens**，工具数 O(1)，能力数 O(n)。

**交付**
1. **Syscall 面（~12 动词）**：`craft_route` / `craft_describe` / `craft_list` / `craft_get` / `craft_create` / `craft_update` / `craft_execute` / `craft_search` / `craft_evidence` / `craft_checkpoint` / `craft_status` / `craft_diagnose`，全部按 `resource_type` + `operation` 分发。
2. **Resource Registry**：把 485 个工具机械映射为声明式 `EndpointSpec{resource_type, operation, args_schema, output_schema, effect, policy, allowed_roles, risk_level, approval_required, timeout, audit_policy, idempotent}` —— 即业界共识的 9 元数据字段。
3. **迁移护栏（测试断言）**：`union(registry) === 原 485 工具`，且无遗漏、无重复、每个都有 handler。复用 v0.11.63「并集恰等于 485 且互不重叠」的断言思路。
4. **兼容面**：`--surface legacy` 暴露原 485（默认关闭、失败关闭）；`craft-mcp-full` 标记 deprecated 但保留给管理场景。
5. **Code-mode 逃生门**（本版做原型，可延后）：把 registry 暴露为可编程遍历的 typed 模块 —— 业界实测该模式 -98.7%。

**验收**：默认面 `tools/list` ≤ 2k tokens（实测字符数断言）；registry 覆盖率 100%；legacy 面功能无损（逐条对照表落盘）；未知 `resource_type` / `operation` 失败关闭。

**不做**：不去抠 description 字数（<5% 收益）；不删除任何 handler；不改变任何工具的语义。

### W2 独立运行（Model Gateway + Internal Host Driver）

**目标**：无 Codex/Claude/网络时，Craft 自己能跑通一个真实小任务。

**交付**
1. **Model Gateway**：OpenAI-compatible 最小协议；provider 注册（protocol/baseUrl/model/**apiKeyEnv**，不存 key）；tier → 具体模型映射；成本表；429/超时/限流；fallback chain（**只降级不升级**，延续 `routeModel` 语义）。
2. **Internal Host Driver**：实现 `host-driver.ts` 接口，成为与 codex/claude 对称的第三个 driver。最小 loop = `observe → propose → authorize → execute → receipt → observe`，**复用既有 Verified Work Loop / Execution Fabric / Task Control**，不新造治理链。
3. **熔断与边界（由 §3.2 证据驱动）**：
   - 硬上限：max_steps（默认 30）/ max_tokens / max_wall_clock；
   - 无进展检测：连续 N 步无状态变化即停；
   - 动作去重：`hash(tool + args)` 连续重复即判定为循环；
   - 显式终止条件：终止条件是**对象字段**，不是 prompt 里的一句话；
   - 预算分档：green / yellow（压缩上下文）/ red（降级模型）/ fuse（带部分结果中止）。
4. **路线 A 声明**：文档明确 internal host = "又一个 Host Driver"，Provider 语义不变，不构成路线转向。

**验收**：本机用任一 OpenAI-compatible 端点（如 DeepSeek）跑通真实小任务，含**中断恢复**与**熔断触发**各一次；凭据从 env 读取、不落库；未配置 provider 时行为与现在完全一致。

**不做**：不做 Craft 自己的对话 UI；不改 Codex/Claude driver；不把 internal host 设成默认。

### W3 跨平台执行矩阵 + Hook 硬化

**目标**：老板问的"安全、统计、评测是不是挂 hook" → **是，而且在执行路径上强制**。

**交付**
1. **PlatformProfile + Conformance 扩三平台**（§5.3）；Windows 用 Job Object + 受限令牌 + 目录 ACL + 网络出口拒绝；macOS seatbelt；Linux bubblewrap/unshare。
2. **四档自主落地**：A0 portable_read（全平台）/ A1 guarded_local_write（+平台边界）/ A2 external_gateway（+授权+再观察）/ A3 阻断或人工。
3. **Hook 硬化**：`hooks.ts` 挂到真实路径 —— dispatch 前（before_effect：policy/预算/凭据）、dispatch 后（after_receipt：receipt-check/token-meter）、on_failure。默认开启 `builtin:audit-log` / `builtin:token-meter` / `builtin:receipt-check`；`fail_closed` 未过即阻断。
4. **MetricsKernel**：聚合 token / cost / latency / 成功率 / 人工修正 / **每成功 outcome 成本**，维度 = task × workflow × asset × model × host；只读投影给 CLI（`craft stats`）与 Workbench。

**验收**：三平台 Conformance 各自有真实 receipt；断网 / 越权 / 取消 / 无残留四类断言；hook 在执行路径上**有 receipt 证明真的触发过**（而不是只被 MCP 调过）。

**不做**：不宣称强隔离；不在 macOS/Linux 未测时写"已支持"。

### W4 资产统一与路由（"越用越好"的机制）

**交付**
1. **统一 `Asset` 信封**：`{kind: capability|knowledge|workflow, id, version, digest, source, trust, health, effect_scope, cost_profile, policy, tags, stability}` —— 让三类资产走同一条治理链（扩展现有 capability 链，不新造）。
2. **`AssetRouter`**：输入 task signals（复杂度 / tier / 领域 / 风险 / 预算 / 历史成功），输出最小 Asset 集合 + 理由 + 精确版本。**只读、可复算、失败关闭、不自动发布。**
3. **模型无关性契约（Craft 差异化能力）**：每个 Asset/Workflow 声明 `core_invariants[]` 与 `model_sensitive[]`；评测必须在 **≥2 个模型**上跑，产出跨模型一致率 + 差异归因；**只有 core invariants 跨模型稳定才判 verified**，模型敏感部分降级为 hint。
4. **落数据管道**：work → trace → episodic record → candidate → eval → verified asset（已有骨架），补"规模化 + 用户可见的进步反馈"。
5. **淘汰机制**：asset staleness（模型版本变化 / 长期未命中 / eval 回归）→ 降级或退役候选 → 人工确认；把现有 `craft_workflow_retirement_plan` 扩为 asset 级。

**验收**：同一 Task 在 2 个模型上跑出一致性报告；router 在不可比时返回最小 baseline 而非猜测；退役候选**不自动删除**。

**不做**：不做自动发布 / 自动改默认路由；不做默认多 Agent。

### W5 知识层（md 真相 + 索引/向量投影）

**现状已对**：`knowledge-index.ts` 已是 md 为真相 + FTS5 trigram 投影（特意解决中文），可重建。

**补齐**
1. **三层寻址**：L0 md（真相）→ L1 SQLite 索引（FTS5/trigram，可重建）→ L2 向量（可选，OpenAI-compatible embeddings）。
2. **向量扩面**：现在只索引 skill 名/描述/别名 → 扩到 knowledge 与 asset 检索；未配置时**零网络请求**。
3. **Scope 与生命周期**：user / project / task 三级 scope；TTL + 复核 + 遗忘策略。
4. **写入路径**：从 Evidence/Trace 受审核地沉淀为 Claim/Page（扩现有 wiki 链到通用 knowledge）。

**验收**：md 改动 → 索引重建 → 检索命中；中文 substring 可命中；向量关闭时零网络；无 FTS5 构建仍可用（降级不静默）。

**不做**：不把向量当唯一真相；不做跨设备同步。

### W6 分发与发布

**交付**
1. **WorkBuddy Expert 包 v0.12.1**：`craft-route` skill + **新 12 动词面**（替换现在的 core 69）。
2. **Connector 包**：保留 full/legacy，用于显式管理场景。
3. **适配器同步**：Trae / DeepSeek / Claude / Codex 全部切到新面；`pack:adapters` 漂移护栏继续。
4. **npm 真实发布**：替换 `github:` 安装方式，用户不再依赖 shim。
5. **Git commit + tag v0.12.1 + push 远端**。

**验收**：解包 + 清空 PATH + 中立 cwd 启动 → 默认面 ≤2k tokens；`version:check` 全绿；远端 tag 可见；专家包导入后 Trust 重新生效（改 MCP `args` 会使旧信任失效，需重新 Trust —— 已确认机制）。

**不做**：不提交 WorkBuddy 市场审核（需老板决定）；不推 0.0.0.0 绑定的服务。

---

## 七、优先级与阶段

**建议分两个发布切点**（"非常大版本"的风险是永远发不出去）：

| 阶段 | 内容 | 理由 |
| --- | --- | --- |
| **v0.12.0** | W0 + W1 | 唯一"自身承诺 × 业界数据 × 可量化验收"三重指向；**立刻降低会话固定成本**（57.4k → ≤2k）；纯本机可验 |
| **v0.12.1** | W2 → W6 | 从"更省的治理层"进阶到"能独立工作 + 越用越好 + 可分发" |

若老板坚持单版本 v0.12.1，则按 W0 → W1 → W2 → W3 → W4 → W5 → W6 顺序推进，每个 W 结束都必须有独立验收报告。

**关键依赖链**：W0 是 W1–W5 的前置（迁移机制 + 分层 + CI）；W3 的 Hook 硬化是 W2 熔断与 W7 统计的载体；W4 的跨模型契约依赖 W2 的 Model Gateway。

---

## 八、验收标准总表

| 项 | 标准 |
| --- | --- |
| 默认接入面 | `craft-mcp` ≤ 2k tokens（现 57.4k）；工具数 ≤ 15 |
| 能力不丢 | `union(registry) === 原 485`；每工具都有 handler；无重复无遗漏（测试断言） |
| 独立运行 | 本机无宿主无网络时，用外部 OpenAI-compatible 端点跑通 1 个真实任务（含中断恢复 + 熔断各 1 次） |
| Hook 强制 | dispatch/effect 前后 hook 有真实 receipt 证明触发；fail_closed 生效 |
| 跨平台 | Windows/macOS/Linux 三平台 Conformance 各自有 receipt；A0 全平台 |
| 跨模型 | 同一 Task ≥2 模型一致性报告；不可比时输出 `inconclusive` |
| 迁移 | store v3→v4 迁移正/反向测试通过，含备份与回滚 |
| 覆盖率 | lines / functions / branches **均 100%**，不新增 ignore 指令 |
| 版本 | 单一源 + `version:check` 绿 + 无散落字面量 |
| 分发 | 专家包/连接器包 v0.12.1；解包 + 清空 PATH 可启动；npm 发布；远端 tag |
| 回执 | 每阶段按 craft route 产出 `git_diff` / `focused_test` / `coverage` / `static_check` / `review` |

---

## 九、明确不做（本版）

- ❌ 不做默认多 Agent / 多 Agent 拓扑（N4，需 N1–N3 真实数据）
- ❌ 不做远程 Hub / A2A 商店 / 市场审核提交
- ❌ 不做"自动自进化"：只保留 candidate 搜索 + 受控门禁，一次成功/用户点击/未审核日志永不改默认
- ❌ 不做 Craft 自己的对话 UI / 桌面 Canvas（老板明确 UI 不急；只补只读投影）
- ❌ 不 `eval` 模型生成的任意代码
- ❌ 不放宽 100% 覆盖率门禁
- ❌ 不重写已验证的治理/评测/证据链（只在外面套 syscall 面 + registry）
- ❌ 不把 PlatformProfile 的声明当作强隔离证明
- ❌ 不宣称为"完整安全沙箱"

---

## 十、风险与诚实边界

1. **W1 是"大手术"**：485 个工具语义必须逐条对照，存在漏映射风险。缓解 = 测试断言 + legacy/new 双跑期 + 逐条对照表落盘。
2. **通用动词的调用准确率需实测**：业界数据显示 verb+dispatch 准确率升（Opus 4 工具选择 49%→74%），但**不能假设**；需在本机用可用模型做一次选型实验。
3. **internal host 让 Craft 首次"自己跑模型"**：凭据、出网、费用边界要重新验证；默认不开启，需显式配置。
4. **跨平台只有 Windows 是真机**：本机无网络、无 macOS/Linux，只能靠 CI；**未跑过的一律写"未验证"**，不许在文档里宣称。
5. **Hook 硬化会改变行为**：默认开启 audit-log / token-meter / receipt-check 可能打断既有流程；需给关闭开关 + 迁移说明。
6. **版本 bump / push 是有外部效果的动作**：45 处版本号 + tag + push 远端需老板显式确认后执行。
7. **WorkBuddy 专家包换 MCP 入口会使旧 Trust 失效**（信任绑在 `command|args` 哈希上），导入后需重新点 Trust —— 已确认机制，不是缺陷。
8. **v0.11.63 尚未 bump 版本**：代码仍是 0.11.62，分片与 N1 修复是"已实施未发布"状态；v0.12.1 应把这段一并纳入发布。

---

## 附：依据索引

| 类型 | 路径 / 来源 |
| --- | --- |
| 权威差距分析（旧基线 v0.11.41） | `docs/research/industry-agent-runtime-next-2026-09-11.md` |
| 上一轮方案与 v0.11.63 实施记录 | `docs/research/craft-next-version-plan-2026-09-12.md` |
| N1 验收报告 | `docs/research/n1-acceptance-report-2026-09-12.md` |
| 理想态调研 | `docs/research/agent-native-runtime-ideal-state-2026-09-09.md` |
| 工具面定义与分片 | `src/mcp.ts:29,702-740` |
| 模型路由骨架 / Hook 内核 | `src/token-budget.ts`、`src/hooks.ts`、`src/service.ts:2428-2436` |
| 知识索引 | `src/knowledge-index.ts:7-12,96-130,184` |
| Store 与迁移缺口 | `src/store.ts:5,50-56`、`src/paths.ts` |
| 覆盖率门禁 | `scripts/test.ts:30-32` |
| 项目记忆与约束 | `.workbuddy-ai/memory/MEMORY.md`、`.workbuddy-ai/memory/2026-09-12.md` |
| 业界：MCP token 测量 | dev.to「Your MCP Tools Cost 6.6x More Context Than They Need」 |
| 业界：通用动词 + registry | Harness「The Agent Loop Is the New OS」 |
| 业界：渐进披露与 Tool Search | Anthropic Tool Search / Skills 文档；morphllm Skills vs MCP vs Plugins |
| 业界：harness 失效模式 | futureagi「Agent Harness in Production」；dev.to「The Harness Is the Binding Constraint」 |
| 业界：多模型路由与 Tool Registry | besthub「Designing a Production-Grade Multi-Agent Harness」；techlevity「15-Component Harness」 |
| 业界：企业 harness 与 VFS | besthub「Deploying Enterprise Agents with a Unified Harness, Skills, and Virtual Filesystem」 |
