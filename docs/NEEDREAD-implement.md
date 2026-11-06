# NEEDREAD.md 实施追踪与验收

目标：把 NEEDREAD.md 的蓝图落到「可运行、可测试」的代码，不升级版本号、不写 Codex/Claude 宿主配置。

## 需求 → 实现 → 证据

| NEEDREAD 需求 | 实现 | 证据 |
| --- | --- | --- |
| 三模式（领航/观象/灵策）+ Fresh Load | `mode-shell.js` + `setMode` 重载文档 | 既有；`tests/mode-shell.test.ts` |
| 切模式后台任务确认 | `homeActiveTaskCount` + `/api/workbench/task-active-count` + `setMode` 确认弹窗 | `tests/workbench-server.test.ts`、app.js:568 |
| 冷启动一次性引导（只配置模型，终身不弹） | `settings.workbench.onboarding.completedAt` + `onboardingComplete/Reset` + 工作台向导（只跑一步）；`bind-workspace` 保留但不再是冷启动必选步骤 | `tests/platform-settings.test.ts`、`tests/workbench-server.test.ts` |
| 桌面首登引导可达且不打断导航 | 去掉 `!nativeDesktop`（Tauri 启动 fragment 只有 token）；仅在 hash 无 `page` 参数（默认落地页）时引导，显式导航到设置/插件等页面不弹窗 | `tests/visual-layer.test.ts` |
| 领航按意图自动识别工作目录 | `core/pilot-coordinator.ts`（按路径/目录名/语义描述打分）+ `pilotTurnAuto` 自动绑定 workspace，歧义时反问且不建任务 | `core/pilot-coordinator.ts`、`tests/pilot-coordinator.test.ts`（服务层 3 例 + 纯函数 12 例） |
| Coordinator 检查历史任务冲突 | `detectCoordinatorConflicts` 在建任务前比对未结束任务目标，`pilot_turn.conflicts` 留痕、领航卡片可见 | `tests/pilot-coordinator.test.ts`、`tests/mode-pages.test.ts` |
| 工作目录解析可观测 | `workspace_resolution`（source/confidence/reason/candidates）随回合规留，Flight Strip 下钻显示「按意图识别 / 你指定的」与把握度 | `core/application/craft-service.ts`、`workbench/mode-pages.js` |
| 领航 Flight Strip（四阶段进度 + 点击下钻） | `mode-pages.js` flight-strip/flight-drawer + CSS 呼吸动画 | `tests/mode-pages.test.ts` |
| Flight Strip 一键下钻工作台 | 阶段抽屉新增「在工作台打开任务」，直接调 `openTask` | `tests/mode-pages.test.ts` |
| 领航意图补全结构化组件（模糊时点选而非打字） | `pilot-clarify` 单选卡片，选择后自动重提 | `tests/mode-pages.test.ts` |
| 工作台 Mod/Plugin 热插拔工具栏 | `session-toolbar`：active Mods 可停用；插件只显示当前工作区 `enabled` 的绑定，可一键停用并即刻影响其自带 Mod 的注入 | `tests/mode-pages.test.ts` |
| 工作台双轨终端流（可折叠原始终端） | `dual-terminal` 读 host-run 真实事件，默认折叠 | `tests/mode-pages.test.ts` |
| Plugin 体系（执行体/沙盒/SAP） | 既有 `plugin-adapters.ts`、`sandbox.ts`、`docker-sandbox.ts` | `audit:layering` |
| Mod 体系（认知约束、真实注入 Worker、版本/启停） | `modSystemOverlay` 已接入 `taskMessageSend` 的 system prompt，按任务工作区作用域过滤；注入的 Mod id/version 写进 `task.message.assistant` Trace | `tests/mod-registry.test.ts`（含假 transport 端到端断言） |
| 复杂 Plugin 附带 Mod 自动注入 | `plugin_id` 绑定 + `taskMessageSend` 从 `workspace_plugin_binding` 读 enabled 插件 id 传给 overlay；停用插件后规则立即不再注入 | `tests/mod-registry.test.ts`（启用/停用两轮 prompt 断言） |
| 自进化：捕获 Trace（含调用的 Mod/Plugin 版本、目录解析来源、用户结局） | `pilotTurnAuto` 记 `workspace_resolution`；`pilotDeliveryAdoption` 记「直接采纳/改过再用/驳回重来」，幂等、不覆写 | `tests/workbench-server.test.ts`、`tests/mode-pages.test.ts` |
| 自进化：归因 | 既有 `core/failure-attribution.ts` | `tests/failure-attribution.test.ts` |
| 自进化：失败终态可核验轨迹 | `pilotFinalizeSessionReviews` 为每个 `needs_attention` 结果幂等写 `pilot_failure_observation`（依据/验收/待办数量、生效 Mod、执行器），不臆测 failure_class | `tests/workbench-server.test.ts` |
| 控制台失败轨迹可见 | `/api/workbench/pilot/failure-observations` + 观察室「待归因的失败轨迹」 | `tests/mod-pages.test.ts` |
| 自进化：蒸馏 Mod 修补 | `proposeFromAttribution`（unattributed 不产规则） | `tests/mod-registry.test.ts` |
| 自进化：归因→蒸馏闭环 | `pilotFailureAttribute`：人提交观测信号 → `attributeFailure` 判定 → 写回结论 → 归因成功才产 `pending` Mod（仍须影子测试+署名批准）；观测不足如实记「无法归因」 | `tests/workbench-server.test.ts`、`tests/mod-pages.test.ts` |
| 自进化：蒸馏 StateGraph/Procedure | 既有 `craft-experience` 四道 gate | `capability/craft-experience/*` |
| 自进化：插件发现（路径 C） | `pilotFailureAttribute` 在归因成功时自动调 `PluginDiscovery.propose`，提案进观察室待批准；只匹配已登记能力，不安装、不写宿主配置。无工具补救的类别（如 scope_gap）诚实跳过 | `tests/plugin-discovery.test.ts`、`tests/workbench-server.test.ts` |
| 自进化：影子测试真门禁 | `evaluateShadowTest` 跑固定 4 项确定性回归（0 Token、候选注入惰性、插件绑定不泄漏、上下文不污染），结果留痕；`approve` 仍要求 `shadow_test=passed`。UI 由「记录通过」改为「跑影子回归」 | `tests/mod-registry.test.ts`、`tests/workbench-server.test.ts`、`tests/mod-pages.test.ts` |
| 自进化：转正 + 一键回滚上一稳定快照 | `approve` 生效；`modRollbackPrevious` 自动算上一版本，仍写为新版本并留痕；无更早版本时如实报错。控制台「回到上一版 / 指定版本」两个入口 | `tests/mod-registry.test.ts`、`tests/workbench-server.test.ts`、`tests/mod-pages.test.ts` |
| Worker↔Reviewer 3 轮熔断 | `pilotReview` 第 4 轮自动 `suspended` 并挂起路由至 blocked 队列 | `tests/pilot-review-round.test.ts` |
| 控制台「异常阻塞队列」+ 报警/解除 | `pilotSuspendSession` 硬中断时同时写一条高优先级消息（纯工程 0 Token，三模式可见），`pilotBlockedQueue` + `pilotResumeSession` + 控制台 `blocked` 页 | `tests/workbench-server.test.ts`、`tests/mod-pages.test.ts` |
| 控制台「自进化观察室」 | `evolution` 页展示自进化 Mod 候选、影子测试、插件发现提案、待归因失败轨迹与「交付结局（飞轮真值）」统计 | `tests/mod-pages.test.ts`、`tests/workbench-server.test.ts` |
| 工作台 Mod 热插拔 / 一键回滚 | `mods` 页批准/启停/撤销/影子测试/回滚按钮 | `tests/mod-pages.test.ts` |
| 沙盒隔离 / 版本回滚 | 既有 sandbox + skill-publisher / asset-revisions | 既有测试 |
| 消息插件：纯工程监听 + 0 Token 展示 | `message-inbox.ts` + `messageIngest` webhook + `message-listener.ts`（`LocalDropAdapter` 本地/挂载云目录轮询，`message_seen` 持久去重，一源失败不影响其余，`ImapAdapter` 无配置诚实报错）+ `messagePoll` HTTP/CLI + `message-dock.js` 三模式（领航播报/观象待办含目录拉取/灵策 Toast+侧栏） | `tests/message-inbox.test.ts`、`tests/message-listener.test.ts`、`tests/message-dock.test.ts`、`tests/cli-dirs.test.ts`、`tests/workbench-server.test.ts` |
| 安全边界：脱敏先于落库 | `messageIngest` 用 `craft-datasec` 全部内置规则脱敏正文，发件人/主题只去凭据以保留可读性，绝不把密钥原文写入本地库 | `tests/message-inbox.test.ts` |
| 消息插件：按需 AI | `messageProcess` 派发 Pilot turn（幂等），仅此步消耗模型 | `tests/message-inbox.test.ts` |
| 控制台消息批量治理 | `messageBatch`（read 0 Token / summarize 才按需派发，逐条报告失败）+ 控制台勾选与底部浮条「批量标记已读 / 丢给 AI 统一总结」 | `tests/message-inbox.test.ts`、`tests/message-dock.test.ts` |
| 灵策消息流一键拖拽到 Chat | 消息卡片可拖拽，把「参考消息：发件人《主题》」写入当前输入框，不发送、0 Token | `tests/message-dock.test.ts` |
| `craft-file-dir-desc` 目录↔描述双向检索 | `core/file-dir-desc.ts`（observed→promoted，3 次用过才转正，local/cloud）+ `craft dirs record/promote/resolve/list` CLI | `tests/file-dir-desc.test.ts`、`tests/cli-dirs.test.ts` |
| 工作台 UI 融合 | `mod-pages.js`（认知约束/目录语义/首次引导/切模式确认/观察室/阻塞队列）+ NAV + 三模式导航 | `tests/mod-pages.test.ts`、169 测试全绿 |
| 控制台待我批准批量治理 | `app.js` 勾选列 + 底部浮条「批量批准 / 批量稍后」，逐条走 `/api/inbox/decide`（一 effect 一授权，不合并语义），勾选跨重绘保持 | `tests/visual-layer.test.ts` |
| 桌面双击即应用（隐藏控制台） | `.tools/start-craft-workbench.ps1` 优先拉起 Tauri release exe、单实例、`-Browser` 降级；`.vbs` 隐藏窗口；`scripts/install-desktop-shortcut.ps1` 生成桌面/开始菜单 `.lnk`（图标 `assets/craft.ico`），数据目录固定 `~/.craft_data` | 构建产物 `craft-workbench-desktop.exe` 存在，快捷方式指向该 exe |

### 新增验证
- `tests/pilot-coordinator.test.ts`：目录打分、描述命中、歧义反问、历史任务冲突、workspace_resolution 回写（服务层 3 例 + 纯函数 12 例）。

## 安全边界（刻意保留，非缺口）
- 插件发现只产出提案，不自动安装、不写宿主配置、不执行外部命令；`writes_host_config: false` / `auto_installed: false` 是显式契约。
- 消息 `智能处理` 是唯一会触发模型/Worker 的路径；基础展示与监听全程 0 Token。
- 自进化 Mod 必须过影子回归集 `passed` 且人工署名批准，才进入 Worker 上下文。
- 不升级版本号；未触碰 `pnpm-lock` 版本与任何 Codex/Claude 配置。

## 验证命令
```powershell
cd D:\documents\project\mytest\craft
pnpm run typecheck
pnpm run audit:layering                    # 566 modules, 0 violations
node --experimental-strip-types --test tests/workbench-server.test.ts tests/file-dir-desc.test.ts tests/mod-registry.test.ts tests/message-inbox.test.ts tests/pilot-review-round.test.ts tests/platform-settings.test.ts tests/plugin-discovery.test.ts tests/pilot-mod-trace.test.ts tests/pilot-coordinator.test.ts

cd ..\craft-workbench
npm test                                   # 171 tests, 0 fail
node --check workbench/app.js; node --check workbench/mod-pages.js; node --check workbench/message-dock.js; node --check workbench/mode-pages.js
```

## 已核对 / 未端到端冒烟
- 桌面启动链路已静态核对：`.tools/start-craft-workbench.ps1` 优先拉起 release 下的 `craft-workbench-desktop.exe`（已构建）、单实例互斥、`-Browser` 才走浏览器降级；`.vbs` 以隐藏窗口调 ps1；桌面 `.lnk` 指向该 exe。真实“双击→应用窗口→宿主 CLI 实跑”的最终人工冒烟仍未在本轮执行。
- macOS/Linux 三模式真实跨平台未在本轮冒烟。消息监听已落地本地/挂载云目录适配器（`LocalDropAdapter`，纯工程 0 Token、`message_seen` 持久去重）；真实 POP3/IMAP/WebSocket 网络监听器仍为后续扩展——`ImapAdapter` 已留协议位并在无配置时诚实报错，网络拉取可在其后端接入而不改动监听框架。
- 完整 `test:ts`（365 文件全量）耗时过长，本轮按风险运行相关模块测试；公共基础能力改动已另跑 typecheck + layering + surfaces + docs + consistency。

## craft-eval 持续评测闭环

每批改动都以 `pnpm eval`（`capability/craft-eval/suite.ts`）作为验收面，评测本身出问题也修：

| 评测面 | 当前结果 | 说明 |
| --- | --- | --- |
| memory / knowledge / workflow / datasec | 5 / 5 / 4 / 2 全过 | datasec 原为装配错误（默认规则刻意关闭凭据规则，用例却期望脱敏），已改为全规则集 |
| self_evolution | 11 / 11 全过 | 影子门禁不可绕过、回归非恒真、候选可观测、坏源隔离、同内容不同文件都入库、目录语义用过才存与常用才转正、项目名解析、合并图不丢跨文件 calls、选择器收纳大声明文件、shell/PowerShell 定义与调用边 |
| end_to_end / governance | INCL（无 `WORKBUDDY_API_KEY`） | 缺凭据是环境缺口，如实记 inconclusive，不再整体崩溃 |
| eval:codebase-retrieval | `evaluation_pass=true` | MRR 0.917、recall@5 1.0、调用图与影响分析 precision/recall 全 1.0 |

评测驱动的两次真实定位（先失败、再改代码，而不是改门槛）：

1. `self_evolution.dir_desc_records_real_use` 首次 FAIL，暴露领航按「项目名」说话时 Coordinator 只匹配文件夹 basename 的缺口，于是新增项目名证据层级。
2. `eval:codebase-retrieval` 三条 golden callers 长期缺失。逐层探针（analyzer → file-unit 合并 → 隔离端到端导入）证明分析与查询都正确，最终定位到 `repository-files.ts` 的 512 KiB 单文件上限丢弃了 `core/application/craft-service.ts`（560 KiB，声明 `CraftService` 本体），导致所有 `declare module` 增强失去基类、约 10.7 万条关系不可解析。修复：单文件上限 1 MiB、总量 24 MiB、文件数 1500，`omitted_by_reason` 记录遗漏原因，索引策略版本升到 14 使旧缓存失效。

`capability/craft-codebase/graph-budget.ts` 是图预算的唯一来源（analyzer / importer / storage / 多语言 combiner 共用），此前四套各自为政曾静默截断跨文件关系边。

### TS 关系诊断：区分外部引用与内部缺口

`noLib` 的 checkpoint 分析无法加载标准库，也无法跟随 `node:` / 裸包，所以 `Promise`、`Map.get`、`readFileSync` 之类的查找失败以前全部计入 `unresolved_relations`，把「本来就不在索引范围内」与「内部关系真的丢了」混成一个约 12.6 万的数字。

现在 `diagnostics` 分项报告：

- `unresolved_relations` 只统计**内部**缺口（`unresolved_type_references` + `unresolved_heritage` + `unresolved_imports` + `unresolved_calls`）。
- `external_references` 单独统计标准库 / 裸包 / `any` 接收者 / checkpoint 外声明 / 外部导入绑定。
- `inline_invocations` 统计 `(() => …)()` 这类没有独立声明的立即调用。
- `unresolved_call_samples` 给出不超过 20 个未解析调用名，便于定位。

实测（craft 自身仓库，1131 个 TS 文件）：`unresolved_relations` 125,980 → **1,210**，`external_references` 124,079，`inline_invocations` 47。评测 `evaluation_pass` 仍为 true 且 precision/recall 全 1.0，说明这不是靠放宽门槛。
