# 自进化闭环验收记录（2026-10-20）

完整目标仍未通过验收。本轮从 `0.12.85` 工作区开始改造，并发布 `0.12.86`，覆盖全量会话采集、任务证据整理、独立评测集、Knowledge 闭环、Memory/Experience 生命周期、增量运行和使用反馈七项范围。已完成部分实现与代码级验证；真实任务闭环仍缺可核验任务证据，不能宣称自进化已跑通。

## 本轮实现与证据

- 默认采集 `CODEX_HOME/sessions` 和 `CODEX_HOME/archived_sessions`。显式提供 `sessions_root` 时，只访问该目录；需额外指定 `archived_sessions_root` 才访问归档目录。
- 两种来源使用独立索引键。归档和恢复保留任务、会话、生成/留出分区，以及源内容摘要一致且项目范围不变的验证证据。恢复操作即使保留原文件时间，也会重新绑定来源。
- 归档内容改变后重新核验；根目录判别字段校验、路径越界检查和符号链接限制继续生效。原始会话不写入 Craft 能力数据。
- 生成与留出评测的消费者测试证明：合格夹具归档后仍各自可用，重复轮次不会再次调用模型，两个分区不会互相消费。此项属于程序测试，使用替代模型响应。
- 真实归档增量扫描：本轮扫描时看到 632 个来源；扫描期间新增会话后，索引快照增至 641 个来源、4,910 个任务，其中完成 4,819 个、中止 87 个、运行中 4 个；生成集 1,399 个、留出集 3,511 个。两个仍待处理来源都在增长，采集器保持 `partial`，因此这不是静止全集的最终计数。没有任务绑定合格验证证据，生成侧与留出侧可用于评测的任务均为 0；Knowledge 候选和留出评测为空闲，模型调用、能力工具调用为 0。该结果只证明真实来源下安全空闲，未证明正向闭环。
- `core/codex-session-archive.ts` 的 Node 原生行、分支、函数覆盖率均为 100%，并已加入持续集成的 `codex-session-provenance` 覆盖率门禁。会话采集与消费者相关测试通过；本轮 20 个定向测试文件共 399 项通过。另有六个受影响覆盖率组通过 100% 行、分支、函数门禁：会话来源、会话记忆存储、存储原子性、仓库状态、工作区仓库绑定、上下文修复。

本地运行证据：

- `.craft_data/codebase/evaluations/javascript-incremental-self-repo-2026-10-20.json`：固定 HEAD 下 JavaScript 文件集的增量与全量图一致性、未解析关系数及快照摘要。
- `.craft_data/codebase/evaluations/typescript-incremental-self-repo-2026-10-20.json`：TypeScript 模块子集的增量与全量图一致性；同时记录全仓库非模块文件导致全量回退的范围限制。
- `.craft_data/codebase/evaluations/current-index-checkpoint-verification-2026-10-20.json`：持久索引的检查点、Git 状态和 907 个文件摘要逐项复核。
- `.craft_data/knowledge/evaluations/archive-live-validation-2026-10-20.json`：真实来源的扫描统计和空闲结果。
- `.craft_data/runtime/archive-validation-index.json`：内容无原文的来源索引，仅用于本轮来源核查，不作为正式 Knowledge 或 Experience。
- `.craft_data/codebase/coverage/session-archive/coverage-final.json`：修改模块覆盖率。

运行数据均受 `.gitignore` 排除。报告中的统计为当次观察结果，不能替代后续运行的状态核查。

## `.86` 远端发布与 Host 运行证据

- 源码 `main` 提交 `8e4a8fa0c404e1b119e7d1cc393476b5f9a3f158`；Marketplace `main` 提交 `ac23f24`。Marketplace 载荷由 GitHub 上固定 SHA 的源码归档构建，`release.json` 记录了源码摘要 `sha256:268fc6245370c4887cca090f04b569a07ca870c1287c8d31ddcda846c52797f9`；同步校验通过，未使用本地源码路径。
- `codex plugin marketplace upgrade craft-marketplace` 成功刷新远端缓存。`codex plugin list` 显示 `craft-context` 为 `0.12.86`；`codex mcp get craft-context` 指向 `~/.codex/plugins/cache/craft-marketplace/craft-context/0.12.86/dist/plugin/craft-mcp.cjs`。
- 新启动的 `codex exec -m gpt-6-luna` 真实调用了 `craft_info`，返回版本 `0.12.86`、数据根目录 `~/.craft_data`、语言 `zh-CN`；这证明新 CLI 会话实际加载了新 MCP 包。该 Host 调用记录为 81,858 输入 token、144 输出 token，成本明显偏高，需缩减 Host 提示与 MCP 工具描述后再做额外模型验证。
- Host 状态有 200 条 Knowledge Claim、0 个 Knowledge 评测用例、0 个 Experience Pattern、0 条 Memory 使用反馈。实际会话扫描为 `partial`：当次看到 633 个来源、索引 4,946 个任务（4,852 完成、90 中止，其余处于运行态），生成/留出分区为 1,403/3,543；两个来源仍增长，核验任务为 0，两侧可用任务也为 0。没有触发候选生成或晋升。
- 真实运行证明了远端发布、Marketplace 刷新和新 Host 加载链；没有证明真实 Knowledge/Experience 产出、独立评测通过、自动晋升或使用后收益。

## `.86` 增量真实任务验证（2026-10-20）

- 对扫描得到的完成任务补查 Host 完成 Evidence 后，31 个候选会话里找到 1 条合格 Evidence；该任务进入生成集，留出集仍为 0。采集器不保存原始会话正文。
- 用 `.86` 的 Knowledge Worker 和 Codex CLI Host `gpt-6-luna` 处理这一条任务，生成 Claim `knowledge_claim_b6ad3247dc8f8034c5688356`，中文标题为“Craft-context 作为唯一对外发布的组件插件”，状态为 `candidate`，绑定 1 条 Evidence。该过程没有评测用例，因此没有评测或晋升。
- Trace `trace_8bb83fdfc9db44608dd3ea6e68a04b80` 记录 `model.request`、`model.completed`、`knowledge.candidate_created` 和 `trace.finalized` 四个事件；模型用量为 20,425 输入 token、167 输出 token。调用摘要与输出均以摘要和引用入账，`content_stored=false`。
- 首次落盘检查发现 Claim 正文引用到了工作区 `.craft_data`。这不符合“最终数据统一在 `~/.craft_data`，能力和项目分层”的约束。已核对记录 ID、正文摘要和字节数，将该 Claim 正文迁至 `~/.craft_data/knowledge/projects/167c1c305f66e17dc5ec4f1c/md/`，更新账本引用并移除本轮生成的工作区副本。
- 源码已修正项目 Knowledge 内容目录：仍使用注册的项目别名校验作用域，正式正文统一写入用户数据根目录。3 项针对性测试通过，`core/project-knowledge-content.ts` 行、函数、分支覆盖率均为 100%。该修复已发布为 `.87`，详细运行时证据见下节。
- 这证明一条真实任务能够产生有来源和 Trace 的 Knowledge 候选；不证明留出评测、自动晋升、Memory/Experience 产出或持续收益。留出样本、Knowledge 评测用例、Experience Pattern 和 Memory 使用反馈仍不足。

## `.87` 远端发布与新 Host 加载（2026-10-21）

- 源码 `main` 提交 `a7963b01cee17b55010e9785b6e6e17f71bbe05b`；Marketplace `main` 提交 `7ae6e99`。Marketplace 使用 GitHub codeload 固定 SHA 归档构建；归档与该提交的 1,369 个 Git 跟踪文件逐项比较，缺失和内容差异均为 0。发布来源摘要为 `sha256:7768bfa89edce18d5e027a1bd879fbbf50d4f8fa780e4d6a068d2d397b32d988`。
- `codex plugin marketplace upgrade craft-marketplace` 成功。插件清单显示 `craft-context` 为 `0.12.87`，来源是 GitHub Marketplace；`codex mcp get craft-context` 指向 `~/.codex/plugins/cache/craft-marketplace/craft-context/0.12.87/dist/plugin/craft-mcp.cjs`。
- 直接对已安装 MCP 包执行初始化握手，返回 `serverInfo.version=0.12.87`、运行时指纹 `release=0.12.87`，输出语言规则为 `zh-CN`。这验证了新 MCP 进程实际启动了 `.87` 包。Context 组件工具面不提供 `craft_knowledge_claim_get`，因此本轮没有声称通过该 Host 工具读取了候选。
- `.87` 的产物内容路径逻辑已在 Marketplace MCP 包中确认；本地 100% 覆盖率测试覆盖项目别名校验、按项目隔离和路径写入。真实候选正文与账本引用已在用户级 `~/.craft_data/knowledge/projects/{项目ID}/md/` 下逐项核验。
- Marketplace 发布和新 Host 加载已验证；新 Host 下再次生成或读取候选、Knowledge 独立评测与自动晋升、Memory/Experience 生命周期及反馈仍未验证。

## `.88` 项目路径修正、Host 刷新与当前样本状态（2026-10-21）

- 源码 `main` 为 `1992b00015e4f3d8ce29da205524bd2ae5ec47dd`；Marketplace `main` 为 `b2d2c50`。`.88` 修正了 `.87` 中把项目 Knowledge 正文写进全局目录的问题。候选正文现在位于项目工作区的 `.craft_data/knowledge/md/`，但 Knowledge Claim 元数据仍在全局 `craft.db`，因此能力账本和项目数据尚未完全隔离。
- `codex plugin list --marketplace craft-marketplace --json` 显示 `craft-context` 已安装并启用 `.88`；`codex mcp get craft-context` 指向远端 Marketplace 缓存中的 `.88` MCP 包。当前长会话的 MCP 工具仍返回 `.85`，表明该 Host 会话没有热替换已运行的 MCP 进程。
- 新建的 Codex CLI Host（`codex exec --ephemeral --model gpt-6-luna`）只调用一次 `craft_info`，实际返回 `version=0.12.88`、`data_root=~/.craft_data`、`content_language=zh-CN`。本次调用用量为 56,466 输入、328 输出 token；它只验证 Host 加载版本，没有触发学习 Worker 或候选生成。
- 该 Host 返回 204 条 Knowledge Claim、0 个 Knowledge Evaluation Case、0 个 Experience Pattern、0 个 Memory Item、0 个 Memory Usage Signal。这个计数来自主账本，不代表项目/全局目录隔离已经完成。
- Codex 会话索引最新更新时间为 `2026-10-20T16:22:58.169Z`：644 个来源、5,068 个任务（4,971 完成、93 中止、4 个运行中）；5,067 个任务没有匹配终态 Evidence，1 个已核验任务在 `candidate_generation`，`held_out` 可评测任务为 0。分区总量为生成集 1,403、留出集 3,665；这只是按会话切分，不等于可用的有效评测集。
- Knowledge 和 Experience Worker 的锁由 PID `74585` 持有；本机 `kill(pid, 0)` 检查确认该 PID 存活。为避免重复 Worker 写同一数据根，本轮没有再启动 Worker。沙箱拒绝 `ps` 进程详情查询，因此该进程实际加载的 MCP 版本尚未直接核实。
- 结论：`.88` 新 Host 加载已证明，长期运行的 Host/MCP 会话仍旧；真实任务索引已证明，独立留出证据仍为 0；没有新增候选、评测、晋升或使用收益证据。

## `.89` Experience 项目路径、远端发布与真实 Host（2026-10-21）

- 源码 `main` 提交 `1241207c0a9afa10328034e454d3235042023bd9`；Marketplace `main` 提交 `e16647d22099ac24919d4d620a2c1217ae97e332`。源码先推送，再从 GitHub codeload 固定 SHA 下载并构建；没有克隆仓库，也没有引用本地源码目录打包。Marketplace 校验 39 个载荷文件非空且无替换字符，远端归档与 Marketplace 的源文件同步检查通过。
- `.89` 将项目 Experience 草稿、流程定义、图版本和 Markdown 正文按注册项目根目录写入 `.craft_data/experience/`；全局作用域继续使用 `~/.craft_data/experience/`。旧全局引用保留只读兼容。项目候选、观察、评测等结构化账本尚未分区，仍是剩余数据隔离工作。
- 路径和流程定向测试 120 项通过。`content-store.ts`、`project-experience-directory.ts`、`procedure-definition.ts`、`graph-assets.ts`、`graph-version-manifest.ts` 的行、分支、函数覆盖率均为 100%；TypeScript 构建、插件包检查、版本检查和发布目录检查通过。
- `codex plugin marketplace upgrade craft-marketplace` 成功。插件清单与 `codex mcp get craft-context` 指向 Marketplace 缓存中的 `0.12.89`。新建 `codex exec --ephemeral --model gpt-6-luna` Host 实际调用 `craft_info`，返回 `version=0.12.89`、`data_root=/Users/didi/.craft_data`、`content_language=zh-CN`。这次只核验 Host 加载，未触发候选生成或评测；用量为 141,867 输入（其中缓存 120,064）、939 输出 token，需降低验证成本。
- 可见账本计数为 208 条 Knowledge Claim、0 个 Knowledge Evaluation Case、0 个 Experience Pattern、0 个 Memory Usage Signal。当前会话索引更新时间 `2026-10-20T16:48:56.665Z`：644 个来源、5,103 个任务（5,002 完成、96 中止、5 运行中）；生成集 1,403、留出集 3,700。仅 1 个任务有核验标记且处于生成集；留出集中有核验证据的独立任务为 0。以上无法支持效果评测或晋升。
- 最近可查到的 Worker Trace `trace_ddb10daecd6d4eab9b6ea5634264d8a4` 在 `.89` 源码提交前完成，票据 `evaluation_model_ticket_84e6301a1e4aa960fd07` 使用 `codex-cli/gpt-6-luna`。Trace 有 `model.request`、`model.completed`、`knowledge.reviewed`、`model.result_bound`、`trace.finalized`，模型用量 22,544/17。目标 Claim 仍为第 1 版 `candidate`，`scenario_key` 为空，没有产生评测或晋升；因此这是有调用记录、但没有可见产物变化的失败闭环证据，不能算 `.89` 运行结果。
- `.89` 发布提交之后，主账本没有新增 Knowledge Claim、Experience Observation/Pattern、评测用例或使用反馈记录。结论：远端发布和真实 Host 加载链已接通；真实学习产出链仍未证明，独立留出任务证据仍为 0。

## 完整验收矩阵

| 要求 | 当前证据与缺口 | 后续必须取得的证据 |
| --- | --- | --- |
| 合格任务自动选择能力和流程 | 本轮真实来源没有可核验证据，未召回可用于自动选择的正式能力产物 | 分别运行合格真实任务，绑定 Context 回执、正确能力和实际执行流程 |
| Codex CLI Host 确实调用 `gpt-6-luna` | 一条合格生成集任务触发真实调用；Trace 有请求、完成事件及 20,425/167 token 用量 | 为留出集建立独立有效样本，并测量多次运行的一致性与成本 |
| 生成可追溯候选 | 已生成 1 条中文 Knowledge Claim 候选，绑定 Evidence 和已完成 Trace；正文已迁入 `~/.craft_data/knowledge/projects/{项目ID}/md/`；`.87` 已安装且实际 MCP 握手确认版本 | Context 面不含 Knowledge Claim 读取工具，因此新 Host 下的候选读取未直接验证；需积累多条不同任务的候选及版本关系 |
| 独立评测 | 本轮验证归档前后按会话固定分区，两个消费者保持隔离 | 独立真实会话及任务证据，明确排除生成会话与同任务变体；模型标签候选不能当作真值 |
| 晋升、降级、回滚、退出 | 本轮未取得真实生命周期证据 | 由独立评测驱动的状态转换和完整变更记录 |
| 没有合格任务时不空转 | 空队列时 Worker 保持空闲的程序测试通过；这次仅在发现 1 条合格任务后调用 1 次模型 | 其他任务发现路径和 Experience Worker 的同等真实运行证据 |
| Knowledge 和 Experience 的会话→项目→全局生命周期 | 本轮未取得跨项目晋升证据 | 各能力独立规则、跨会话证据持久保留、跨项目共同条件验证及独立评测 |
| Memory 三级阈值、冲突和退出 | 源码含两个独立会话及三个项目的阈值；本轮 65 项定向测试通过，覆盖原始会话唯一标识路径、旧哈希目录重建后清理、路径碰撞/符号链接保护、归档后阻止 MCP 直接写入，以及临时记忆清理时项目/全局正文保留。主库 83 条 Memory 目录行均有分区引用且无正文，全局库 79 条、当前项目库 4 条。以上仍不是用真实独立任务证明自动晋升、冲突、撤销和退出 | 真实独立会话/项目中的晋升、冲突、撤销和归档保留证据；崩溃恢复、并发写入及持续账本故障验证 |
| Codebase 五语言、分支隔离和重索引 | 既有固定仓库证据：Go `skill-up@12deb53a19147704e3f547602962edf6d22e0c54` 经 `gopls` 分析 227 个文件，改单文件后分析 1 个、复用 226 个，增量图与干净重建一致；关系仍为 partial 且仅报告引用。Java `d-forge@a18ce57e47b207ba994c7efdff6c4eef03072152` 分析 1,115 个文件，改单文件后因不安全单元和反向依赖闭包重分析 974 个、复用 141 个，增量图一致；分析报告 100 个编译错误和未解析关系。Python `d-simu@6462cd6783fe1a7c03888e845dbe2f4f273f5313` 的真实控制流样本通过，14 个块、15 条边，`Await` 明确标为 partial。TS/JS 在当前 Craft 工作区快照（HEAD `960a66445607b1dc66c2c8bf220c58951c1be5ce`）的 853 个文件上运行两轮；增量图均与独立目录完整重建一致，影响 1/8 个文件、复用 852/845 个文件，中位用时 35.455/46.092 秒，速度比 1.30。此前 9 条边差异来自完整重建误用了增量项目缓存，现已隔离缓存并断言完整分析模式，旧结果作废。另新增仓库状态绑定：检查点保存 Git 根目录、分支、HEAD 和工作区状态摘要；真实 Git 集成测试证明同内容分支切换与空提交都会使旧快照失效，索引器随后重建；文件变更仍由内容校验发现。Git 元数据探测失败现在仅在无 `.git` 标记且 Git 返回非仓库状态时回退为非 Git；仓库标记存在、权限失败或 Git 不可用时均失败关闭。状态绑定模块 5 项测试通过，行、函数、分支覆盖率均为 100%；`core/workspace.ts` 与仓库上下文/检查点用例合并的 79 项测试通过，模块行、函数、分支覆盖率均为 100%，覆盖门禁已登记。持久语义索引刷新已完成：索引 `repository_index_24ae9145e90cd9e6bb7d4753` 绑定检查点 `workspace_checkpoint_78b0355d5387444ca7534780612dfb23`；支持 895/907 个文件，12 个不支持，关系图 261,277 条边且状态为 partial。独立复核确认 907/907 个当前文件摘要匹配，分支、HEAD 和工作区摘要都与检查点一致。JavaScript 单独使用同一固定 HEAD `960a66445607b1dc66c2c8bf220c58951c1be5ce` 的当前工作区，索引 21 个 JS 文件（17 个模块），修改 1 个模块后重分析 1 个、复用 20 个，增量图与全量图一致；仍有 301 条未解析关系。Craft 自身的 JS 样本较小，不能代表独立 JS 大型仓库。TypeScript 从 853 个文件中选取 844 个模块文件单独评测，修改 1 个文件、重分析 1 个、复用 843 个，增量图与全量图一致；模块图有 82,632 条未解析关系、622 个省略节点及 207,437 个省略边。另有 9 个全局/环境声明文件，包含它们的全仓库计划按规则退回全量分析，不能算增量通过。TS/JS 合并图有预算省略；五语言固定仓库完整评测及整体关系完整度尚缺 | 等当前索引重建完成后登记新检查点和真实文件/关系统计；为五种语言分别提供固定版本仓库评测、分支切换隔离与变更后重索引；报告关系完整度和限制；核验 Serena、GitNexus、CodeGraph 的 Agent 实践 |
| 按能力、项目和全局隔离最终数据 | Memory 按作用域分区原型已有 65 项定向测试通过，并实查主库/全局库/项目库记录数为 83/79/4，主库 Memory 正文为 0。Knowledge、Experience 和 Codebase 账本仍未迁移；Memory 跨分区进程崩溃恢复、孤儿清理、并发故障注入尚未验证 | 补齐 Memory 分区崩溃恢复和并发验证；再迁移其余能力的正式账本；在项目与全局根核验最终正文路径、引用完整性、恢复和兼容读取 |
| 增量覆盖率 100% 与远端版本绑定 | 项目 Knowledge 路径变更的行、函数、分支均 100%；TS/JS 两轮增量索引图与独立全量重建一致；`.87` 远端 Marketplace 包及新 Host MCP 握手已核验；真实候选在全局根下摘要匹配 | 缺新 Host 对 Knowledge 正文的直接工具读取；Memory/Experience 的项目数据根边界及其完整生命周期仍需验证 |

## 接续顺序

1. 校准能力与作用域的最终存储，保留已有数据、版本关系和跨能力证据引用；迁移前后逐项核验，不用目录投影冒充隔离完成。
2. 补齐真实任务完成证据的采集与留出评测资格。在旧数据无法核验时保留待验证状态，不能为推动模型调用而制造合格输入。
3. 分别完成 Knowledge、Experience 的项目和全局生命周期，以及 Memory 固定路径、阈值、冲突、归档和退出的真实验证。
4. 补齐五语言真实仓库、分支和变更评测，再执行完整闭环验收及远端版本更新。

只有完整矩阵中的要求均有直接、当前、范围匹配的证据，才能将整体目标标记为完成。
