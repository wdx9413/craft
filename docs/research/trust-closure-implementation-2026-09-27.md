# 可信闭环增量实施记录（0.12.37，不是发布完成证明）

## 本批实现

- CraftStore 支持嵌套同步事务保存点；Automation 领取与回执处理在同一事务中进行。非法验收时间不会留下 Receipt/Outcome；两个独立 Node 进程竞争同一 Job 只产生一条派发。
- Automation 派发固定到期时间与 fencing token。到期变为 effect_unknown 和 handoff，不自动重放；重新启用不绕过原派发核对。原派发的匹配独立回执可完成核对并关闭交接。
- Knowledge 审查幂等返回仍重新检查来源、正文、Evidence、过期和矛盾，分别表达历史幂等与当前有效性。
- Engineering Profile 核验各 program check 的 Evidence 内容、独立引用、Case 与验收命令绑定。根因 Evidence 与单纯缺陷复现分开；新验证版本标记为 2，旧版本记录不计入完整配对。
- CLI runner 不再把缺失成本、内部重试补为 0，明确记录 unavailable 并阻止晋级。当前 runner 仍缺真实成本与内部重试测量、独立根因评估，因此不能宣称真实评测闭环已经完成。
- 新增 `pnpm audit:coverage-inventory --check`，独立检查生产文件是否进入受管覆盖范围。检查失败不代表那些文件完全没有测试，而是无法由现有分组门禁证明覆盖完整。它是独立检查入口，尚未把存量缺口清零，也未接入发布成功判定。

## 第一批验证快照（后续结果见文末）

- Automation、Engineering Profile / VerifiedEvaluationReceipt、Codex Driver / Engineering Runner 的定向测试与行/函数/分支覆盖率均通过 100%。覆盖清单模块的三项覆盖率亦为 100%。
- 基础 Store 在补齐保存点回滚、内容恢复和历史清理用例后，行/函数/分支均为 100%；已补入 store-atomicity 受管组。该后续定向结果不覆盖共同工作区的其他失败项。
- 双进程重复验证暴露了派生索引启动锁冲突，已给索引重建添加锁等待和整体事务。修复后 Store 与 Automation 联合定向门禁三项均为 100%。
- 共同工作区全量执行期间：1336 项测试中 1330 通过、6 失败；受管覆盖率 66/72 组通过。这是执行当时的结果，不是最终稳定工作树的验收。
- 运行期间另有 Codebase、Hook、Knowledge、MCP surface 改动，出现过临时缺失 facade 方法的类型错误，随后方法被补入。已请求确认并行修改归属，没有覆盖这些改动或放宽其失败断言。
- 文档审计当前另有 3 条失效链接，位于本轮未编辑的 `craft-components-hookless-review-2026-09-27.md`；同样等待共同改动收口，不能声称全库文档门禁通过。
- 首次覆盖清单：344 个生产脚本，129 个显式列入受管组，215 个未列入。包括兼容导出等需分类文件；不能直接将此计数换算成测试覆盖率。
- 本批不调用付费模型、不安装依赖、不升级版本、不提交/推送；保留已有未提交文件及 `.serena`。

## 明确未完成

成果工作台、能力自诊断整合、统一预算控制、个人数据控制 UI、安静持续任务的完整产品链路仍需实施。真实 Host 配对、原生平台和发布工件未验收。事务修复不等于所有跨文件副作用都支持回滚；程序 Evidence 的内容绑定也不替代可信生产者身份认证。

第一批暂停时先协调共同工作区的修改归属；不得沿用历史绿色结果发布当前工作树。

## 并行任务完成后的收口批次

2026-09-27 已确认「评估 Craft 子能力接入方案」任务完成，重新读取三仓当前 `main` 的未提交改动，保留其多入口/子流程组合、Hookless 接入和分发修改。版本仍为 `0.12.37`。

本批沿用现有 Interface，不增加新的运行时或发布动作：

- `DecisionPointContextGate` 拒绝将 `null`、布尔值、字符串指标转换为实测零值；未提供的指标继续是 `null`。补测仅 Knowledge 贡献可满足必需 Context、空贡献仍阻止执行的路径。
- 保留旧索引的本地诊断及中文短词检索测试，同时明确 MCP 搜索无 scope 时不返回内容，即使有 scope 也不把未审查原始文档当作 reviewed Knowledge。没有删除有效测试或重新开放无 scope 搜索。
- 补齐中立动作分派中组件成员锁定的正常及拒绝路径，拒绝时不调用应用逻辑；不通过为测试放宽组件隔离。
- 补齐 HTTP 已验证身份路由、缺 TLS 证明和无授权路由的测试。请求正文不能选择租户；拒绝发生在读取正文之前。将这些测试纳入已有 `trust-web-runtime` 覆盖率组。

稳定代码复跑：全量 TypeScript 单测 **1359/1359** 通过，无跳过、取消；类型检查通过。初跑中 loopback 监听被沙箱拒绝，获准本机复跑后 HTTP/HTTPS 测试通过，不能把初跑的环境失败当作代码通过。

最终受管覆盖率汇总 **76/76 组通过**，各组仍按原行/函数/分支门槛执行；本批修改的决策门禁三项均为 100%。全量结果在 `/private/tmp/craft-resume-final-tests.log`，覆盖率汇总在 `/private/tmp/craft-resume-complete-gates.log`（本机临时日志，不是发布归档）。

分层审计 358 个 Module、0 违规、无 import 豁免；工具面审计、文档链接（494 条 / 208 份文档）、一致性反例检查通过。Marketplace 的来源校验测试 2/2、Common-use 的安装/探测/参考文件测试 7/7 通过；这些测试验证既有分发工件，不证明本批源码已重新打包或宿主缓存已更新。

覆盖范围清单仍为 **346 个生产脚本，133 个受管，213 个未显式列入受管组**。该清单不是覆盖率百分比，也不表示未列入文件完全没有测试。未放宽阈值，未排除有效逻辑。Rust 工具链仍不可用，原生与 Windows 实测仍未完成。

下一批优先继续 R0：补足变更文件的覆盖范围证明、Host runner 异常路径清理与失败归档、可信生产者身份绑定。真实付费模型试验、原生平台验收和 R1–R4 产品链另行积累证据，不因单测全绿标为完成。三仓均未提交、推送或发布，自动化只在既定批准范围内继续。

## Host runner 异常路径收口

2026-09-27 后续批次将临时目录所有权集中在 runner 的 `runArm` 内：创建目录后，校验、复制和评测都位于同一 `try/finally` 清理范围，只删除本次生成的父目录。原评测步骤放入内部 `evaluateArm`，公开 Interface 不变，没有新增 Runtime、依赖或执行权限。

- 循环中抛错即停止派发，在 Store 事务内记录已有类型的 rejection，绑定 Case / trial / arm 和错误摘要，保留此前回执以及首个拒绝原因。导出部分结果及 `runner_handoff` 后仍抛错，不能作为成功 CLI 退出或自动重试。
- 异常消息可能包含工作区内容，归档只保留摘要和重评条件，不复制原异常正文。该记录用于诊断，不能生成 verified 回执或允许晋级。
- 验证了 Host 造成非法文件树、回执导入抛 Error/非 Error、第二个 arm 中断、准备阶段找不到 fixture、以及归档目标被文件占用。归档失败时，本地 Store 的失败记录仍存在；不能声称此时已经产出归档。
- 正常 120 个 fixture arm 和中断 arm 均检查已知临时父目录被清理；冻结源码摘要保持不变。没有修改或清理当前用户工作树。

定向 23 项测试通过；runner 与 Codex Driver 的行、函数、分支覆盖率均为 100%，类型检查和分层审计通过。日志：`/private/tmp/craft-runner-cleanup-final.log`。这是注入 executor 和本地 Node 验收器的测试，不是真实 Codex 模型试验。

随后的全量回归暴露共用 `executeHostProcess` 的 stdin 竞态：子进程被取消时可能产生未监听的 EPIPE，使测试进程报错。已补输入流错误监听，等待子进程 close 再结算；主动取消/超时保留原状态，其他输入丢失明确拒绝，不能将其视作成功。8 MiB 输入的提前退出、取消和超时用例以及原进程测试连续复跑 10 次通过。共用 Host Driver 已新增到既有受管组，定向行/函数/分支均为 100%。第一次全量的 1360/1361 不作为最终验收，最终复跑另记。

最终复跑：全量 **1362/1362** 通过，无跳过、取消；受管组 **76/76** 通过，本批修改的 runner 与 Host executor 行/函数/分支均为 **100%**。类型、分层、文档及 `git diff --check` 通过。本机日志：`/private/tmp/craft-runner-cleanup-full-final.log`、`/private/tmp/craft-runner-cleanup-all-gates.log`。更新后的清单是 346 个生产脚本、134 个受管、212 个未显式列入，仍不能宣称全库 100% 覆盖。

限制：`finally` 不解决强杀、断电或操作系统拒绝删除时的回收；尚需持久化资源清单和启动后 reconcile。此次未补齐真实成本、内部重试测量、独立根因和生产者身份，因此真实 Host 闭环仍未完成。未重新打包分发仓，未提交、推送或升级版本。

## Experience 导出边界与覆盖范围补齐

2026-09-27 后续心跳再次确认并行任务已完成，三仓仍为当前 `main`、版本 `0.12.37`。沿用原有 Procedure Store 的公开 Interface，保留已实现的多入口/子流程组合，不新增门面逻辑、依赖或自动安装动作。

- 修复 Skill 导出将调用方 `export_id` 直接作为路径的漏洞：ID 仅作账本键，目录使用其摘要；绝对路径和 `../` 不再决定目标目录。只以独占创建方式领取新目录，拒绝既有目录和符号链接，拒绝符号链接形式的 Experience 根目录及 skills 目录。失败清理仅针对本次独占创建的目录。
- 幂等重放核对 Procedure ID、版本和导出正文摘要，重复 ID 指向其他 Procedure、版本或名称时明确冲突。已存在的合法导出记录保留原路径，不迁移或覆盖历史文件。
- 结构化定义先验证再落盘；账本写入失败时移除本次草稿，未产生安装或启用。导出始终为 `enabled: false` / `draft`。
- 审查视图兼容缺失的旧列表字段；这是 Markdown 投影兼容，不补造旧记录的来源或 verified 结论。补测格式兼容、草稿输入校验、Gate 顺序和回滚、幂等冲突及列表过滤。
- 组件诊断补测组件/会话/版本过滤、陈旧记录、缺失工具、可信 Hook 与写入标记的真假路径。诊断不读取正文，也不把可达性和历史执行次数当成本会话绑定或模型收益证明。

新增三个显式受管组：Procedure 投影、组件诊断、Claude Host Driver。分别 14、7、4 项测试通过，行、函数、分支均为 **100%**。这也将既有 Procedure composition 改动的投影路径纳入门禁，而非删除或排除未测逻辑。

同一生产代码快照上的全量 TypeScript 测试 **1369/1369** 通过，无跳过、取消；全部受管门禁 **79/79** 通过。类型检查、分层审计（358 个 Module、0 违规、无 import 豁免）、文档审计及 `git diff --check` 通过。本机临时日志：`/private/tmp/craft-projection-full.log`、`/private/tmp/craft-projection-all-gates.log`、`/private/tmp/craft-projection-final.log`；这些不是发布归档。

覆盖清单现为 **346 个生产脚本，137 个显式受管，209 个尚未显式纳入**，仍为 `incomplete`，不能宣称全库 100%。未纳入不等于完全没有测试；清单仍需逐项验证，不能仅通过排除兼容文件或有效逻辑使结果变绿。

边界与剩余项：文件系统防护针对调用参数和既有目录，不是同用户恶意进程并发替换路径的安全沙箱；强杀、删除失败和跨文件/账本事务仍需持久化资源记录及 reconcile。真实 Codex 配对、可信生产者绑定、真实成本/重试、原生和 Windows 平台验证仍未完成（无本批实测结果）；Knowledge 贡献等剩余变更模块继续补测。成果工作台、预算/数据控制和受控应用能力等已批准产品链仍在剩余清单。未打包同步本批源码、未提交或推送，保留两分发仓已有改动，不暂停尚未完成的自动化。

## Knowledge Context 过期校验与读取契约

2026-09-27 本批先确认并行任务已完成，再核对三仓 `main` 和未提交差异。沿用 `KnowledgeContribution` 的公开 `contribute/search` Interface；通过能力注册及 Context Resolver 接入的调用链不变，不新增门面、依赖或检索权限。

- 先用失败测试复现非法 `now` 被接受的问题；原先 `Date.parse` 返回 `NaN`，过期比较结果为 false，从而不能排除过期内容。现拒绝无法解析的请求时间，并排除非字符串或无法解析的 Claim 到期时间。合法时间沿用原来的含边界语义，`null`/未提供到期时间保留原兼容行为；没有迁移或改写用户数据。
- Scope 归一化集中到已有内部函数，去除调用方重复转换，缺失 scope 仍不获得检索资格。
- 新增公开 Interface 测试涵盖候选诊断与 Context 区分、来源缺失/撤销/不可信/摘要漂移、显式来源筛选、跨项目隔离、作用域栈与有效别名、受限 audience/tenant、正文引用读取、稳定排序和条目/字符预算。
- 测试中的 reviewed 行为是读取投影 fixture，不证明这些 fixture 经真实 Host 审核；没有扩大历史 reviewed 的可信声明。历史复核与可信生产者认证仍在剩余清单。

定向 **4/4** 通过，整个 Knowledge contribution Module 的行、函数、分支覆盖率均为 **100%**，已新增显式受管组；类型检查通过。日志：`/private/tmp/craft-knowledge-red.log`（修复前反例）、`/private/tmp/craft-knowledge-gate.log`（修复后门禁）。

覆盖清单更新为 **346 个生产脚本，138 个显式受管，208 个未显式纳入**；状态仍是 `incomplete`，未放宽门槛或排除有效逻辑。真实 Host 配对、原生平台、当前插件缓存与分发工件未在本批验证。未升级、打包同步、提交或推送。

最终稳定生产代码快照复跑：全量 TypeScript **1373/1373** 通过，无跳过、取消；受管覆盖门禁 **80/80** 通过。类型、分层（358 个 Module、0 违规、无 import 豁免）、文档及 `git diff --check` 通过。本机临时日志：`/private/tmp/craft-knowledge-full.log`、`/private/tmp/craft-knowledge-all-gates.log`。下一批继续补足剩余变更模块的覆盖范围及 R0 可信链；本批不代表 G1 全库覆盖、历史数据复核或任何真实模型收益已完成。

## 检索响应完整性与 Memory 生效时间

2026-09-27 本批确认并行任务仍为 completed，保留三仓现有 `main`、`0.12.37` 和未提交改动。沿用 `RetrievalPort` 与 `temporalMemorySelect` Interface，在共用检索 Module 内修复，不增加另一套 Context 控制面。

- 先以公开 Interface 反例复现：未来生效 Memory 会参与当前选择；非法 Embedding 可被当作 vector 成功并缓存；供应方 Error 正文会进入 `unavailable_reason`。
- 当前 Memory 选择拒绝非法查询时间，排除非法到期/生效日期及未来生效记录，分别记录原因。保留历史视图、到期边界、同 topic 冲突回避和原事件对象；无时间旧记录使用明确的 Unix epoch 排序下界，不再把字符串 `0` 误解析为 2000 年。此处只是选择逻辑，不改写历史账本，不证明事实槽位策略或历史迁移已经完成。
- Embedding 校验整个响应的数量、条目形状、有限数值、非空向量、数值范围与维度；有 `index` 时验证合法性/唯一性并按输入槽位还原，无 index 的旧响应保留数组顺序兼容。缓存命中与本批新增向量共同检查维度，全部通过后才发布缓存，失败批次不会污染缓存。
- 内部暂存集合替代逐项直接写缓存；完整校验保证本轮每个 key 只能来自已验证缓存或已验证暂存集合，不再需要通过测试篡改私有缓存覆盖旧的不可达完整性分支。没有移除任何外部输入校验。
- HTTP 失败只记录状态码，其他异常记录固定错误类别，不将供应方正文、凭据或查询写入回执。无可用供应方时仍通过既有 Context Resolver 执行 keyword 回退；本模块本身不冒称已经执行了回退搜索。
- 更正缓存注释：固定的是配置中的模型标识，而非经过认证的不可变模型修订。维度相同的供应方模型漂移仍需真实版本指纹和独立评测，不由本修复证明。

定向 **6/6** 通过，整个 `core/retrieval-port.ts` 的行、函数、分支覆盖率均为 **100%**；相关 Context/组件集成 **22/22** 通过。新增受管覆盖组。日志：`/private/tmp/craft-retrieval-red.log`、`/private/tmp/craft-retrieval-gate.log`、`/private/tmp/craft-retrieval-integration.log`。所有供应方调用均为测试替身，没有真实网络 Embedding 请求或付费模型调用。

覆盖清单更新为 **346 个生产脚本，139 个显式受管，207 个未显式纳入**，仍为 `incomplete`。真实 Host 对照、原生/Windows 验收、历史修复、生产者身份和 R1–R4 产品链仍按前述剩余清单推进；未重新打包、提交、推送或升级版本。

本批稳定代码快照全量 TypeScript **1379/1379** 通过，无跳过、取消；受管门禁 **81/81** 通过。类型、分层（358 个 Module、0 违规、无 import 豁免）、文档及 `git diff --check` 通过。本机日志：`/private/tmp/craft-retrieval-full.log`、`/private/tmp/craft-retrieval-all-gates.log`。这是代码与测试替身证据，不是生产语义检索质量、真实模型收益或平台支持证明。

## 本地验收报告的标量与路径校验

2026-09-27 本批重新确认并行任务已完成，保留三仓当前 `main`、`0.12.37` 及用户/另一任务的全部改动。沿用已经迁入 application 层的 Acceptance Worker；兼容 `core/acceptance-worker.ts` 再导出及现有 SDK/MCP 调用名不变。

- 先以失败反例证明：Coverage 的 `null`、布尔值可经数值转换参与验收，超过 100 的百分比未拒绝；通过父目录符号链接可以读取工作区外的 JSON 报告和文件。
- Coverage 百分比和阈值要求实际有限数值，并限制到 0–100；显式 `null` 不再当默认阈值。文件大小限额必须为安全正整数。媒体宽高和配置值同样拒绝隐式转换，仅为 ffprobe 时长保留非空数值字符串兼容。原默认阈值仅在未提供时使用。
- 在同一 Module 内复用路径解析和父目录检查，文件、Coverage、媒体报告共享校验。拒绝工作区树内已有的父目录符号链接（含指回工作区内的链接），正常多层文件仍可验收。错误经原 Worker 异常隔离路径成为 blocked，不生成 passed。
- 复用既有文件类型、大小、扩展名、摘要、JSON 结构及租约隔离测试；未删除有效测试，也未另增执行能力。

定向 **7/7** 通过；整个 `core/application/acceptance-worker.ts` 的行、函数、分支覆盖率均为 **100%**，已新增显式受管组。反例和修复后日志：`/private/tmp/craft-acceptance-red.log`、`/private/tmp/craft-acceptance-green.log`。

覆盖清单现为 **346 个生产脚本，140 个显式受管，206 个未显式纳入**，仍为 `incomplete`。路径检查针对已有文件树，不保证其他同用户进程在校验后换链/改写文件时的隔离或原子快照；后续仍需受信 Host/文件句柄级读取及独立来源证明。读取一个本地 JSON 报告也不等于验证其生产者或真实测试运行，本批不能替代真实 Host、原生平台和发布验收。未更新分发工件、提交、推送或升级版本。

本批最终稳定生产代码快照：全量 TypeScript **1381/1381** 通过，无跳过、取消；受管门禁 **82/82** 通过。类型、分层（358 个 Module、0 违规、无 import 豁免）、文档及 `git diff --check` 通过。本机临时日志：`/private/tmp/craft-acceptance-full.log`、`/private/tmp/craft-acceptance-all-gates.log`。未将测试通过、覆盖范围、报告生产者可信性和平台实测合并为一个“完成”结论；其余 R0 与产品项继续保留。

## 维护 Worker 的等待清理与归档路径

2026-09-27 本批确认并行任务最新回合仍为 completed，核对三仓当前 `main` 及差异，保留原改动和版本 `0.12.37`。沿用 application 层现有 Maintenance Module；CLI 和兼容再导出 Interface 不变，不新增后台宿主、常驻安装或执行权限。

- 用公开 `run` 路径复现连续 tick 后 AbortSignal 监听器为 `0、1、2`：原定时器正常结束没有移除取消监听器。正常到时和取消现在共用清理函数，清除定时器、移除监听器并结束等待；补测无 signal、正常到时、取消期间退出、停止状态及锁释放。
- 复现带路径分隔符的旧锁 token 被拼入归档路径导致恢复失败；现仅使用 token 的 SHA-256 作为文件名片段，原锁记录完整保留为归档正文。没有改动 token 的所有权比较语义，也未把摘要当作身份认证。
- 补齐已有 Trace / Knowledge / Memory 维护投影的调度与结果计数测试，分别验证仅账本、候选存在时的调用；这些使用临时 Store 和投影替身，不会清理或迁移真实用户数据，也不证明实际过期策略已完成业务验收。

定向 **8/8** 通过，整个 `core/application/maintenance.ts` 的行、函数、分支覆盖率均为 **100%**，新增显式受管组。反例及修复后报告：`/private/tmp/craft-maintenance-red.log`、`/private/tmp/craft-maintenance-green.log`。类型、分层（358 个 Module、0 违规、无 import 豁免）和文档审计通过。

覆盖清单为 **346 个生产脚本，141 个显式受管，205 个尚未显式纳入**，仍为 `incomplete`。未降低门槛或删除有效测试。稳定生产代码快照全量 TypeScript **1384/1384** 通过，无跳过、取消；受管门禁 **83/83** 通过。日志：`/private/tmp/craft-maintenance-full.log`、`/private/tmp/craft-maintenance-all-gates.log`。文档更新后链接审计及 `git diff --check` 再次通过。

限制：陈旧锁的读取、重命名及所有权复核仍不是多进程原子 compare-and-swap；本修复不证明恶意同用户进程隔离、崩溃恢复、真实 OS Scheduler 或真实 Host 能力。R0 生产者身份、真实评测与原生/Windows 验收，以及已批准的产品链仍未完成。未重新打包、提交、推送或升级版本。

## Supervisor 客户端的目标绑定与响应限额

2026-09-27 本批确认并行任务最新回合仍为 completed，重新读取最终结果并核对三仓 `main` 的未提交差异，保留其 Workflow composition 与分发改动。沿用已经迁入接口层的 `SupervisorClient.call/status` Interface，CLI 调用和兼容再导出不变；没有把网络传输移入 application 层或增加新的 Host。

- 用两个临时 loopback 服务复现：原客户端只校验保存的 URL，但调用参数可通过绝对 URL 改变最终目标，携带本地 Authorization 请求另一个服务。现在在附加凭据前校验解析后的 origin 必须等于已验证的 HTTP/127.0.0.1 origin，且拒绝 URL 用户名/密码。反例覆盖绝对 URL、协议相对 URL、反斜杠变体；拒绝时另一测试服务收到的请求数为零。
- 响应最多累计 256 KiB，超过即销毁响应并拒绝；监听响应流错误，截断不能作为成功 JSON。成功响应必须是对象，拒绝 null、数组和标量，保留原 HTTP 错误及非法 JSON 拒绝行为。
- 每次请求设置 5 秒总时限并销毁超时请求；成功、请求错误和响应错误均清理计时器。总时限不因收到部分数据而延长。没有自动重试：尤其启动/取消请求超时，并不证明服务端没有执行，仍需查询原 run 的状态再决定后续动作。

定向 **8/8** 通过，整个 `core/interfaces/supervisor.ts` 的行、函数、分支覆盖率均为 **100%**，已新增显式受管组。日志：`/private/tmp/craft-supervisor-red.log`、`/private/tmp/craft-supervisor-green.log`。测试只使用本机临时服务和 Store，不调用外部模型，也未发送实际用户凭据。

类型、分层（358 个 Module、0 违规、无 import 豁免）、文档和 `git diff --check` 通过。覆盖清单现为 **346 个生产脚本，142 个显式受管，204 个尚未显式纳入**，仍为 `incomplete`，不代表全库 100%。本批稳定生产代码快照全量 TypeScript **1387/1387** 通过，无跳过、取消；受管覆盖率门禁 **84/84** 通过。本机临时日志：`/private/tmp/craft-supervisor-full.log`、`/private/tmp/craft-supervisor-all-gates.log`。

剩余边界：验证 origin 不等于验证服务端生产者身份或原始 Host 执行；Supervisor 的完整启动失败清理、心跳失败处理及锁恢复竞态仍需单独收口。真实 Host 配对、原生/Windows 及产品链验收没有新增实测证据。版本保持 `0.12.37`；没有重新打包、提交或推送。

## Supervisor 取得锁后的启动失败清理

2026-09-27 本批重新确认并行任务已完成并读取最终结果，保留三仓 `main` 上的全部既有差异，版本仍为 `0.12.37`。按现有接口层生命周期实现修复，没有新增运行时、依赖、外部 effect 或公开 Interface。

- 先复现两个失败：旧 run 恢复抛错后新锁仍存在；HTTP 已监听但状态文件发布失败后端口仍可请求。现将取得锁之后的旧 run 恢复、监听、状态发布及首次心跳纳入同一失败清理范围。
- 失败先撤下本实例监听器并关闭其 HTTP 连接，再检查所有权并释放本实例锁。原始错误继续返回，不改为成功或触发自动重试；修复外部失败条件后，同一实例可以重新启动。
- 清理发现锁 owner 已变更时保留该锁，以 AggregateError 同时报告启动原因和清理失败，要求 reconcile，不静默吞错或删除另一个 owner 的锁。
- 新增初始恢复异常、发布文件被目录占用、首次心跳异常、清理时 owner 漂移测试；既有端口占用、正常启动/复用/关闭、请求安全及超时测试保留。仅使用临时 Store、本机 loopback 和故障注入，不修改真实用户数据。

定向 **12/12** 通过；整个 `core/interfaces/supervisor.ts` 行、函数、分支仍均为 **100%**，沿用已有受管组，没有降低阈值或排除代码。反例与修复后日志：`/private/tmp/craft-supervisor-start-red.log`、`/private/tmp/craft-supervisor-start-green.log`。类型检查、分层（358 个 Module、0 违规）、文档及 diff 检查通过。本批稳定生产代码快照全量 TypeScript **1391/1391** 通过，无跳过、取消；受管门禁 **84/84** 通过。日志：`/private/tmp/craft-supervisor-start-full.log`、`/private/tmp/craft-supervisor-start-all-gates.log`。

仍未证明的边界：本批仅覆盖成功取得锁后的启动过程，不覆盖创建锁文件本身写入失败、持续运行中的心跳失败、并发关闭/启动和跨进程锁恢复竞态。状态文件可能已发布而首次心跳失败，不能仅看残留的 running 字段认定在线，必须实际探测；底层 atomicPrivateJson 的失败临时文件清理另需完善。没有回滚已经发生的旧 run 恢复账本操作，也没有重放任何 Host 执行。真实模型、原生/Windows 与分发包验收仍未完成，覆盖清单仍有 204 个生产脚本尚未显式纳入。未升级、打包、提交或推送。

## 共用私有 JSON 写入的临时文件所有权

2026-09-27 本批确认并行任务仍已完成，读取最终结果并核对三仓 `main` 的差异；保留全部既有改动及版本 `0.12.37`。修复上批明确记录的 `atomicPrivateJson` 残留问题：该函数被配置、设置、Supervisor 和 Maintenance 共用，保持原 Interface，在 infrastructure 层集中处理，不把清理职责复制到各调用方。

- 实际文件系统反例：目标被目录占用导致 rename 失败，旧实现留下带 JSON 正文的临时文件；修复后删除本次临时文件，目标目录及原内容不变。
- 序列化先于落盘；以 `wx` 和私有权限独占创建临时文件，只有取得句柄后才进入清理范围。文件名冲突拒绝时不删除、覆盖另一写入者的文件；不扩展为扫描整个目录或清理历史文件。
- 部分写入失败时关闭句柄并清理本次文件，旧目标不变。写入和关闭同时失败保留两项原因；清理已经不存在的文件可继续报告原始失败，其他清理错误以 AggregateError 保留原始原因并要求 reconcile，不伪装为成功。
- 并发写入验证最终文件属于某一次完整写入，不含拼接或部分正文；仍是原来的最后一次成功 rename 生效，不新增业务层顺序或 compare-and-swap 承诺。

定向 **17/17** 通过；整个 `core/infrastructure/paths.ts` 的行、函数、分支均为 **100%**，新增显式受管组，保留既有配置和平台设置测试。日志：`/private/tmp/craft-private-json-red.log`、`/private/tmp/craft-private-json-green.log`。文件系统故障包含确定性注入，不能当作真实磁盘故障、Windows 或断电演练。初次类型检查发现测试参数缺少类型，已显式补齐并复跑。

覆盖清单现为 **346 个生产脚本，143 个显式受管，203 个尚未显式纳入**，仍为 `incomplete`。本批稳定生产代码快照全量 TypeScript **1397/1397** 通过，无跳过、取消；受管门禁 **85/85** 通过。类型、分层（358 个 Module、0 违规）、文档及 `git diff --check` 通过。本机临时日志：`/private/tmp/craft-private-json-full.log`、`/private/tmp/craft-private-json-all-gates.log`。

边界：不保证强杀、断电、OS 拒绝关闭/删除时一定回收；失败清理需根据聚合错误人工或后续 reconcile。没有新增 fsync、目录持久化、多文件事务或恶意同用户并发换链隔离。成功 rename 后若权限校验失败，调用仍失败，但新内容可能已发布，不能把异常解释为旧内容必定保留。Supervisor 持续心跳故障、锁恢复竞态及真实 Host/原生验收仍未完成。未升级、重新打包、提交或推送。

## Supervisor 持续心跳失败关闭控制入口

2026-09-27 本批确认并行任务仍已完成，读取最终结果并检查三仓 `main` 差异，保留全部已有改动及 `0.12.37`。继续收口已记录的 Supervisor 心跳失败路径；沿用现有 `start/close` Interface，不新增自动重启、Host 取消或任务重放权限。

- 用单个在途 Promise 替代每次 interval 追加 Promise 链；前一次未结束时不排队下一次心跳，避免慢 I/O 下累积无效工作。
- 定时心跳拒绝会被明确捕获，停止 interval 并关闭本实例 HTTP 监听及连接，不让端口继续响应健康或接收新执行请求。停止监听与启动失败、显式关闭共享内部实现。
- `close` 仍等待在途心跳、执行所有权校验和清理，不因先前 Promise 拒绝跳过清理。成功落盘的停止记录带 `handoff_required`；错误正文不进入状态文件，调用方仍收到带原 cause 的故障。清理另有失败时，聚合两项原因；owner 已改变时不删除替换锁或覆盖其状态。
- 修复环境后允许显式重新启动并清除本实例旧故障标记；没有因心跳失败自行取消、恢复或重放已经派发的 Host run。关闭连接也不等于撤销服务端已发生的动作。

定向 **15/15** 通过，整个 `core/interfaces/supervisor.ts` 行、函数、分支覆盖率均为 **100%**，继续使用既有受管组。新增受控时钟测试覆盖非 Error 拒绝、慢心跳不重叠、关闭等待在途任务、故障后重启、owner 漂移与聚合清理错误。日志：`/private/tmp/craft-supervisor-heartbeat-green.log`。类型、分层（358 个 Module、0 违规）、文档及 diff 检查通过。本批稳定生产代码快照全量 TypeScript **1400/1400** 通过，无跳过、取消；受管门禁 **85/85** 通过。日志：`/private/tmp/craft-supervisor-heartbeat-full.log`、`/private/tmp/craft-supervisor-heartbeat-all-gates.log`。

边界：自动失败关闭的即时证据是端口不可用；持久化 `handoff_required` 仅在调用 `close` 且清理/状态写入成功后存在，不宣称已创建通用 Task handoff 或送达通知。OS I/O 永久不返回仍可能阻塞关闭；进程强杀、完整锁恢复原子性、启动/关闭竞争、受信生产者及真实 Host/原生验收继续保留。覆盖清单仍为 143 个受管、203 个未显式纳入，不是全库 100%。未升级、打包、提交或推送。

## Supervisor 恢复归档的身份与路径分离

2026-09-27 本批确认并行任务最终状态仍为 completed，并核对三仓 `main` 与已有差异；保持版本 `0.12.37`。沿用 Maintenance 已有的摘要命名方式，在原 Supervisor Module 内修复，没有新增公开 Interface、配置、依赖或外部 effect。

- 先用实际文件系统复现：旧 owner `../../outside/owner` 被直接拼入恢复文件名，经路径归一化成为另一个目录，导致 rename 失败。owner 是账本标识，不应作为路径组成部分。
- 新归档名仅使用时间戳和 owner 的 SHA-256 摘要；原锁文件完整归档，Host run 恢复仍匹配原始 owner，不把摘要替换成业务身份。
- 新测试通过公开 `start/close` 验证路径分隔符、Windows 风格标识及 NUL、1024 字符 owner；归档均为 runtime 目录内固定格式文件，内容与旧锁一致，对应旧 run 正确标记 interrupted。

定向 **16/16** 通过，整个 `core/interfaces/supervisor.ts` 行、函数、分支覆盖率均为 **100%**，沿用原受管组与门槛。反例及修复后日志：`/private/tmp/craft-supervisor-owner-red.log`、`/private/tmp/craft-supervisor-owner-green.log`。稳定生产代码快照全量 TypeScript **1401/1401** 通过，无跳过、取消；受管覆盖门禁 **85/85** 通过。类型、分层（358 个 Module、0 违规）、文档及 diff 检查通过。完整日志：`/private/tmp/craft-supervisor-owner-full.log`、`/private/tmp/craft-supervisor-owner-all-gates.log`。

剩余：摘要命名不构成锁恢复的原子 compare-and-swap，也不解决同 owner 同毫秒归档冲突、独占创建后的写入失败、启动/关闭竞争或同用户恶意换链；这些仍需独立收口。覆盖清单保持 346 个生产脚本、143 个显式受管、203 个未显式纳入，状态 incomplete。真实 Host 配对、原生/Windows 与产品分发验收仍未新增证据。组件诊断只证明 Memory/Experience 可达，不能作为本次学习或模型收益证明；Knowledge 写入工具当前未挂载。没有改动真实用户数据、重新打包、提交或推送。

## 成本账本拒绝缺失和隐式转换的指标

2026-09-27 本批确认并行任务 completed 并读取最终结果，核对三仓 `main` 和 diff 后继续上次被中断的成本校验工作。中断前仅新增反例测试，生产补丁未落盘；本批保留其他任务、用户及先前所有改动，版本保持 `0.12.37`。

- `priceSave` 仅接受明确的有限非负数值，不再把 null、布尔值、空串、数字字符串和数组隐式转换成价格。
- `usageRecord` 要求显式提供输入、输出 token，两者均为非负安全整数；未知 usage 拒绝落账，不补零。明确提供的 0 仍合法。MCP 工具目录同步将这两个字段声明为必填；沿用原操作名称，没有新增 facade 逻辑或执行能力。
- 按百万 token 缩放后计算成本，拒绝非有限结果落账；测试同时覆盖极大合法价格的中间乘法溢出风险与极小合法价格的提前除法下溢风险。仍采用现有 JavaScript 数值，不宣称任意精度财务记账。
- 公开账本 Interface 测试覆盖无部分写入、价格新增/更新、缺价格、明确零值、项目隔离、默认与指定 ID、正常计价和历史报表兼容行为。原“无价格”测试补齐合法 token，保留该失败路径；没有删除有效测试或降低覆盖门槛。

定向 **3/3** 通过，整个 `core/cost-ledger.ts` 与 `core/mcp/tool-catalog.ts` 行、函数、分支覆盖率均为 **100%**。工具目录覆盖只证明目录构建和本次契约声明，不代表全部 MCP Handler 的行为覆盖。新增显式受管组，覆盖清单现为 **346 个生产脚本、145 个显式受管、201 个未显式纳入**，仍为 incomplete。反例及定向日志：`/private/tmp/craft-cost-ledger-red.log`、`/private/tmp/craft-cost-ledger-green.log`。最终稳定生产代码快照全量 TypeScript **1404/1404** 通过，无跳过、取消；受管门禁 **86/86** 通过，不引用中途修改快照的结果。日志：`/private/tmp/craft-cost-ledger-final-full.log`、`/private/tmp/craft-cost-ledger-final-gates.log`。类型、分层（358 个 Module、0 违规）、文档及 diff 检查通过。

剩余边界：配置价格与调用方 token 不等于受信 Host/供应商事实；价格仍可更新，缺版本/有效期绑定。历史 `usage_ledger` 的缺值默认、汇总范围和溢出行为尚未改造，不能据报表证明真实零成本或收益。本批没有迁移真实数据，也没有运行真实模型、原生/Windows 或分发包验收。当前会话 Knowledge/Experience 诊断可调用、Memory 工具 unavailable；diagnose 仍只是 readiness，不作为本次 Context/Observation 或模型收益证明。未升级、打包、提交或推送。

## 历史成本报表的缺值、溢出与截断

2026-09-27 本批确认并行任务最新 turn 为 completed、任务 idle，并读取其 `experience-gap-review-2026-09-27.md` 补缺结果；任务接口未返回该 turn 的最终消息正文，不用旧消息替代新结果。重新检查三仓 `main`、status 和 diff，保留它的 Procedure Gate、Bundle、MCP 契约与分发改动，继续独立的成本报表收口。

- 通过原 `report` Interface 汇总：任一历史记录缺少指标、含隐式转换值、负值或非法数值时，对应 `total_*` 为 null，并在 `unavailable_metrics` 中明确列出。其他完整指标仍可汇总，不因一项缺失把所有历史记录丢弃，也不改写、删除或补造原账本。
- token 单条与总和均必须处于安全整数范围；成本总和必须有限。防止历史无效数据被补零，或合法单条相加后以 Infinity/失真整数输出。
- 保留 10,000 条展示上限，多读取一条检测截断；截断时 `truncated: true` 且全部总数 unavailable，不把展示子集的和当完整总数。先按项目过滤再判断上限，空集合及明确零值仍返回数学上的 0，不证明某次未观测执行没有成本。
- 测试覆盖 10,000/10,001 条真实临时账本、项目隔离、逐指标无效值、成本及 token 溢出、历史数据不变。非有限历史值另通过 Store 返回值故障注入覆盖，不宣称这是实测供应商数据。整个成本账本及工具目录的行、函数、分支门禁均为 100%，定向 **6/6** 通过。

首次全量发现另一个已完成任务留下的集成契约测试失配：Experience 诊断已要求 get/gate/plan，旧测试仍把缺少这三项的工具集当成完整挂载。保留旧工具集为 mismatch 反例，并通过实际 Experience MCP 工具目录验证 surface_matches；未放宽生产校验或删除测试。相关联跑 **13/13** 通过。反例日志：`/private/tmp/craft-cost-report-red.log`、`/private/tmp/craft-cost-report-full.log`；定向修复日志：`/private/tmp/craft-cost-report-green.log`、`/private/tmp/craft-cost-report-integration-green.log`。最终固定代码快照全量 TypeScript **1411/1411** 通过，无跳过、取消；受管门禁 **86/86** 通过。日志：`/private/tmp/craft-cost-report-final-full.log`、`/private/tmp/craft-cost-report-final-gates.log`。类型、分层（358 个 Module、0 违规）、文档（503 个内部链接、209 篇文档）及 diff 检查通过。

边界：本批只证明账本报告的数值完整性，未补齐受信 usage 来源、价格不可变版本/有效期、真实成本复核和其他 Usage 报表的缺值语义。底层 Store 的 predicate 列表仍会读取该 kind 再过滤；输出有界不等于数据库查询内存/时延已优化。覆盖清单仍为 346 个生产脚本、145 个显式受管、201 个未显式纳入，不能宣称全库 100%。真实 Host、原生/Windows 和本批分发验收未运行。版本 0.12.37，不新增依赖、实际数据迁移、打包、提交或推送。

## 用量记录固定价格版本与内容摘要

2026-09-28 本批确认并行任务最新 turn 仍为 completed、任务 idle，读取其交付文档并核对三仓 main、status 和 diff 后继续；任务接口没有返回最新最终消息正文，不用旧消息代替。保留现有改动与版本 0.12.37。按 codebase-design 的小 Interface、内部封装原则，复用已有 Store 历史版本和 stableDigest，不新增价格副本域或公开方法。

- 新 usage_ledger 在计算时固定所选价格的 price_id、price_version 和 price_digest。版本和摘要从实际选中记录推导，忽略调用方伪造的同名字段。后续更新价格不会改写旧用量的计价依据，可以按历史版本取回并核验摘要、重算金额。
- 价格新增与使用共用严格数值校验；历史价格中的缺值、null、字符串、布尔值、数组、对象和负数不能绕过写入入口的校验进入新账本。拒绝时不产生部分用量记录，也不改写历史价格。
- 测试通过公开账本方法覆盖调价前后金额、独立版本/摘要、伪造输入被忽略、历史重算与旧记录不变。旧 usage 缺少绑定时原样保留，不在读取时补造或升级可信度。测试曾因比较 Store 写入返回值和 JSON 持久化后的 undefined 差异失败，改为比较写入后、调用前后的实际持久化记录，未放宽生产校验。

定向 **8/8** 通过，整个 core/cost-ledger.ts 及既有工具目录覆盖组的行、函数、分支均为 **100%**，未降低门槛或删除有效测试。反例日志：`/private/tmp/craft-cost-price-binding-red.log`；修复后：`/private/tmp/craft-cost-price-binding-green.log`。稳定生产代码快照全量 TypeScript **1413/1413** 通过，无跳过、取消；受管覆盖门禁 **86/86** 通过。日志：`/private/tmp/craft-cost-price-binding-full.log`、`/private/tmp/craft-cost-price-binding-all-gates.log`。类型、分层（358 个 Module、0 违规）、文档（503 个内部链接、209 篇文档）和 diff 检查通过。

剩余边界：摘要绑定的是配置内容，不是供应商签名或受信 Host usage。价格选择仍沿用最后写入的匹配项，尚未按执行时间选择 effective_at，也未验证生效时间格式；本批不宣称历史费率适用性或真实账单正确。旧记录迁移/重验证、其他 Usage 报表缺值语义仍待收口。覆盖清单仍为 **346 个生产脚本、145 个显式受管、201 个未显式纳入**，状态 incomplete，不能宣称全库 100%。真实 Host 配对、原生/Windows、分发包未新增验收证据。组件 readiness 不等于本次 Context/Observation 或收益证明。未升级、新增依赖、迁移真实数据、打包、提交或推送。

## Supervisor 独占锁初始化失败的回收

2026-09-28 本批确认并行任务最新 turn completed、任务 idle，读取其新增 Procedure Invocation 与 Host 验收交付文档后检查三仓 main、status 和 diff。任务接口仍未返回最新最终消息正文，文档是本批可读取的交付结果。保留它的执行绑定、测试、打包与分发改动；不将其真实 Codex Skill + MCP 查询验收误写为未发生，也不扩大为完整 Invocation、配对收益或 Claude/Cursor 登录通过。

- 先通过公开 start 复现：独占创建锁后部分写入失败会留下残缺 JSON；若写入错误码恰为 EEXIST，还会误入旧锁恢复，JSON 解析异常覆盖原始错误。现在仅独占 open 的 EEXIST 进入恢复逻辑。
- 在同一 Supervisor Module 内记录创建文件身份，写入/关闭失败先尝试关闭句柄，再以 lstat 的设备和 inode 复查路径。身份一致才移除本次失败创建的锁；已不存在则保留原错误返回。观察到替换文件、读取身份失败或清理失败时停止并报告 reconciliation，不删除替换者的锁。
- 写入、关闭同时失败保留两个 cause；初始化失败与清理失败也聚合报告。无法取得初始文件身份时只尝试关闭并报告具体阻塞，不凭残缺 JSON 或文件名猜所有权。没有创建运行状态、启动监听或自动重放任务；修复条件后允许显式重试启动。
- 按 codebase-design 保持既有 Interface，复用原文件系统操作和清理惯例；未新增公开方法、依赖或外部 effect。测试使用独立临时目录和受控故障注入，不触碰真实用户数据。类型检查曾发现异常分支局部变量收窄错误，改为内部创建状态后复验，不使用忽略类型错误的指令。

定向 **19/19** 通过，整个 core/interfaces/supervisor.ts 行、函数、分支覆盖率均 **100%**。覆盖部分写入、显式重试、单独关闭失败、双重失败、文件已移除、真实替换文件、设备身份变化、身份读取失败及清理拒绝。反例日志：`/private/tmp/craft-supervisor-acquire-red.log`；最终定向日志：`/private/tmp/craft-supervisor-acquire-green.log`。

首次全量 **1426/1427** 通过，受管门禁 **85/87**；失败源于另一任务新增 Invocation 必需工具后，旧集成测试的缺失清单未同步。保留旧五工具面的 mismatch 反例，更新精确缺失项，并新增“有 plan、无 Invocation”的中间版本反例；完整实际 MCP 工具面仍须 surface_matches。只修改测试，不放宽生产诊断；相关 **7/7** 通过。首次日志：`/private/tmp/craft-supervisor-acquire-full.log`、`/private/tmp/craft-supervisor-acquire-gates.log`；集成日志：`/private/tmp/craft-supervisor-acquire-integration-green.log`。最终固定生产代码快照全量 TypeScript **1427/1427** 通过，无跳过、取消；受管覆盖门禁 **87/87** 通过。日志：`/private/tmp/craft-supervisor-acquire-final-full.log`、`/private/tmp/craft-supervisor-acquire-final-gates.log`。类型、分层（359 个 Module、0 违规）、文档（518 个内部链接、211 篇文档）与 diff 检查通过。

剩余边界：身份检查与 unlink 不是跨进程原子 CAS，不宣称抵御同用户恶意并发换链、进程强杀或文件系统永久不返回。关闭失败可能仍留下 OS 句柄，清理失败需人工或后续 reconcile；本批不保证任意平台故障一定回收。Maintenance 的同类独占创建失败路径、Supervisor 启停竞争/恢复竞态继续待收口。覆盖清单现为 **347 个生产脚本、146 个显式受管、201 个未显式纳入**，仍 incomplete；真实模型配对、原生/Windows 与当前源码的重新分发验收未完成。本批未升级、打包、提交或推送。
