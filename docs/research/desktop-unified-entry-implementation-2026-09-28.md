# Craft v0.12.37 统一入口实施记录

状态：首批代码已落地，验收未完成。分支 main，版本不变；未提交、未推送、未改 marketplace/common-use。保留原有脏代码。

## 已实现

- `entry-session.js`：三视图共享 Task、输入、明确选择的材料和可编辑草稿；既有任务可重新读取；异步选择用票据拒绝过期结果。
- `entry-view.js`：轻入口、材料/草稿并肩、成果编辑三个界面，文本转义、真实空状态、接收模型和材料历史说明。
- `entry-shell.js`：同一 API 传输；键盘和模式切换、文件选择、下载草稿、离开未保存提示；管理/审批/详情入口保留。
- 提交前确认可用模型和字节预算；禁止自动重发；等待最多 90 秒，超时只能说结果未知，不能声称已取消后端调用。
- Desktop 接入 `craft-entry-open` 全局唤起事件和受主窗口身份约束的三种尺寸；没有增加控制应用或文件的能力。
- 顺带修复原有 boot 对未定义 `current` 的引用，以及 bundled Desktop 无 URL token 时被错误拦截的问题。原生请求仍由 Rust 保存的凭据授权。

## 验收证据（本轮）

| 门禁 | 结果 | 限定范围 |
| --- | --- | --- |
| 新增入口单测 | 10/10 通过 | 三个 entry JS 模块；行/函数/分支均 100%，阈值为强制参数并已加入 coverage-gates |
| Workbench / transport / Desktop contract | 8/8 通过 | 以 loopback 权限重跑；静态 Desktop 契约测试不是原生证明 |
| TypeScript | 通过 | `pnpm run typecheck` |
| 分层 | 362 模块，0 违规 | `pnpm run audit:layering` |
| 核心构建、文档、diff | 通过 | `build:core`、524 内部链接/214 文档、`git diff --check` |
| Premium 静态 UI 审计 | unavailable | 全仓审计长时间无输出，已停止本轮进程；没有合规结论 |
| 全库覆盖率、app.js 全面交互覆盖 | 未验证 | 不从三个模块 100% 推导全库或全部增量 100% |
| Rust 编译与原生测试 | unavailable | 本机找不到 rustc；已补纯窗口尺寸测试，尚未执行 |
| 浏览器视觉/交互 | blocked | in-app browser 自动化内核因 `sandbox-exec: unbound variable: TIOCSTI` 退出；用户已允许独立浏览器验收，但 Playwright 技能读取被本机数据安全 Hook 阻断，不绕过 |
| 真实模型收益 | unavailable | 没有调用付费模型；单测模拟回复不是真实 Host 评测 |

执行命令：

```sh
node --test --experimental-test-coverage --test-coverage-include='workbench/entry-*.js' --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 tests/entry-session.test.ts tests/entry-shell.test.ts
node --test tests/workbench-ui-server.test.ts tests/tauri-desktop-contract.test.ts tests/workbench-runtime-client.test.ts
```

## 仍需完成，不能称为理想态

1. 浏览器真实状态矩阵：无模型、创建/继续、移除材料、模型失败、窄窗、键盘、深浅主题及原图对比；不能用 DOM 端口测试替代。
2. Rust 工具链下原生编译、测试/覆盖率，以及 macOS/Windows 安装、全局唤起、尺寸调整、窗口接续实测。窗口调整 API 失败会显示错误，不静默宣称成功。
3. 未发送材料和手动改稿目前只在窗口内存中；退出前明确提示下载。持久草稿版本/恢复应接入受控保存用例，不默认写 localStorage 或知识/记忆域。
4. 并肩视图当前针对明确选定的文本；不等同于读取前台应用、自动吸附外部应用或跨应用编辑。PDF/Office 解析、系统分享入口与控制权接管仍沿用后续 Capability/Adapter 边界。
5. 真实模型、独立验收、完整发布门禁和收益测量仍单独验证。不得以新界面、单元通过或安装状态宣称全部完成。

## 2026-09-28 后续批次：结果未知不能被刷新解除

- 关联任务最新 turn `01a0e5b1-cb2b-7b51-bb99-13a816204060` 已 completed/idle 后才编辑。三仓均仍为 main，原有脏改动保留；本批仅修改入口状态、提示、测试和本记录/UX/QA 文档，未修改分发仓。
- 先补回归测试，在旧实现复现两处失败：任务详情读取清除 unknown；未确认创建结果的草稿经 fresh 清除 unknown。
- 将 unknown 状态绑定到对应任务/未发送草稿，三视图、刷新、离开再返回均不能解除；其他正常任务仍能独立发送。旧 assistant 回复或更改输入也不能作为上一次操作完成的证据。
- 保留已有超时、缺回复、缺创建身份、离线反例，未删除有效测试。入口组现在 **11/11** 通过，`entry-session.js`、`entry-view.js`、`entry-shell.js` 行/函数/分支各 **100%**，沿用上方强制阈值命令。
- 本批 `node node_modules/typescript/bin/tsc --noEmit` 通过；分层审计 **364 modules / 0 violations / no import exemptions**；`git diff --check` 通过。未重新跑全库、打包和原生门禁。
- `pnpm run typecheck` 被 pnpm 的自动 install 前置检查中止（registry fetch / no-TTY purge），未允许清理依赖或升级；改用 package.json 中相同的本地 tsc 命令完成类型验证。
- **仍缺持久化闭环**：本次只是当前窗口内的重复提交保护，不是服务器幂等保证；重载/跨客户端仍需后端 operation identity、终态查询和 reconcile。结果未知时入口保持停止并提示人工核对，没有新增强制重试按钮。浏览器、原生平台和真实 Host 证据仍未获得。

## 2026-09-28 文档收口批次：实现归属与验收边界

- 校正 `UX-CONTRACT.md` 的旧 `studio/`、`src/` 和 `tests/studio-server.test.ts` 引用；指向当前 Workbench、Interface 层、共享 transport、model setup 和实际测试。`DESIGN.md` 明确 HTTP 实现位于 `core/interfaces/`，兼容 re-export 不再当成实现归属。
- 契约明确统一入口的 Ctrl/Cmd+K 优先于旧命令面板、两种上传体积约束的作用范围，以及 Browser Bearer 与 bundled Desktop Rust bridge 的差异。英文完整本地化、可访问性目标和 Windows 适配器描述不再表述为已验收能力。
- 现有文档审计只扫描其受管文档，因此额外对两个根契约逐项验证 **42 个本地 Markdown 链接**均存在；初检发现 Windows vision kernel 实际在 `core/`，已据源码修正。该根契约检查本轮是一次性诊断，尚未纳入 CI 的持久门禁。
- `check-doc-links.ts`：581 条链接 / 218 文档 / 19 ADR 通过；入口与 transport 定向测试 **13/13** 通过；`git diff --check` 通过。仅改文档，没有新增或修改生产逻辑，不以这些测试宣称全库覆盖率。
- 浏览器、原生平台、跨重启幂等恢复、真实 Host 和三仓最终打包验收仍未完成；本批未改分发工件、未提交或推送。

## 2026-09-28 文档门禁：纳入根设计契约

- 后续将上一批的一次性根契约检查接入既有 `scripts/ci/check-doc-links.ts`。新增 `root-design-documents.ts` 仅负责两个固定必需文件的路径及 regular-file 校验；链接检查、ADR 双向索引和失败退出继续由原门禁负责，没有引入第二套链接解析器。
- 根契约缺失、同名目录、符号链接或 junction 均失败关闭，不能静默跳过。新增 3 个测试覆盖路径校验和临时仓库中真实 CLI 的成功、根链接失效、目录链接、原 docs 链接失效、ADR 缺项及缺文件退出。
- 新模块行/函数/分支 **100%**（3/3 测试），已登记 `root-design-documents` 受管组；CLI 本批新增的 import 与追加调用由真实仓库运行及临时副本 CLI 集成验证。不将该模块覆盖率称为整个旧文档审计脚本覆盖率。
- 实际 `check-doc-links.ts` 现在检查 **623 条链接 / 220 文档 / 19 ADR** 并通过；本地 `tsc --noEmit`、`git diff --check` 通过。没有新增依赖、修改版本、扩大 effect 或改动其他任务的覆盖组；未运行全库或原生验收。

## 2026-09-28 全量集成复验：测试污染与退出清理

- 关联任务保持 completed/idle，三仓均为 main、版本仍为 0.12.37。本批只改测试与本记录，不改生产逻辑、依赖或分发工件；保留既有工作区改动，未提交或推送。
- 首轮沙箱内全量为 1448/1470、受管覆盖组 90/92。Context Working Set 的旧正例只有 `ref_id`，不符合新的共享 BM25 检索合同；保留无文本和无关查询不注入的反例，使用 Experience 实际支持的 `trigger` 字段验证正例。五个关联控制模块重新达到行/函数/分支 100%。
- 经批准允许本地 loopback 监听后，发现另一个仅全量组合可见的问题：`industry-gaps.test.ts` 对同一全局 `fetch` 叠加 mock，恢复后留下旧 mock，使两个 Workbench 测试失败。两文件组合的错误栈和新增函数身份回归断言均先复现失败；改为在同一个 mock 上替换实现后通过，未放宽断言。
- `workbench-server.test.ts` 的首个网络测试在断言失败时没有释放监听和轮询，导致全量进程不退出。临时资源追踪确认残留 TCPServerWrap 和该测试创建的 Timeout；新增 `t.after` 清理。注入 fetch 异常时，子测试按预期失败并自然退出，无超时。临时追踪脚本已删除，没有使用强制退出选项掩盖资源问题。
- 修复后组合回归 **39/39**；最终 `scripts/ci/test.ts` 全量 **1471/1471**、0 fail / skipped / cancelled，自然退出码 0，耗时约 94.7 秒。`scripts/coverage/coverage-gates.ts` **92/92 组**通过，各组行/函数/分支均为 **100%**，无分支豁免。统一入口组仍为 11/11。
- 最终两项运行前后，选取的 703 个源文件、测试和配置文件摘要一致：`7d7fbba7cd9ea495bb71e490b75a93f19020bdde968b5a0ba2066cb93c1a345a`。该集合覆盖 core/capability/adapters/bin/workbench/scripts/tests/desktop 的受检代码及根配置，不是整个仓库所有文件的字节快照。
- 临时原始日志：`/private/tmp/craft-entry-closure-final-full-20260928.log`（SHA-256 `49b37741363d230ed391060580c3772d041bf800fb7694a251a0d6a4ecbfc611`）；`/private/tmp/craft-entry-closure-final-gates-20260928.log`（SHA-256 `e5ebfe5169f0ddf0a93c5bf9e1cf0825d1cce6477574f1c7dc76cb62890e817b`）。生成日志不纳入 Git。
- 本地 tsc、分层 **364 模块 / 0 违规 / 无 import 豁免**、文档 **623 链接 / 220 文档 / 19 ADR**、三仓 diff 检查通过。这不是重新完成整个 package `test` 链：本批未重跑打包、插件 smoke、跨平台或真实 Host 评测。

### 剩余验收，不可由上述通过替代

1. 覆盖清单仍为 **incomplete**：统计范围内 352 个生产文件，151 个已登记，**201 个未登记**；其覆盖率未知，不按零或 100% 计算。scripts、部署代码与原生逻辑还需各自分母和门禁，因此不宣称全仓覆盖率 100%。
2. 浏览器视觉/交互仍 blocked；Rust/原生平台、真实 Host 收益仍 unavailable。模块、全量测试通过不替代这些验收。
3. 持久草稿、跨重启 operation identity/reconcile、真实平台和最终三仓发布验收仍沿用上方剩余清单；不因本轮测试通过自动扩大实施或授权范围。

## 2026-09-28 覆盖清单小批次：资产与跨模型比较

- 关联任务仍为 completed/idle，三仓仍为 main；本批仅修改 `tests/capability-assets.test.ts`、覆盖组配置和本记录，保留既有改动，不改生产逻辑、版本、依赖、分发包或授权。
- `core/assets.ts` 与 `core/model-independence.ts` 已有测试实际达到行/函数/分支 100%，但未登记持续门禁。新增 `capability-assets` 组固定这两个完整模块，没有排除有效分支或降低阈值。
- 新增回归覆盖重复同模型不能充当跨模型证据、同模型失败不能被成功结果覆盖，以及 Trial 标识归一化、输入不变性、非法对象/标识/token 数值与归一化后重复项。该比较器处理调用方声明的诊断结果，**不是 Host 身份验证或 VerifiedEvaluationReceipt 晋级入口**。
- 按配置实际执行新增门禁：**16/16 通过，两模块行/函数/分支各 100%**；覆盖清单测试 **1/1**、本地 tsc 和 diff 检查通过。本批未重新跑全量或全部覆盖组；上一节 1471/1471 和 92/92 属于此前快照，不能改写为当前 93 组全部实测。
- 清单分母仍为 352，显式受管由 151 增至 **153**，未登记由 201 降至 **199**，状态仍为 incomplete。内部 Host 执行器用该测试文件单独诊断为行 96.80%、函数 82.35%、分支 43.53%；这是局部测试范围的结果，不是完整执行器覆盖率，未将其冒报为通过或加入虚假通过组。
- 浏览器、原生平台、真实 Host 与持久恢复等产品缺口未改变，未提交或推送。

## 2026-09-28 内部 Host 收口：取消后禁止继续执行

- 关联任务最新 turn 保持 completed/idle 后才修改，三仓均为 main、版本仍为 0.12.37。只改内部 Host、直接测试、覆盖组及本记录；未改分发仓、依赖、权限或发布工件，未提交或推送。
- 将六个已有测试文件组合后，内部 Host 基线为 104/104 通过、分支 96.73%。补充三个取消边界回归先复现失败：预先取消仍执行动作；等待模型期间取消仍执行返回动作；迟到的纯文本回复仍被标为 completed。原测试仅检查最终取消状态，无法发现已发生的动作。
- 在请求前及模型返回后检查取消。已发生请求的已报告用量仍计入，迟到回复不能形成成功终态或动作授权；同一回复的首个动作触发取消时不继续后续动作。统一旧文本动作与结构化调用的归一化路径，移除不可达的联合类型分支，未使用覆盖排除。
- 新增五个测试，包含上述三边界、动作间取消、非 Error 失败脱敏与已报告缓存用量。内部 Host **109/109** 通过，整个 `core/internal-host-driver.ts` 行/函数/分支各 **100%**，登记为持续覆盖组。测试中的模型与缓存数据是 fixture，不是真实 Host 收益或缓存命中证明。
- 全量 `scripts/ci/test.ts` **1478/1478**、0 fail/skipped/cancelled，自然退出码 0；`scripts/coverage/coverage-gates.ts` **94/94 组**通过，各组行/函数/分支均为 **100%**。本地 tsc、分层 **364 模块 / 0 违规 / 无 import 豁免**、文档门禁及 diff 检查通过。未重新执行打包、插件 smoke 或原生门禁。
- 运行期间及全部测试结束后，Git 跟踪文件与未忽略的未跟踪文件共 **1067** 项摘要一致：`91609ecb0f9110d0c21bf7bdd09d7d11f7892badfc8d40cbb8ffcc593d254635`；本节记录在验证后追加，不属于该快照。临时日志为 `/private/tmp/craft-host-cancel-full-0534.log`、`/private/tmp/craft-host-cancel-gates-0534.log`，不纳入 Git。
- 覆盖清单仍为 **incomplete**：352 个统计范围内生产文件，**154** 个已登记，**198** 个未登记；不宣称全仓覆盖率 100%。原生平台、浏览器验收、真实 Host、持久恢复和最终发布验收仍未完成。
- 此修复在请求返回后阻止继续执行，不等于强制中断已经发出的 HTTP 请求或已开始的动作；既有动作副作用仍需各自 reconcile。源码修复也不等于已安装插件或桌面包已经更新。

## 2026-09-28 授权投影持续门禁

- 关联任务仍为 completed/idle，三仓仍在 main。本批只补 `tests/internal-tool-authorization.test.ts`、覆盖组及本记录，不改生产行为、授权范围、版本、依赖或分发包。
- 检查调用链：内部 Host 每次读取 tools 时重投影当前 catalog 与 dispatchable 集合；应用 dispatcher 另做 tier 校验。投影是提供给模型的工具列表，不代替动作内部的 Policy/Activation/审批检查。
- 既有 14 项测试已使整个 `core/internal-tool-authorization.ts` 达到行/函数/分支 100%，但未登记持续覆盖组。本批新增三个回归：终端动词及禁止资源的完整分段匹配、catalog 与可分派集合实时缩减、冻结输入不被修改且额外工具不能替换 canonical 定义。没有修改既有 tier 成员关系语义；本组不证明所有工具命名均准确表达实际 effect。
- 新登记 `internal-tool-authorization` 组，按门禁相同隔离与阈值参数执行，**17/17 通过，完整模块行/函数/分支各 100%**。与 Host/dispatcher/覆盖清单组合回归 **67/67** 通过，本地 tsc、文档链接与 diff 检查通过。临时日志：`/private/tmp/craft-auth-final-0604.log`、`/private/tmp/craft-auth-regression-0604.log`，不纳入 Git。
- 现有登记组为 **95**；本批没有重跑全部组或全量测试，上一节 94/94、1478/1478 仍仅属于上一快照。清单为 352 个生产文件、**155** 个受管、**197** 个未登记，状态仍为 incomplete；不宣称全仓覆盖率 100%。真实浏览器、原生平台、Host 收益及最终发布验收未新增证据，未提交或推送。

## 2026-09-28 预算截断：计入标记与混合文本密度

- 关联任务仍 completed/idle，三仓 main，版本保持 0.12.37；保留已有改动。本批只修改 token-budget、直接回归/MCP 调用路径测试、覆盖配置与本记录，不改用量账本、压缩策略、依赖或授权，不打包、提交或推送。
- 新回归先复现：`truncateToBudget` 在 cap=1 时返回估算 4；cap=10 的英文返回 13，中文前缀加英文后缀返回 25。根因有两处：追加标记不计入预算，按整段字符比例裁剪不能约束密度不同的前缀。Unicode 码点切分不是这次根因，仍保留防止切断代理对的回归。
- 以既有 `estimateTokens` 对“前缀＋标记”整体估算，二分查找最长可保留前缀；完整标记放不下时使用短省略号。未超限输入原样返回，返回接口不变，`truncated` 仍明确表示有损。该保证仅针对 Craft 确定性估算，不等于供应商真实 tokenizer 或收费上限。
- 新登记 `token-budget` 组：整个 `core/token-budget.ts` 行/函数/分支各 **100%**，模块及真实 MCP handler 路径 **15/15** 通过。覆盖 1–20 的小预算、中文/英文/emoji/混合前缀、最长前缀、完整标记、短标记和刚好装满；另有固定 seed=42 的 **12,500** 组临时性质检查通过。没有排除有效逻辑或删除有效测试。
- 全量 TypeScript **1483/1483**、0 fail/skipped/cancelled，自然退出码 0；本地 tsc、分层 **364 模块 / 0 违规 / 无 import 豁免**、文档与三仓 diff 检查通过。临时日志：`/private/tmp/craft-token-red-0634.log`、`/private/tmp/craft-token-gate-0634.log`、`/private/tmp/craft-token-full-0634.log`；不纳入 Git。
- 全量运行期间及结束后，1067 项 Git 跟踪/未忽略未跟踪文件的摘要一致：`b3c5a78b355cd7d2a89547c8424a85744968694afb84ec7cceba43264299f174`；本节在验证后追加。现有覆盖组为 **96**，本批只执行新增组，未重跑全部组。清单为 352 个生产文件、**156** 个受管、**196** 个未登记，仍 incomplete。
- 浏览器、原生平台、真实 Host 收益和最终分发验收未新增证据。Usage 报表的缺值语义等先前记录的缺口仍待独立收口，不因预算截断修复自动视为完成。

## 2026-09-28 任务与交付状态投影门禁

- 关联任务仍 completed/idle，三仓 main、版本 0.12.37；本批仅修改 task-control 测试、覆盖组及本记录。已读取 TaskControl → DeliveryLoop → WorkDelivery 调用链和既有 MCP/Workbench 测试，不改生产逻辑、外部 effect、依赖或分发工件。
- 既有 6 项组合测试已使三个模块行/函数/分支达到 100%，但未登记持续门禁。本批新增取消/中断/失败状态矩阵：即使 acceptance 投影为 passed，也只能保持 host_failed、retry_or_handoff、人类处理；产生 handoff 不派发 Host 或重写原 Host 状态。
- 新增 handoff 版本回归：状态推进后，复用旧交接 id 必须冲突；新交接绑定新状态版本，旧交接内容保持不变。user_pause 在此只是交接原因，不据此宣称真的暂停了 OS 进程，也不把状态投影当成执行授权或独立 receipt 验签。
- 新登记 `task-delivery-control` 组，**8/8** 通过；`core/task-control.ts`、`core/delivery-loop.ts`、`core/work-delivery.ts` 完整模块行/函数/分支各 **100%**。关联 TaskRun、DeliveryEvaluation 和覆盖清单回归 **13/13** 通过，本地 tsc、文档与三仓 diff 检查通过。原始日志：`/private/tmp/craft-task-delivery-final-0704.log`、`/private/tmp/craft-task-delivery-regression-0704.log`，不纳入 Git。
- 当前登记 **97** 组；本批未重新跑全量或全部组。上一节 1483/1483 是上一快照的全量结果。覆盖清单仍 incomplete：352 个生产文件、**159** 个受管、**193** 个未登记，不宣称全仓 100%。真实暂停/恢复、跨重启幂等、浏览器、原生平台、Host 收益及最终发布验收仍单独待完成。未提交或推送。

## 2026-09-28 Task Run：拒绝过期交付投影

- 关联任务仍 completed/idle，三仓 main、版本 0.12.37。沿 TaskRun → DeliveryLoop → WorkDelivery 检查时发现：Task Run 只读取已有 loop.action，未核对投影引用是否仍与当前事实一致。本批不改其他任务的实现、依赖、外部 effect 或分发工件。
- 三个新增反例先失败：分别更新 Host、Launch、Acceptance 后，旧 deliver 仍形成 ready_for_delivery。现在消费投影前核对三者的 id/version；过期、缺必要绑定或跨对象的投影不可作为当前指导，终态路径转 blocked/human_handoff，保留旧记录，不自动重跑验收或派发任务。暂停、取消、输入漂移的既有优先级不变。
- 显式刷新反例进一步发现 DeliveryLoop 的交付记录 id 缺少 Launch 版本，导致同一 Host/Acceptance 下 Launch 更新后与旧记录冲突。新生成 id 加入 Launch 版本；历史记录保留，显式刷新产生新的观察记录。不迁移真实数据、不覆盖旧证据；身份/版本匹配不是签名验证或独立 Host 执行证明。
- 新登记 `task-run` 组 **7/7**，既有 task-delivery-control 组 **8/8**；本轮两个改动生产模块及交付控制组完整行/函数/分支均 **100%**。组合 **15/15** 通过，包含版本变化、同版本但不同对象、缺绑定、旧交付记录不变与刷新后恢复合法指导。反例日志 `/private/tmp/craft-task-run-red-0734.log`；门禁日志 `/private/tmp/craft-task-run-gate-0734.log`、`/private/tmp/craft-task-delivery-gate-0734.log`。
- 全量 TypeScript **1489/1489**，0 fail/skipped/cancelled，自然退出码 0；本地 tsc、分层 **364 模块 / 0 违规 / 无 import 豁免**、文档与三仓 diff 检查通过。全量日志 `/private/tmp/craft-task-run-full-0734.log`，不纳入 Git。运行期间与结束时 1067 项 Git 跟踪/未忽略未跟踪文件摘要一致：`fa146a95b00f7c750948cbab6683dec90e6a36d9228ac916997a4e9b9513b966`，本节在验证后追加。
- 登记组现为 **98**，本批未重新跑所有覆盖组。清单仍 incomplete：352 个生产文件、**160** 个受管、**192** 个未登记，不能称全仓 100%。真实 Host、浏览器、原生平台及发布验收仍单独待完成；未打包、提交或推送。
