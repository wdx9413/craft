# Workbench 到理想态的差距分析与大版本路线图

> 目的：把 `craft/NEEDREAD.md`（整产品规格，17 章）与 `craft-workbench` 现状对照，给出三者（Craft / Workbench / Craft-eval）的关系、理想态各章的能力归属与缺口、以及可快速收敛到理想态的大版本拆分。本文是规划文档，不是完成声明；所有"已具备 / 缺口"均来自本轮对仓库的核对，未端到端验收的结论明确标注。

## 0. 三仓关系（先纠正一个常见误解）

`craft`、`craft-workbench`、`craft-eval` 是**三个独立 git 仓库**，不是包含关系：

| 仓库 | 角色 | 关键证据 |
| --- | --- | --- |
| `craft` | 内核 + 能力 + 治理门（Runtime、Context、自进化、datasec、能力发现、迁移、评测驱动） | `D:/documents/project/mytest/craft` 独立 git 根 |
| `craft-eval` | 独立评测**引擎**：固定输入、独立进程、判分与统计 | `D:/documents/project/mytest/craft-eval` 独立 git 根 |
| `craft-workbench` | 纯前端 + 桌面外壳：UI、组件、样式、图标、桌面桥接、安装包 | `D:/documents/project/mytest/craft-workbench` 独立 git 根 |

**依赖方向（单向，禁止反向）**：

```text
craft-workbench  →  craft  →  craft-eval
```

- `craft` **不"包含" `craft-eval` 源码**，而是以外部固定制品引入（见下）。
- `craft-workbench` 只消费 `craft` 的 Runtime，浏览器页面通过本地服务通信，**不直接访问数据库**（`craft-workbench/README.md`）。

**`craft-eval` 的引入方式**（非源码包含）：

```jsonc
// craft/package.json
"craft-eval": "file:vendor/craft-eval-0.7.0.tgz"
```

`craft/vendor/` 下保留 `craft-eval-0.1.1` → `0.7.0` 多版本 `.tgz` 及 `provenance.json` 快照，按不可覆盖版本锁定摘要（`NEEDREAD.md §15`、三仓交付规范）。

**"评测"到底在哪**：

- 评测**引擎与判分器**：在独立 `craft-eval` 仓库；`NEEDREAD §9` 明确"通用评测统一归 craft-eval，不再发展第二套评测引擎"。
- 评测的**接入、驱动、治理门、结果消费**：在 `craft`（`core/workbench-evaluations.ts`、`tests/*evaluation*`、`capability/craft-eval/suite.ts` 是对评测包的适配/驱动层，不是引擎本体）。
- 评测结果在 UI 上的**展示**：在 `craft-workbench`（`evaluation-panel.js` 等）。

> 结论：理想态"独立评测与进化控制（§9）"是 `craft-eval`（引擎）+ `craft`（治理）两仓库共同承担，单独一个都到不了理想态。`craft-eval` 作为被 `craft` 依赖的评测底座，随 `craft` 内核里程碑（V3）收敛即可，无需在工作台路线图里单列一版。

## 1. 理想态各章能力归属与缺口对照

下表按 `NEEDREAD.md` 章节，标注能力由哪个仓库落地、当前缺口。状态分级：`已具备`=有实现且有测试/证据；`部分`=骨架具备但未端到端验收；`缺口`=未实现或仅本地模拟证据。

| NEEDREAD 章节 | 主要落地仓库 | 当前状态（本轮核对） | 关键缺口 |
| --- | --- | --- | --- |
| §1 产品目标与范围 | craft（发布清单） | 部分 | 发布范围/阻断项需逐票固定；完整目标≠本版必需 |
| §2 三模式与体验 | craft（Runtime）+ workbench（UI） | 部分 | workbench 命名仍 `pilot/control/workshop`，未对齐"领航员/控制台/工作台"；形态未收敛（launcher vs 三模式两路线） |
| §3 共享架构与契约 | craft | 已具备 | UI/CLI/MCP/Hook 契约测试在 core；跨入口一致性已部分覆盖 |
| §4 意图·计划·交付 | craft | 部分 | 本地模拟证据充分；真实 Host 派发、并行收益对照未端到端验收 |
| §5 持久执行·恢复 | craft | 部分 | 派发/落库/取消/未知结果有模块级覆盖；真实断网断电重放未验收 |
| §6 有界 Context | craft + workbench（审计面板） | 部分 | 内核检索/预算已实现；脱敏先于发送、撤销/反义截断硬失败；工作台审计面板已建 |
| §7 子能力与学习 | craft（K/M/E/Codebase/Datasec） | 部分 | 候选→评测→晋升链路在 craft；真实重复使用独立效果未测（`NEEDREAD-implement.md #25-26`） |
| §8 统一扩展·生态 | craft（适配器）+ workbench（扩展页） | 缺口 | 六类生态格式逐项真实适配未验收；工作台统一扩展入口骨架已有 |
| §9 独立评测·进化 | craft-eval（引擎）+ craft（治理门） | 部分 | `craft-eval` 4 面（memory/knowledge/workflow/datasec、self_evolution、end_to_end/governance、codebase-retrieval）跑通；end_to_end 因缺凭据环境 `INCONCLUSIVE` |
| §10 身份·存储·迁移 | craft | 部分 | 身份迁移/备份/损坏拒绝有实现与测试；中断续跑、并发增量对账无真实存量验收（`#23`） |
| §11 并发·性能·容量 | craft | 部分 | Hook 延时 P95 实测覆盖空仓；大仓/生产 P99、WAL 忙等待未达标 |
| §12 模型·执行环境·设置·隐私 | craft（Model Gateway/Datasec）+ workbench（设置页） | 部分 | 脱敏在 final-outbound 边界已实现；真实流式/附件/外部直连 Host 未验收（`#24`）；云电脑控制面缺口 |
| §13 消息·目录·主动 | craft（inbox/dir-desc）+ workbench（message-dock） | 部分 | 本地/挂载云目录轮询适配器已落（0 Token 监听）；真实 POP3/IMAP/WebSocket 网络拉取为后续扩展（`ImapAdapter` 留协议位诚实报错） |
| §14 保留·可观测·运维 | craft | 缺口 | 诊断包、备份恢复演练、单能力暂停未端到端 |
| §15 仓库·依赖·发布 | 三仓共同 | 部分 | 单向依赖已定；私服发布、升级回退、跨平台兼容矩阵未完整验收 |
| §16 发布验收（五道门） | 三仓共同 | 缺口/部分 | 工程门存在硬缺口：workbench 巨型 `app.js` 无覆盖率；数据/运行/效果/退出门大量依赖真实 Host 与独立任务未验收 |
| §17 研究依据 | 文档 | 已具备 | 仅设计参考，不构成效果承诺 |

**最大误区提示**：`NEEDREAD` 约 70% 理想态能力在内核 `craft`，工作台只是消费方。只修工作台到不了理想态；且"运行门 + 效果门"（`§16`）是真正长板——`craft` 当前大量能力只有"本地模拟证据"（合成 Host / 进程内测试），缺真实 Host 读回、独立任务收益、跨版本迁移验收。

## 2. Workbench 自身差距（聚焦外壳）

基线：`craft-workbench@0.18.0`，固定依赖 `craft@0.20.0`（`craft-workbench/package.json`）。

| 理想态要求（工作台相关） | 当前现状 | 严重度 |
| --- | --- | --- |
| §2 命名迁移：显示名统一"领航员/控制台/工作台"，稳定键解耦（NEEDREAD §2） | `mode-shell.js` 的 `label/title` 已是"工作台/控制台/领航员"，稳定键 `workshop/control/pilot` 有意保留（显示名与键解耦，符合 §2）；`app.js` 导航注释亦用规范名；旧链接重开由 `legacyNavEnabled`/`nextPageForMode` 兜底 | **已完成（显示层）** |
| §2 三种模式统一入口 | `DESIGN.md` 批准 launcher+companion+workspace（`entry.css`）；`three-mode-plan` 走 advanced Workbench 三模式；`index.html` 仅引 `app.js`，`entry-*` 未接入主链 | **高（P0，形态未收敛）** |
| §2/§12.3 桌面真实验收 | `design-qa.md`：浏览器 smoke 通过；Tauri release + 全局快捷键 + 原生交互 + 双击→应用→宿主实跑冒烟 pending；macOS/Linux 跨平台冒烟未做 | **高** |
| §16 工程门：增量代码 100% 覆盖 | `package.json` 的 `test:coverage` 明确 **exclude 巨型 `app.js`（316KB）**；171 测试只覆盖外围模块 | **高（工程门硬缺口）** |
| §2/§4 持久本地草稿恢复 + 外部应用附件 | `design-qa.md` P2：未实现，UI 仍须保留"仅本地/选中文本"披露 | 中 |
| §16 静态合规 | `premium-audit.json` 存在但 `design-qa.md` 写明 whole-project Premium 静态审计未跑完、进程已停，无通过声明 | 中 |
| §2 三模式核心交互 | Flight Strip、控制台阻塞队列、观察室、消息 dock、目录语义、评测面板**已实现且有测试**（171 tests） | 基本具备 |

> 结论：三模式的"骨架交互"在工作台前端已较完整，**命名显示层已对齐规范**（内部稳定键按 NEEDREAD §2 解耦保留）；真正硬缺口集中在 **(1) 文档叙事需统一（确认三模式为官方路线，对齐 DESIGN.md 与三模式计划）、(2) 原生桌面+跨平台真实验收缺失、(3) 巨型 `app.js` 无覆盖**。

## 3. 大版本路线图（每版 = 一套连贯能力，尽快到理想态）

原则：每版交付一组相互支撑的能力，可独立验收、可回滚；每条对应 `NEEDREAD §16` 五道门（数据/工程/运行/效果/退出）。版本与 `craft` 内核里程碑对齐，因为工作台能力依赖内核先达标。

### V1 · 底座与形态收敛（Foundation & Shape）
**目标**：消除 P0 形态分歧，打通原生桌面，先过工程门硬缺口。
- 确认形态路线为三模式（代码层 `mode-shell.js`/`app.js` 已落地，171 测试通过），把 `DESIGN.md` 的 launcher 叙述与 `three-mode-workbench-plan` 对齐，明确三模式为官方实施路线；稳定键 `pilot/control/workshop` 与显示名解耦保留（NEEDREAD §2）。剔除未落地的 `entry-*` 旧方案引用；旧链接重开由 `legacyNavEnabled`/`nextPageForMode` 兜底已具备。
- 原生桌面：Tauri release 构建、全局快捷键、双击单实例启动、桌面 E2E 冒烟（macOS/Windows/Linux）（`design-qa.md`）。
- 工程门：`app.js` 分拆或补增量 100% 覆盖，接入 layering / coverage gates（`§16`）。
- 内核依赖：`craft` 的"三模式共享 Runtime + 幂等接收 + 可靠派发"达标（`§3/§5`）。
- **退出标准**：桌面双击→应用→宿主实跑通过；三模式跨平台 readback；新增代码覆盖达标；命名显示层与稳定键解耦契约通过契约测试。

### V2 · 三模式体验闭环（Three-Mode Experience）
**目标**：三模式各自核心体验完整且可互相续接。
- 领航 Flight Strip 四阶段下钻 + 意图结构化澄清；控制台"待处理"收敛 + 成本/异常归因 + 候选评测与回滚 + 批量逐项回证；工作台对话/成果预览/版本 diff/局部接受/人工改动保护/可折叠真实终端/证据（`§2/§4/§4.2`）。
- 首次引导可达且不打断导航；可访问性（键盘/读屏/缩放/对比度/减少动画/通知去重）。
- 内核依赖：`craft` 任务状态屏/审批/队列/恢复公开接口达标。
- **退出标准**：同一任务跨三模式真实来回 + 旧链接回放矩阵 + 代表性用户任务完成率与耗时。

### V3 · 上下文与自进化可视（Context & Self-Evolution Surface）
**目标**：把内核的 Context/学习/进化能力在 UI 上可观测、可干预。
- 观察室（失败轨迹归因、自进化候选、影子测试、插件发现、交付结局飞轮真值）、转正 + 一键回滚上一稳定快照。
- Context 审计面板（越权/撤销/反义截断硬失败可视）、目录语义双向检索面板。
- Knowledge/Memory 候选与退出、Experience 流程版本隔离回退、评测面板对齐 `craft-eval` 报告（篡改/漂移不授晋升）（`§6/§7/§9`）。
- 内核依赖：`craft` 的内核有界 Context 供给 + 学习闭环 + 自进化门禁达标（`#25-27`）。
- **退出标准**：`craft-eval` 四面结果在 UI 可回放；晋升/拒绝/回滚可追溯；关闭模型审查不绕过确定性验收。

### V4 · 扩展生态与主动服务（Extensions & Proactive）
**目标**：统一扩展入口 + 真实外部连接 + 主动服务三开关。
- 统一扩展入口（已添加/发现/待处理 + 能力视图）；生态适配 UI：Agent Skills / MCP / Codex / Claude Plugin / DSH / Claude Mods 的导入-配置-执行-升级-回滚-卸载（`§8`）。
- 消息连接器真实接入（IMAP/POP3/WebSocket）+ 三模式消息流 + 批量治理；主动服务三开关 + 注意力待处理（`§13`）。
- 云电脑控制面：设置→执行环境→添加云电脑、远端目录选择/执行/接管/断网恢复（`§12.2`）。
- 内核依赖：`craft` 的 `§8/§12.2/§13` 真实连接验收。
- **退出标准**：六类生态格式逐项真实样例通过；消息多账号不串、不误发；云电脑真实远端完成连接/执行/接管/断网恢复。

> 若希望更少更大的包，可合并为 **V1 底座 / V2 体验与学习 / V3 生态与主动** 三版；但拆成 4 版能更好保证"每版独立可验收、可回滚"，避免超大版本难收敛。

## 4. 最快见效的 3 件（不依赖内核等外部）

1. **拍板形态路线**（launcher/companion/workspace vs 三模式），把 `entry-*` 接入或明确弃用，消除 `design-qa.md` 的 P0 分歧。
2. **命名对齐 `NEEDREAD §2`**，先核对 `pilot` 是否已叫"领航员"。
3. **给 `app.js` 补增量覆盖或分拆**，先过工程门硬缺口（这是唯一可立刻推进且不依赖外部仓库的门禁项）。

## 5. 证据与未验证声明

**已核实证据**：
- 三仓独立 git 根与单向依赖（`craft/package.json` 的 `craft-eval` 固定制品依赖；`craft-workbench/README.md` 依赖说明）。
- `craft-workbench@0.18.0`、`craft@0.20.0` 版本与依赖（`craft-workbench/package.json`）。
- `app.js` 316KB 被 `test:coverage` 显式排除，171 测试仅覆盖外围模块（`craft-workbench/package.json`）。
- `mode-shell.js` 仍用 `pilot/control/workshop`、`index.html` 仅引 `app.js`（`craft-workbench/workbench/`）。
- 桌面/跨平台/静态审计仍 pending（`craft-workbench/design-qa.md`、`premium-audit.json` 元信息）。
- `craft` 大量能力现状为"本地模拟证据"，真实 Host/独立任务/跨版本迁移未验收（`craft/docs/NEEDREAD-implement.md`）。

**未验证 / 风险**：
- 工作台三模式核心交互仅以 171 前端测试 + 浏览器 smoke 为证，未做真实桌面窗口与跨平台（macOS/Linux）人工冒烟。
- `NEEDREAD §16` 运行门/效果门/退出门大量依赖真实 Host 读回与独立任务收益对照，本分析未执行这些验收。
- 本文不替代 `craft/docs/three-repository-delivery.md`（交付清单）与 `docs/technical/modules/platform-ideal-state-v1.md`（平台 v1）；三者互为补充。

## 6. 可执行交付清单（V1→V2→V3，逐项带验收与阻塞）

> 本清单把第 3 章路线图拆成可勾选卡片，用于逐版本推进到理想态。每项标注：交付物 / 验收条件 / 归属仓库 / **本仓（workbench）是否可独立交付** / 阻塞依赖 / 状态。
>
> 状态图例：`✅ 已完成` · `🟡 可立即推进（本仓）` · `🔴 阻塞（需产品决策 / craft 内核里程碑 / 真实桌面·跨平台验收 / 大型重构）`。
>
> **重要边界（务必先读）**：V1/V2/V3 是 17 章产品规格 + `craft` 内核数百测试 + 真实桌面/跨平台验收的路线，**不是单轮代码量**。其中大量项依赖 `craft` 内核先过 `NEEDREAD §16` 五道门、或需 Rust/Tauri 真实构建与人工冒烟，无法由工作台仓单方面"全部实现"。本清单把可立即动手的切片与被阻塞项分开，避免把"规划"误当成"已交付"。

### V1 · 底座与形态收敛

| 卡片 | 交付物 | 验收条件 | 归属 | 本仓可独立交付 | 阻塞依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| V1.1 命名显示层对齐 | `mode-shell.js` 显示名=领航员/控制台/工作台，稳定键解耦 | 稳定键 `pilot/control/workshop` 与显示名解耦；`readMode`/`writeMode`/`nextPageForMode` 契约测试通过 | workbench | 是 | 无 | ✅ 已完成（证据：`mode-shell.js` 的 `MODES` 定义、`app.js` 导航注释） |
| V1.2 形态路线文档统一 | 明确三模式为官方实施路线，对齐 `DESIGN.md` 与 `three-mode-workbench-plan`；剔除未落地的 `entry-*` 旧方案引用 | 两篇文档叙事一致；`index.html`/`app.js` 主链说明与三模式一致 | workbench（文档层） | 是 | 无（用户已确认三模式为官方路线） | ✅ 已完成（证据：`DESIGN.md` 第 4/70/72 行已统一，commit `9bec7e6`） |
| V1.3 原生桌面 Tauri release + 全局快捷键 + 双击单实例 | `craft-workbench-desktop.exe`、`.lnk`、单实例互斥、`-Browser` 降级 | 双击→应用窗口→宿主 CLI 实跑；macOS/Windows/Linux 三平台进程退出干净 | workbench + 桌面 | 部分（构建可做） | 真实跨平台人工冒烟、全局快捷键验收；`design-qa.md` 记录 macOS/Linux 未做、原生交互因 Sky 服务失败 unavailable | 🟡 静态交付面已真实 HTTP 核对（`static-delivery.test.ts`）；原生窗口/跨平台人工冒烟仍 🔴 |
| V1.4 巨型 `app.js` 增量覆盖 / 分拆 | 把 316KB `app.js` 分拆为可测模块并逐个 100% 覆盖 | 新增与修改代码行/分支/函数 100%（NEEDREAD §16 工程门） | workbench | 是 | 剩余单体仍待逐段抽离 | 🟡 进行中（已抽出 `acceptance-criteria.js`、`select-options.js`、`folder-tree.js` 三个 100% 覆盖模块；`app.js` 316,265 → 约 313KB；整文件覆盖仍未完成） |
| V1.5 内核共享 Runtime + 幂等接收 + 可靠派发达标 | `craft` 三模式共享 Runtime、幂等键、持久事件箱 | `craft` 的 §3/§5 门禁通过（真实 Host 读回、断网重放） | craft | 否 | craft 仓库里程碑 | 🔴 阻塞（依赖内核） |

### V2 · 三模式体验闭环

| 卡片 | 交付物 | 验收条件 | 归属 | 本仓可独立交付 | 阻塞依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| V2.1 领航 Flight Strip 下钻 + 意图结构化澄清 | `mode-pages.js` 四阶段进度 + 下钻 + `pilot-clarify` 卡片 | 171 测试覆盖；真实用户任务完成率/耗时对照 | workbench | 骨架✅，真实验收🔴 | 真实体验验收环境 | 🟡 骨架已完成，待真实验收 |
| V2.2 控制台"待处理"收敛 + 成本/异常归因 + 批量逐项回证 | `app.js` 待我批准批量治理、`blocked` 页、成本展示 | 批量部分失败逐项回证；代表用户任务完成率 | workbench | 骨架✅，真实验收🔴 | 真实验收 | 🟡 骨架已完成，待真实验收 |
| V2.3 工作台成果预览/版本 diff/局部接受/人工保护/真实终端/证据 | `mod-pages.js`、`dual-terminal`、`changeset` 局部接受 | 并发编辑、人工改动保护、失效传播定向测试 + 真实验收 | workbench + craft | 骨架✅，真实验收🔴 | 真实验收 | 🟡 骨架已完成，待真实验收 |
| V2.4 首次引导可达且不打断导航 + 可访问性 | 去 `!nativeDesktop` 引导、`visual-layer`、`mode-confirm` | 键盘/读屏/缩放/对比度/减少动画/断线/凭据失效覆盖 | workbench | 部分✅ | 跨平台可访问性人工验收 | 🟡 部分，待跨平台验收 |
| V2.5 内核任务状态/审批/队列/恢复公开接口达标 | `craft` 任务页、审批、队列、恢复公开 API | §4/§5 门禁通过 | craft | 否 | craft 里程碑 | 🔴 阻塞（依赖内核） |

### V3 · 上下文与自进化可视

| 卡片 | 交付物 | 验收条件 | 归属 | 本仓可独立交付 | 阻塞依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| V3.1 观察室（失败轨迹/自进化候选/影子测试/插件发现/回滚） | `mod-pages.js` 进化页、`workbench-evaluations` 对接 | 转正+一键回滚上一稳定快照；关闭模型审查不绕过确定性验收 | workbench + craft | 骨架✅，真实验收🔴 | craft 自进化门禁（#27） | 🟡 骨架已完成，待真实验收 |
| V3.2 Context 审计面板（越权/撤销/反义截断硬失败可视） | `context-audit-panel.js` + 测试 | 越权/撤销注入/反义截断为硬失败，UI 可读回 | workbench + craft | 是（模块+测试已存在） | craft Context 越权/反义截断判分 | ✅ 骨架已完成（证据：`context-audit-panel.js`、`context-audit-panel.test.ts`） |
| V3.3 Knowledge/Memory/Experience 候选与退出 UI | 候选列表、晋升/拒绝、版本隔离回退 | 同名不同前提不误复用；回归版本可隔离回退 | workbench + craft | 骨架✅ | craft 真实重复使用独立效果（#25-26） | 🟡 骨架已完成，待真实收益验收 |
| V3.4 评测面板对齐 `craft-eval` 报告 | `evaluation-panel.js` 读 `craft-eval` 四面结果 | 篡改/漂移不授晋升；结果可回放 | workbench + craft-eval | 骨架✅ | `craft-eval` 四面结果（end_to_end 因缺凭据 `INCONCLUSIVE`）+ craft 治理门 | 🟡 骨架已完成，待引擎结果 |

### V4 · 扩展生态与主动服务（已纳入本轮交付）

| 卡片 | 归属 | 状态 |
| --- | --- | --- |
| V4.1 统一扩展入口（已添加/发现/待处理 + 能力视图） | workbench + craft | 🟡 真实 HTTP 集成已交付（`three-mode-extensions-proactive.test.ts`：格式/状态/范围登记、激活不自动全局启用）；六类真实格式适配仍 🔴 |
| V4.2 六类生态格式真实适配 UI（Skills/MCP/Codex/Claude/DSH/Mods） | workbench + craft | 🔴 依赖 craft §8 真实验收 |
| V4.3 消息连接器 + 批量治理 | workbench + craft | 🟡 端到端挂载已交付（`three-mode-v4-mount.test.ts`：message-dock 三模式渲染、批量已读经 UI 点击真实改服务端状态、native-tools 目录读回）；IMAP/POP3/WebSocket 真实网络拉取仍 🔴 |
| V4.4 云电脑控制面（添加/执行/接管/断网恢复） | workbench + craft | 🔴 依赖 craft §12.2 真实远端验收 |

### 本轮（2026-11-08）已落实

- 修正第 2 章误判：命名显示层**已对齐**规范（稳定键解耦），从"缺口"改为"已完成"。
- 修正"形态未收敛"为"文档叙事需统一"：代码层已实质收敛到三模式（`mode-shell.js`/`app.js` + 171 测试），launcher/`entry-*` 方案未落地。
- 新增本章可执行交付清单，区分 `✅/🟡/🔴`，把可立即推进的切片与被阻塞项（内核里程碑、真实桌面/跨平台验收、app.js 重构）分离。
- 状态表已按后续各轮真实证据逐行更新（见第 7—10 章）：V1.2 由 🟡→✅、V1.4 由 🔴→🟡、V4 纳入交付、V4.1/4.3 补真实 HTTP 集成证据。

### 下一步建议（遗留 🔴 项，按依赖顺序）

1. **V1.4 继续分拆**：`app.js` 剩余约 313KB，可按同样方式逐段抽出活跃纯函数（`taskListRows`、`taskRowHtml`、`folderGroupHtml` 等均仍有调用点）并逐个补 100% 覆盖；这是唯一纯本仓、不依赖内核的剩余工程门缺口。
2. **V1.3 / V1.5 / V2.5 / V3.x 真实验收门**：需真实桌面/跨平台人工冒烟、`craft` 内核 §3/§5 门禁、独立任务收益对照；不能由本仓 mock 测试替代。
3. **V4.2 / V4.4**：六类生态格式真实适配、云电脑远端执行需 `craft` §8/§12.2 真实验收。
4. 每版以第 5 章"证据与未验证声明"口径登记验收，不把规划当完成。

## 7. 本轮交付证据（2026-11-08，三模式官方路线确认后）

用户确认"三模式（领航员/控制台/工作台）为官方路线"，并授权：缺的东西自建、真实数据用 mock、每个大版本开发完统一测试验证后推送远端 main。本轮在 `craft-workbench` 仓完成 V1→V2→V3 的**可独立交付切片**，并统一验证。

### 已交付（craft-workbench 仓）

- **V1.2 文档统一**：`DESIGN.md` 第 4/70/72 行由 launcher/companion/entry.css 方案改为三模式官方路线；明确 2026-09-28 launcher 提案被三模式取代、`entry.css` 仅为历史样式产物、不得接入启动链。
- **可复用 mock 后端**：新增 `tests/helpers/mock-runtime.js`（纯 ESM，无新依赖）。覆盖 `/api/workbench/*` 的任务板、Pilot 失败观察/交付结局、Mods 列表/影子测试/回滚、插件发现、阻塞队列、agent providers、summary 等端点，提供 `createMockRuntime` / `mockContext` / `assertCalled`，供后续版本集成测试复用。
- **V1 端到端契约**：`tests/three-mode-journey.test.ts`（6 例）——命名显示层与稳定键解耦、模式偏好 round-trip、切模式保留共享任务文档、旧链接重开、同一任务跨控制台/工作台共享、领航员 Flight Strip 投影。
- **V2 跨模式一致性**：`tests/three-mode-consistency.test.ts`（3 例）——领航员派发产生唯一共享任务且控制台不重派发、审批聚合读取共享状态、切模式为只读视图变更（不 mutate 任务）。
- **V3 上下文与自进化可视**：`tests/three-mode-evolution.test.ts`（4 例）——观察室聚合四类共享证据（Mod/失败/插件发现/交付结局）、影子测试与一键回滚命中真实治理端点、阻塞队列读取共享领航线程、评测面板暴露独立评测/Context 审计/比较/知识效果门槛。

### 统一验证结果

- `npm test` 全量：**271 + 14 + 3 + 1 + 2 = 291 tests，0 fail**（新增 13 例：V1 6 / V2 3 / V3 4）。
- 工程门覆盖率：`context-audit-panel.js` / `task-replan-ui.js` / `work-review-risk-ui.js` / `work-review-verification-ui.js` 维持 **行/函数/分支 100%**。
- 未覆盖风险（如实登记）：巨型 `workbench/app.js` 仍被 `test:coverage` 显式排除（V1.4 工程门硬缺口未在本轮解决）；原生桌面/跨平台人工冒烟、真实 `craft` Host 读回、独立任务收益对照、云电脑/真实消息连接器仍为 🔴，未由本轮 mock 测试冒充完成。

### 版本状态更新（对照第 6 章清单）

| 卡片 | 本轮前 | 本轮后 |
| --- | --- | --- |
| V1.1 命名显示层 | ✅ | ✅（补 V1 契约测试） |
| V1.2 文档统一 | 🟡 | ✅（`DESIGN.md` 已对齐三模式） |
| V1.4 `app.js` 覆盖 | 🔴 | 🔴（未动，保留真实缺口） |
| V2.1/2.2/2.3 | 🟡 骨架 | 🟡 骨架 + V2 跨模式一致性集成测试 |
| V3.1/3.4 | 🟡 骨架 | 🟡 骨架 + V3 观察室/阻塞/评测面板集成测试 |

> 说明：本轮交付的是"可独立验证的 UI 闭环 + mock 后端 + 文档统一"，**不宣称** V1/V2/V3 整版理想态（含内核五道门、真实桌面验收）已完成。🔴 项按清单逐版继续推进。

## 8. 逐版补完证据（2026-11-08，V1 交付完→V2→V3）

用户要求"V1 交付完做 V2 然后 V3、持续进行"。本轮按版本顺序把上一轮仍是缺口的**本仓可独立交付项**逐版补齐，每版单独全量验证 + commit + push main。

### V1 补完（commit `596736d`）

- 新增 `scripts/mock-runtime-server.mjs`：**可独立运行的** `node:http` mock Runtime 服务，提供 `/api/workbench/*` 与静态 `workbench/` 入口；`serve:mock` / `test:mock` 脚本接入 `package.json`。
- `tests/mock-runtime-server.test.ts`（2 例）：真实 HTTP 自测 5 项（任务板/Mods/Pilot/静态入口）、路径穿越 403/404、非法 JSON body 400。
- 全量验证：**293 tests / 0 fail**（271+2 主套件 + 四门 14/3/1/2）。

### V2 补完（commit `ecacb51`）

- `tests/three-mode-draft-retention.test.ts`（2 例）：直接驱动 `workbench/app.js` 真实 `setMode` 实现，在带草稿的完整 state 上连续切 领航员→控制台→工作台，断言 `composer.lastPrompt`/`model`/`caps`/`selectedProject`/`page`/`asideOpen` **byte-for-byte 不漂移**，且每切一次只有 `saveMode`+两次导航重绘、无任何派发/审批副作用；未知模式被拒绝且草稿不变。补上 NEEDREAD §2 "切模式保留草稿和筛选"的可验证证据。
- 全量验证：**295 tests / 0 fail**。

### V3 补完（本 commit）

- `scripts/mock-runtime-server.mjs`：补 evaluations / context-audits 端点；`createState()` 改为每服务实例独立状态（修掉跨测试共享单例，隔离真实隔离语义）。
- `tests/three-mode-evaluation-flow.test.ts`（2 例）：真实 HTTP 集成——观察室四类证据读回 → 评测提交/事件/报告绑定同一 run id → 客户端不能自报 `passed`（服务端赋状态）→ Context 审计 `inconclusive` 如实标记；评测列表与观察室共享同实例真值。
- 删除 `tests/three-mode-evolution.test.ts` 中较弱的静态源码 grep 断言（已被真实 HTTP 集成取代，避免重复证据）。
- 全量验证：**296 tests / 0 fail**。

### 仍未覆盖（不冒充完成）

- V1.4 巨型 `app.js` 覆盖率、原生桌面/跨平台人工冒烟、真实 `craft` Host 读回、独立任务收益对照、云电脑、真实消息连接器：仍为 🔴，需对应仓库里程碑或真实验收环境。

### 推送记录

| 版本 | craft-workbench main | 说明 |
| --- | --- | --- |
| 上轮 V1-V3 骨架 | `9bec7e6` | 三模式路线确认 + mock 运行时 + 13 集成用例 |
| V1 补完 | `596736d` | 可运行 mock 服务 + HTTP 自测 |
| V2 补完 | `ecacb51` | 草稿/筛选跨模式保留 |
| V3 补完 | 本 commit | 评测/审计真实 HTTP 集成 |

> 两仓 `main...origin/main` 每版推送后均保持同步；`craft` 仓本文件随 V3 一并提交推送。

## 9. V1.4 工程门分拆 + V4 扩展生态与主动服务（2026-11-08，"两个一起继续"）

用户要求 V1.4（`app.js` 工程门硬缺口）与 V4（扩展生态与主动服务）**一起**继续。两块均按真实实现 + 统一验证 + 推送执行。

### V1.4 · 巨型 `app.js` 分拆（最小充分切片）

- 发现 `app.js` 内 `CRITERION_WORDS` + `parseCriteria()` 是**只定义、从未调用**的死代码（`task-acceptance` 表单并不渲染）。按"清理确认相关的无用代码"原则：从 `app.js` 删除该段（316KB → 减小），把纯逻辑抽为独立可测模块 `workbench/acceptance-criteria.js`。
- `tests/acceptance-criteria.test.ts`（6 例）：中英文验收词映射、类型化行→criteria/files、全角冒号、未匹配默认 human、非数组/nullish 输入不抛、id 顺序稳定。
- 删掉模块里不可达的 `|| 'human'` fallback（正则词集与 map key 一致，永远命中），使覆盖率门真实达到 **行/函数/分支 100%**（不是靠放宽门槛）。
- `package.json` 新增 `test:coverage:acceptance-criteria` 并接入 `npm test`。这是从 `app.js` 抽出的第一个 100% 覆盖纯模块，**V1.4 硬缺口开始收敛**（不宣称整个 316KB 已覆盖）。

### V4 · 扩展生态与主动服务（本仓可交付切片）

- `scripts/mock-runtime-server.mjs` 补 V4 端点：统一扩展清单 `/extensions/list`、激活 `/extensions/activate`、消息 `/messages/list|poll|batch|.../read|process-intent`、主动服务 `/proactive/settings`；修 `url.searchParams` 传参（query 不能从 pathname 猜）。
- `tests/three-mode-extensions-proactive.test.ts`（3 例，真实 HTTP）：扩展按格式/状态/范围登记且激活不自动全局启用；消息批量标记已读逐项回执、未读筛选随状态变化、草稿/已读不等于已发送或已派发；主动服务提醒/准备/执行**三开关独立**、默认不自动执行、开 prepare 不连带授 execute。
- 真实边界（不冒充）：六类生态格式真实适配、IMAP/POP3/WebSocket 真实拉取、云电脑远端执行仍需 `craft` §8/§12.2/§13 真实验收，仍为 🔴。

### 统一验证与状态

- `npm test` 全量：**285 + 6 + 14 + 3 + 1 + 2 = 311 tests / 0 fail**。
- 覆盖率门：新增 `acceptance-criteria.js` **100%/100%/100%**；原四门维持 100%。
- 版本状态更新（对照第 6 章）：V1.4 由 🔴 转为 🟡（已抽出首个 100% 覆盖模块，整文件覆盖仍待续）；V4.1/4.3 由 🟡 骨架补上真实 HTTP 集成证据；V4.2/4.4 仍 🔴。
- 本轮为单次统一交付（V1.4 + V4 一起），两仓 commit 后一并推送 main。

## 10. 收尾交付（2026-11-08，"自己选方向或者一起做 把这些都做完"）

用户要求把上一轮列出的三个后续方向**全部做完**。本轮一起完成并按"统一验证 → 两仓提交 → 推送 main"收口。

### ① V1.4 第二刀：活跃纯函数抽离 + 100% 覆盖

- 发现 `app.js` 的 `options()` 是**8 处活跃调用**的纯渲染函数（此前 `taskRowHtml`/`folderGroupHtml`/`taskListRows` 在 883/921/923/1268 行也都有调用，非死代码，不删除）。
- 抽为 `workbench/select-options.js` 的 `renderOptions(pairs, selected, esc)`，`app.js` 的 `options()` 改为薄 wrapper 调用它（8 个调用点零改动、行为不变）。
- `tests/select-options.test.ts`（5 例）+ 新增 `test:coverage:select-options` 并接入 `npm test`：**行/函数/分支 100%/100%/100%**（含注入 esc、默认 esc、畸形 pair、nullish selected 等分支）。
- 至此 V1.4 已抽出 `acceptance-criteria.js` + `select-options.js` 两个 100% 覆盖模块；`app.js` 由 316,265 → 315,027 → 进一步缩小。整文件覆盖仍未完成，状态保持 🟡，不冒充。

### ② V4 端到端挂载（不只是 API 合同）

- `scripts/mock-runtime-server.mjs` 补 `/native-tools`、`/internal-approvals` 端点；`messages/batch` 返回对齐 UI 期望的 `succeeded/failed`；消息字段改为 dock 真实读取的 `from/subject/readAt/processedAt/priority`（且用不含真实个人信息的占位值）。
- `tests/three-mode-v4-mount.test.ts`（3 例）：把 `message-dock.js` 与 `native-tools-panel.js` **真正挂到 DOM 桩并用 `fetch` 驱动真实 `node:http` 服务**——三模式消息流渲染、控制台批量已读经 UI 点击后从服务端读回状态变化（无关消息不受影响）、native-tools 工具目录读回。
- 修测试时序：真实 HTTP 轮询跨多个事件循环 tick，改用带上限的 `waitFor` 并在 `finally` 无条件 `dock.stop()`（避免 15s `setInterval` 挂住进程）。

### ③ 文档状态对齐 + ④ 清理

- 第 6 章清单逐行更新：V1.2 🟡→✅、V1.4 🔴→🟡、V4 标题由"未要求本次范围"改为"已纳入本轮交付"、V4.1/4.3 补真实 HTTP 集成证据；"下一步建议"重写为遗留 🔴 项的依赖顺序。
- 删除本轮诊断脚本 `.tmp-diag.mjs`；其余 `.tmp-*.log` 已被 `.gitignore` 排除，不进交付（`git status` 仅剩 6 个本次改动文件）。

### 统一验证与推送

- `npm test` 全量：**293 + 6 + 5 + 14 + 3 + 1 + 2 = 324 tests / 0 fail**（主套件 293、新两门 6+5、原四门 14/3/1/2）。
- 覆盖率门：`acceptance-criteria.js`、`select-options.js` 及原四模块均 **100%/100%/100%**。
- 两仓 `main...origin/main` 在本轮 commit 后同步；工作区干净。

### 完成度审计（对照最初目标）

| 目标 | 状态 | 证据 |
| --- | --- | --- |
| 三模式官方路线确认 + 文档统一 | ✅ | `DESIGN.md` commit `9bec7e6` |
| V1 底座（命名/mock 运行时/工程门切片） | ✅ 本仓可交付部分 | `596736d`、`006ab83`、本轮 `select-options` |
| V2 三模式体验闭环 | ✅ 本仓可交付部分 | `9bec7e6`、`ecacb51`（草稿/筛选跨模式保留） |
| V3 上下文与自进化可视 | ✅ 本仓可交付部分 | `9bec7e6`、`ff0be74`（真实 HTTP 评测/审计） |
| V4 扩展生态与主动服务 | ✅ 本仓可交付部分 | `006ab83`、本轮端到端挂载 |
| 每版统一测试验证 + push main | ✅ | 历次 commit 与推送记录（第 8/9 章 + 本轮） |
| V1.4 整个 `app.js` 100% 覆盖 | 🟡 未完成 | 已抽 3 个 100% 覆盖模块（`acceptance-criteria` / `select-options` / `folder-tree`），剩余单体 |
| 真实桌面/内核 Host/独立收益/六类生态/云电脑 | 🔴 未完成 | 需对应仓库里程碑或真实验收环境，非本仓可伪造 |

> 本轮"把这些都做完"指上一轮明确列出的三个后续方向（V1.4 继续分拆、V4 端到端挂载、文档状态对齐）已全部交付并验证推送；**不宣称**整个 `NEEDREAD` 17 章理想态已完成——🔴 项按第 6 章清单继续保留为真实缺口。

## 11. 持续推进（2026-11-08，目标"把这些都做完"续作）

目标为持续性交付。本轮按权威状态里仍可推进的两条线一起做：V1.4 第三刀 + 静态交付面真实 HTTP 核对。

### V1.4 第三刀：`folder-tree.js`

- 抽出 `app.js` 里**活跃调用**的 `taskRowHtml` / `taskListRows` / `folderGroupHtml`（调用点 883/921/923/1268）为 `workbench/folder-tree.js`，用注入 `deps`（esc/icon/lead/statusPill/selectedTask/collapsedFolders/showAllFolders）保持纯可测；`app.js` 改三个薄 wrapper + `treeDeps()`，4 个调用点零改动、行为不变。
- `tests/folder-tree.test.ts`（9 例）+ `test:coverage:folder-tree` 门：**100%/100%/100%**（选中态、缺省标题、5 行预览与"还有 N 个"、展开/折叠/空组、group.key 真假图标、nullish state、畸形 group 不抛）。
- V1.4 累计 3 个 100% 覆盖模块；`app.js` 由 314,931 → 约 313KB。

### V1.3 静态交付面：从文本断言到真实运行证据

- `scripts/mock-runtime-server.mjs` 新增 `staticSurface()`：解析 `index.html` 的本地 CSS/JS/SVG 引用与 `app.js` 全部 `from './x.js'` 相对 import，产出可核对清单。
- `tests/static-delivery.test.ts`（3 例）：真实 HTTP 端口逐个 GET 清单里每个资源，验证 200 / Content-Type 正确 / 内容非空 / `index.html` 真指向 `./app.js`；同时验证路径穿越仍 403、不存在资源 404。
- 这不替代 Tauri 窗口人工冒烟，但把"静态交付面可达"从源码 grep 提升为运行证据；V1.3 由 🔴 转 🟡（仅静态面），原生窗口/跨平台仍 🔴。

### 统一验证与推送

- `npm test` 全量：**305 + 6 + 5 + 9 + 14 + 3 + 1 + 2 = 345 tests / 0 fail**（主套件 305、三个新门 6/5/9、原四门 14/3/1/2）。
- 覆盖率门：`acceptance-criteria.js`、`select-options.js`、`folder-tree.js` 及原四模块均 **100%/100%/100%**。
- 两仓 commit 后推送 main，`main...origin/main` 同步、工作区干净。

### 完成度审计（对照最初目标，累积）

| 目标 | 状态 | 证据 |
| --- | --- | --- |
| 三模式官方路线 + V1/V2/V3/V4 本仓可交付部分 | ✅ | 第 7—10 章历次 commit |
| V1.3 静态交付面真实可达 | ✅ | `static-delivery.test.ts` |
| V1.4 逐段抽离 + 100% 覆盖门 | 🟡 持续中 | 3 个模块已达标，单体剩余 |
| 每版统一验证 + push main | ✅ | 历次推送记录 |
| 真实桌面窗口 / 内核 Host / 独立收益 / 六类生态 / 云电脑 | 🔴 | 需真机与对应仓库里程碑，非本仓可伪造 |

> 目标为持续性；本轮继续把 V1.4 与静态交付面向理想态推进，未把 17 章整版理想态标为完成。🔴 项按第 6 章清单保留为真实缺口。

### 续作：V1.4 第四刀 `lookup.js`

- `operatorOf`（36 处调用）、`taskTitleOf`、`capNameOf` 三组只读查询抽为 `workbench/lookup.js`，`app.js` 改为薄 wrapper；签名/调用点零改动。
- `tests/lookup.test.ts`（4 例）+ `test:coverage:lookup` 门：**100%/100%/100%**（operator 去空白/未配置/非字符串、跨分组找标题/缺省、assets 优先于 userSkills、全无命中回落 id）。
- 全量验证：**309 + 6 + 5 + 9 + 4 + 14 + 3 + 1 + 2 = 353 tests / 0 fail**。
- V1.4 累计 4 个 100% 覆盖模块；`app.js` 312,907 → 约 311KB。
