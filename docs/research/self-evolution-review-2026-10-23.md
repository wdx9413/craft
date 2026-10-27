# Craft 自进化：当前改动审查与收口清单

> 2026-10-23 新存储约束优先于本文早先的路径描述：所有 Craft 持久产物只在 `~/.craft_data/`，项目数据在其 `projects/<规范化项目目录标识>/<能力>/`，会话数据在其 `sessions/<Host及会话ID>/<能力>/`。下文提到项目仓库内 `.craft_data` 或 `/tmp/.craft_data` 的既有实现和验证，只能视为待迁移旧行为，不能作为最终验收。

## 范围与判断口径

审查日期：2026-10-23。基线：main `02aa48bda05a6de71ab58215f56e7f1c1e555556`；对象为该基线后的工作区改动和未跟踪实现。最新复核快照包含 110 个已跟踪修改路径、14 个未跟踪文件，约 4,931 行新增和 734 行删除；这些数量只描述工作区规模，不是功能数量或完成率。

规范依据为仓库 `AGENTS.md` 及用户指令；需求依据为本线程完整目标，没有用局部修复替换目标。分别进行了规范/正确性审查和目标符合性审查；两轴各自保留结论，重叠问题不重复计为不同修复。复现使用隔离临时数据库，未把测试数据写入正式能力数据。

**整体目标尚未实现。当前新增修复尚未提交、发布或加载到用户 Host；本地通过不代表运行时已生效。** 本轮 `craft_info` 成功读回运行时版本 `.101`、数据根目录 `~/.craft_data`、内容语言 `zh-CN`。已有真实调用证据见 [`.101` 记录](knowledge-queue-retrieval-0.12.101-evidence-2026-10-22.md)。

## 一、规范与正确性审查

以下均违反“处理异常、数据一致性和并发”的要求，是可复现缺陷，不是代码风格建议。

| 编号 | 优先级 | 发现及影响 | 修复验收 |
|---|---|---|---|
| S1 | P1 | 分区先提交、中央指针后提交；中央锁超时或两阶段间进程退出后，同 ID 重试可能永久 `already exists` | 真实 SQLite 写锁；子进程在分区提交后强制退出；重启后同正文幂等恢复，异正文拒绝，不制造重复可见记录 |
| S2 | P1 | `remove` 先删分区正文；外层事务失败恢复中央头后成为悬空指针 | 外层及嵌套回滚后原正文仍可读；成功撤销可见性后才清理，不删除并发重新引用的版本 |
| S3 | P1 | `replacePayloadBatch` 含分区条目时逐条提交；后项失败，前项已经改变，调用方却报告回滚 | 跨能力批次失败全部保持旧值；暂存后进程退出也不半更新；中央备份能引用原有不可变正文 |
| S4 | P1 | Evidence 更新可去掉/改变 owner，从分区绕回 Core，破坏能力隔离；同一 owner 的分区 Evidence 更新也曾被中央头部缺少 owner 元数据而错误拒绝 | 已在锁内用已发布的分区指针校验旧范围，同时仍以新载荷校验能力 owner/目标范围；增加同 owner 更新成功及跨 owner 拒绝回归 |
| S5 | P1 | Memory 旧迁移备份仅有旧 `content_ref`；删除旧正文后，备份不能独立恢复；范围不匹配引用还可能把另一范围正文写进备份 | 本地实现已让备份包含经过同范围校验的原 Markdown 与摘要，并拒绝漂移/符号链接；迁移路径保留“备份后再退役”顺序；本轮集成相关回归及增量覆盖审计通过 |

主要实现位置：`common/craft-common-store-local/src/store.ts`、`content-store.ts`。S1—S5 均已有本地修复和直接相关回归；本轮集成套件执行了这些回归，改动代码纳入 100% 增量覆盖审计。不可见的暂存物理行清理需要另行验收，不能把逻辑原子性说成全部物理回收完成。

## 二、目标符合性审查

| 编号 | 优先级 | 对应目标与实际缺口 | 当前处理及验收 |
|---|---|---|---|
| Q1 | P1 | Memory 必须正确保留事实和约束；自动提取把“不要/避免”作为匹配前缀吞掉，会将“不要使用 Redis”存成“使用 Redis” | 已改为分类命中后保留完整原句。肯定、否定、条件、长度边界、普通任务拒绝及两个独立会话项目晋升保真已做本地回归；历史错误记忆不能无证据重建 |
| Q2 | P1 | “未验证……不得晋升为正式产物”；自动支持计数不能再单独晋升；机器判断也不能伪装成人工真值 | **本地部分收口**：`operator_asserted` 与初始模型标签均不具评测资格；新增二次 Host 判定记录，要求完成 Trace、输入/响应摘要和当前案例版本一致，只有 `accepted/corrected` 才进入影子评测。Trace 的 `actor/source/trust` 仍由调用端提供，尚无加密 Host 身份或签名凭证；这是可审计的机器判断，不是独立人工证明 |
| Q3 | P1 | 候选需由生成任务之外的真实留出证据评测；候选版本变化必须使旧评测失效 | **本地链路已补齐**：Worker 读取当前候选 Claim 与独立留出 Evidence，调用 Host 二次判定、落 Trace 后执行 `candidate_shadow`；版本/摘要不匹配会停止，`rejected/uncertain` 不建评测，`accepted/corrected` 才建评测。尚无新运行时里的真实 Host Trace 和候选评测读回，因此不能说端到端已生效 |
| Q4 | P1 | 稳定性与增量恢复要求；分区提交与指针发布之间退出后不能恢复 | 与 S1 同一缺陷。保留这一需求侧结论，不重复算作两个修复 |
| Q5 | P1 | Context 为长匹配内容截取任意窗口，可能丢掉否定词、前置条件或例外，改变原意 | 已改为只返回完整句子；句子超预算时返回空正文和精确来源范围，要求显式展开。Hook 二次压缩遇到未知来源偏移时也清空正文并保留展开标记；回归通过，改动分支覆盖纳入本轮 100% 增量审计 |
| Q6 | P1 | 默认 compact Context 响应仍返回 Knowledge/Experience 条目正文和逐条明细，调用方可能把整段内容直接注入模型，和最小材料目标冲突 | 已缩为贡献数量与状态摘要，保留统一的资产引用用于显式展开；MCP 参数透传验证正文不进入 compact 响应；改动分支覆盖纳入本轮 100% 增量审计 |

主要位置：`core/interfaces/codex-hook-bridge.ts`、`core/context-resolution.ts`、`core/context-response-projection.ts`、`common/craft-common-base/src/retrieval-excerpt.ts`、`core/knowledge-auto-review.ts`、`core/knowledge-evaluation-provenance.ts`、`deploy/experience-learning/session-knowledge-evaluation.ts`。没有发现可确认的无关扩展；分区、摘录、迁移都服务目标，但并非全部已经发布或通过端到端验收。

## 三、完整能力收口清单

以下复选框表示完整验收，而非“有代码”。没有当前充分证据的项保持未完成。

- [ ] **全量会话采集**：当前与归档来源均覆盖授权范围；报告总数、处理数、排除原因；原始会话不进入能力数据；同源复制和任务变体不能伪装独立来源。
- [ ] **任务证据整理**：真实任务绑定会话、任务、结果、验证产物、版本和摘要；模型总结只作线索；需要长期评测的脱敏证据不依赖临时目录。
- [ ] **独立评测集**：生成与留出按会话和来源隔离；标签具有独立有效依据；模拟单列；候选未正式发布也能在隔离的影子检索中评测。
- [ ] **Knowledge 闭环**：模型提出分类和组织；来源核验、独立效果、晋升分别留记录；项目专属内容不升全局；跨项目验证后才能全局化；修订、冲突、降级、撤销与退出可运行。
- [ ] **Memory 三级生命周期**：单次会话临时记忆、两个独立会话项目晋升、三个项目全局晋升；保留否定和条件；更正/退出传到索引及缓存；归档删除临时数据且保留合格长期来源。
- [ ] **Experience 生命周期**：模型识别粗细场景，无须用户手写唯一场景配置；独立任务形成项目流程；共同条件及独立评测支持全局化；新任务失败可隔离、退化、回退及退出。
- [ ] **增量运行与数据隔离**：能力/项目数据库及正文位置正确；范围缺失不落全局；短事务、版本/拥有者校验、崩溃恢复、分页游标和队列背压；空队列不调用模型、不制造产物。
- [ ] **使用反馈**：绑定实际使用的资产版本与真实结果；未使用不记有用；反馈驱动重验、晋升和退出，报告正确性、成本、延迟及不确定性。
- [ ] **Context 精确与有界**：跨能力统一材料和响应预算；保留必要事实、否定、条件与例外；可按需展开；必需材料放不下明确失败；Hook/MCP 与多轮累计不重复注入。
- [ ] **Context 任务协调**：代码任务按快照取 Codebase 上下文/影响；Coding Agent 独立执行变更与验证；完成后复核 diff/结果并更新索引；索引器不改源码。
- [ ] **Codebase 五语言**：TypeScript、JavaScript、Python、Java、Go 固定真实仓库评测；分语言报告关系完整度和限制；分支、提交、脏工作区及重索引隔离，不用局部通过代表全部。
- [ ] **性能与稳定性**：真实存量规模下冷/热启动、读写并发、P50/P95/P99、错误/超时、磁盘扫描、RSS/WAL 和模型总输入成本；后台化不能替代性能证明。
- [ ] **发布与真实验收**：增量覆盖 100%，相关构建/协议检查通过；普通推送 main 后从固定远端 URL 安装；新进程核对版本/哈希，真实任务贯穿 Trace、候选、独立评测、晋升或拒绝及退出；当前会话连接异常单独处理。

这些条目是用户完整目标的验收清单，不表示都从零缺实现。当前已有若干实现、测试及真实调用，但缺少同一发布版本贯通上述条目的证据，暂不提供完成百分比。

## 四、本轮已有验证与限制

- Memory 提取与治理：43 项相关测试通过，`codex-hook-bridge.ts` 整体语句、分支、函数、行覆盖率均为 100%；这是隔离测试，不是生产晋升证据。
- Knowledge 证据角色：31 项相关测试通过，`knowledge-auto-review.ts` 和 `knowledge-evaluation-provenance.ts` 整体语句、分支、函数、行覆盖率均为 100%。该结果不证明 Q2/Q3 已收口。
- 前一版集成套件：531 项中 530 项通过，1 项遇到 LSP `initialize` 超时；同一失败用例单独重跑通过。仓库上下文/LSP 相关文件再单独运行 76 项全部通过。这是本次 Knowledge 门禁改动前的历史验证。
- 前一版增量覆盖：以当前 main 基线对当时改动生产代码做差异审计，覆盖 1,371 行、1,183 个分支、59 个函数；当时审计到的改动行/分支/函数均已覆盖。这不代表本轮后续改动达到 100%。
- 正式数据只读预检：246 份旧 Knowledge Markdown 中，118 份非项目正文跳过，128 份项目正文仍被引用而全部保留；迁移预检另有 2248 个历史记录版本无法解析存储范围。预检未写入或删除正式数据。这不是迁移成功数量。
- 当前未发布上述修复。Q2/Q3、真实 Host 产出与独立评测、跨能力正式晋升/退出，以及生产规模性能和端到端验收仍未完成；单次集成 LSP 超时也需在稳定环境复核后才能视为消除。

### 本次自审更新

- 本轮相关回归 108/108 通过；`tsc --noEmit` 和 `git diff --check` 通过。c8 对四个相关生产模块采集覆盖后，以当前 main 基线审计本轮 169 条改动生产行；改动行、改动分支和改动函数均无未覆盖项。`craft-service.ts` 是大型门面类，此次定向 c8 全文件覆盖仍只有约 37% 行、约 81% 分支、约 7% 函数；这些全文件比例不等同于增量门禁，本次 100% 结论只针对已审计的四个模块改动部分。
- 新增的效果门禁已经防止 Host 来源审阅或支持计数单独晋升；候选影子评测只接受脱离生成任务的留出案例，并绑定 Claim 与案例的当前版本。
- 本轮又修正支持独立性：`observation_key` 只是调用方给出的去重标签，不再作为独立性的证明；晋升计数按活动可信 Knowledge Source 或核验会话来源去重，缺少可核验来源的 Evidence 不计入门槛。测试覆盖同会话换 key 及无来源 Evidence。
- 自审发现 `label_source: operator_asserted` 仍是调用方可写字段，当前没有独立的审定者身份、授权凭证或独立 Host 审定 Trace 来证明这个声明。它是实质性信任边界缺口；不能把字段名本身作为人工审定证据。本轮不伪造这个身份链，故“真实自动晋升”仍阻塞在该点。
- 本轮回归修正了一个旧断言：只有来源支持和两条支持记录的 Claim 现在必须因缺少独立效果评测保持 candidate；补齐了 `knowledge-context-compiler` 的项目根夹具。另增加了对损坏/过期/model_candidate 评测记录及虚构支持 key 的拒绝回归，并移除一个被 `uniqueTextArray` 完全遮蔽的重复空列表分支。支持来源收紧后的 108 项完整回归与四模块改动增量覆盖均通过；工作区依然未发布。
- 本次后续自审修正了 Knowledge Worker 的目标错位：原来只读已审核 Claim，且走普通 `retrieval`，因此不可能为当前候选生成晋升门禁要求的影子评测。Worker 现在只给同项目当前 candidate 做受控标签，案例 ID 绑定任务和候选精确版本；写入精确候选版本引用，并执行 `candidate_shadow`；候选版本不一致时在案例保存或评测阶段失败关闭。模型标签仍为 `model_candidate`，不提升资格。相关回归 34/34 通过，`tsc --noEmit` 与 `git diff --check` 通过；本次 Worker、MCP schema/catalog 及 Knowledge evaluation 方法的增量行与分支覆盖均为 100%（大型 `craft-service.ts` 仅核了本次涉及的方法区间）。这些是隔离本地证据，不代表 Host 自动晋升真实运行成功。

### Knowledge 留出标签二次审定增量（2026-10-23）

- 修复 `craft_knowledge_evaluation_case_adjudicate` 的契约错配：Worker 传入的 `input_digest`、`response_digest`、`decision`、`expected_claim_ids` 原先不在 MCP 工具 schema 中；现在 schema、服务端校验、Worker 调用一致，并由工具面测试确认参数已声明。
- Trace Kernel 只持久化事件摘要，不持久化 `data` 正文。服务端原实现误读不存在的 `event.data`，导致合法审定失败。现按 Trace 的 `data_digest` 验证请求、完成和结果记录，再将有限判定字段写入审定记录；接受/修正必须与当前候选引用匹配，修正必须实际改变标签，拒绝/不确定不进入效果评测。
- 新增 Worker 与来源判定模块的独立覆盖组；Worker 文件和来源判定模块均达到行、分支、函数 100%。Knowledge 评测、晋升、工具面及 Worker 相关测试最终 100 项通过；`tsc --noEmit` 通过。
- **仍未闭环**：Trace 的 `actor/source/trust` 由调用方提供，摘要校验只能证明字段一致，不能密码学证明 Host 身份；真实 Codex Host 运行及运行时版本读回尚未完成。前一次 Context 初始化超过 40 秒仍无响应；本次重新调用约 5 秒返回空包（0 条材料、估算注入 140 tokens）。这说明单次延迟恢复，但不是稳定性能证明；需在不同存量和并发下测分位数。

### 本轮独立复核补充（2026-10-23）

- 当前 `craft_info` 读回仍为运行时 `0.12.101`，数据根目录为 `~/.craft_data`，内容语言 `zh-CN`。全局已有 245 条 Knowledge Claim、500 条 Evidence、1 个评测案例和 2 次评测运行；当前仓库 Context 查询返回 0 条 Knowledge/Memory/Experience，来源发现也显示本项目范围 `sources_registered=0`、`sources_ingested=0`、`candidates_created=0`。这是“系统有历史数据”和“本项目当前能取到新产物”之间的差别，不能用全局计数代替项目产出证明。
- `.101` 的 Knowledge 工具面没有 `craft_knowledge_evaluation_case_adjudicate`，案例保存 schema 也没有精确候选版本引用；旧工具描述仍写着 Host 支持即可自动晋升。故当前本地改动与运行时契约不一致，真实 Worker 闭环尚不可验证，且旧运行时描述与本地新增的“独立效果评测后才晋升”规则相冲突。该发布/工具面阻塞保持 P1。
- **新增发现 S6（分页、公平轮转和失败退避已修复）：二次审定队列曾有队头阻塞。** Worker 现有稳定 ID 分页、持久游标和每案例指数退避；超过 1,000 条可继续翻页，失败案例不会永久占住队头。返回的积压数和最老年龄仅覆盖当前扫描页；全队列聚合指标仍待实现。
- **并发复核修正：** 初步审查怀疑审定前没有跨进程认领；进一步核实后发现 `worker.ts` 的正常入口由 `acquireLearningWorkerLocks` 按数据根目录和能力加锁，Supervisor 启动的子进程继承锁所有权，且已有并发启动测试。因此不把“常规 Worker 重复执行”记作已确认缺陷。`runLearningTick` 等函数级测试入口本身不持锁，未来若作为独立 Worker API 暴露，需重新加门禁。
- **新增发现 S7（P1）：真实“Host 身份”仍由调用参数自报。** 已知 Trace `actor/source/trust` 可由 Worker 调用方提供；当前完成/摘要校验证明的是数据关联一致，不证明请求来自获授权的 Host 或指定模型。要么将身份绑定到受控 CLI/Host transport 的不可伪造调用边界，要么把产物明确标作可审计的机器判断且在晋升门槛中加入独立信任来源；不得把 Trace 字段当认证。
- 本次 Context 运行读数为 0 条 Knowledge/Memory/Experience；Codebase 检索仍有 95 条预算遗漏、1,386 条查询遗漏，响应上限 1,200 tokens 下省略 3 项。材料估算约 825 tokens，完整响应估算约 1,139 tokens，均非 Host tokenizer 实测。还缺非空命中时正文上限、重复 Hook/MCP 注入、多轮累计和并发初始化的性能数据。
- 本轮补了 Knowledge 审定轮转游标及其独立测试/覆盖门禁：审定与游标测试 12/12 通过，两个文件行/分支/函数覆盖 100%；Worker 测试 50/50 通过，`worker.ts` 行/分支/函数覆盖 100%；直接 `tsc --noEmit` 与 `git diff --check` 通过。稳定分页现已覆盖超过 1,000 条案例；当时仍缺暂时性失败退避和队列指标（已在下方后续复核补齐单页能力）。工作区没有提交或发布，本地 package version 仍为 `0.12.101`。

证据文件为 `/private/tmp/craft-self-review-tests-final4.log`、`/private/tmp/craft-self-review-coverage-final4/coverage-final.json`、`/private/tmp/craft-memory-negation-tests.log`、`craft-memory-negation-coverage/coverage-final.json`、`craft-knowledge-review-role-tests.log`、`craft-knowledge-review-role-coverage/coverage-final.json`、`craft-storage-coverage-tests.log`、`craft-knowledge-content-retirement-preflight.json`、`craft-knowledge-migration-preflight.json`。临时日志用于当前核验，正式发布时需保留可追溯摘要及固定版本对应关系。

### 本轮复核：分页公平性、存储范围隔离与实际覆盖门禁（2026-10-23）

- Knowledge 独立审定队列现用稳定 ID keyset 分页：无 `after_id` 的旧调用保留旧列表形状；分页调用最多返回 1,000 条最新版本，按 ID 稳定排序并带 `has_more`/`next_cursor`。Worker 持久化跨页位置，空页推进游标，最终页后清除游标；非法、缺失或重复游标失败关闭。1,005 条案例跨两页无重复。相关评测、Store、游标、Worker、MCP 工具和剩余分支回归 133/133 通过。
- 自审发现历史 Knowledge 字符串 scope（如 `"other"`）可能被误当成有效分区。当前实现明确拒绝无效 scope，并有 Store 回归；合法项目 scope 必须使用明确的 `project:<id>` 形式。另发现 Trace 归档测试夹具先写入缺少当前事件的损坏归档；现改为归档真实子记录，保留生产端完整性校验。
- Store 覆盖组原先漏挂 Knowledge 分区迁移、分区原子性和 Experience 定义迁移测试。补齐测试清单后，Store 覆盖组 230 项测试通过，`store.ts` 行、分支、函数覆盖均为 100%。`tsc --noEmit`、覆盖组 JSON 解析和 `git diff --check` 通过。
- 当前运行时仍为 `.101`。`craft_info` 读回全局 245 个 Knowledge Claim、500 个 Evidence、1 个评测案例、2 次评测运行；当前仓库 Context 回执没有 Knowledge/Memory/Experience 材料，项目来源发现是 0 registered/ingested/candidates。因此本轮证据只证明本地实现和隔离测试，不证明真实 Host 调用、项目产出、独立效果提升或晋升闭环。
- 本轮再补了 Knowledge 审定失败的按案例指数退避（30 秒起步，封顶 1 小时），成功后清理重试状态；Worker 返回当前页待处理/可重试/退避数量、最老任务年龄和最近重试时间。相关 102 项测试通过，审定逻辑与状态模块各自行/分支/函数覆盖 100%，`tsc --noEmit` 通过。当前只统计单页，不会被误报为全队列积压指标。
- 清单更新：>1,000 条审定分页、失败退避、单页队列摘要、非法 Knowledge scope 拒绝和 Store 覆盖组 100% 已覆盖；全队列聚合积压/最老年龄指标仍缺。主要未完成项仍包括完整会话证据整理及独立留出集、可信 Host 身份绑定、Memory/Experience 生命周期实跑、Context/Codebase 性能分位数、五语言真实仓库评测，以及经审查版本发布并由新 Host 贯穿真实端到端核验。

### 最后一次自审：定向门禁和清单状态

- 为修正测试模拟中每次重试都改源码的问题，改为只在首次打开时改变一次，验证快照重试能稳定完成；同时为 Service/Knowledge 项目测试显式注册项目根。故意制造同一项目的双根别名会触发安全拒绝，保留该拒绝语义，不作为可绕过的兼容场景。
- 自审发现并修复了分区 Evidence 同 owner 更新被错误拒绝的问题；现在锁内通过已发布指针核对旧 owner，仍拒绝更新到另一能力或存储范围。存储并发/所有权、Evidence 证据入口与 Knowledge 审定相关回归共 39/39 通过；审定 Worker 13/13 通过，Node 原生行/分支/函数覆盖均为 100%；`tsc --noEmit`、`git diff --check` 和覆盖清单 JSON 解析通过。
- Context remediation 组上一次执行 438/438 测试通过，但 Node 原生覆盖仍为分支 99.82%、函数 99.76%（`repository-onboarding.ts` 分支 99.41%，`claim-governance.ts` 函数 96.67%、分支 99.56%）。新增了缺失的 Claim Governance 门面调用测试；本次 S4 修复后尚未重跑这 11 分钟覆盖组，故总组门禁仍未关闭。`pnpm test:coverage-gates` 受网络镜像及非交互安装阻断，改用 Node 直接执行，不能将单组结果当作总门禁通过。
- 以上仍是本地隔离证据。运行时仍读回 `.101`；未有发布候选、新进程版本/哈希读回、真实 Host 新产物或独立效果改善证据。完整清单中所有未勾选项继续未完成。

### 本次复审：按阻断顺序执行的清单

当前工作区仍是 main `02aa48b` 上的 118 个已跟踪修改路径和 14 个未跟踪文件；安装的 MCP 仍为 `0.12.101`，数据根为 `~/.craft_data`，语言为 `zh-CN`。本项目新开的 Context 回执 Knowledge/Memory/Experience 均为空；Codebase 为 partial（96 条预算遗漏、1,821 条查询遗漏，响应预算省略 4 项）。全局 245 条 Claim 和 500 条 Evidence 不能证明本项目已生成可用产物。此次复审未提交或发布。

| 顺序 | 状态 | 必须完成的事项 | 可核验的完成条件 |
|---|---|---|---|
| 1 | 本地已修，未发布 | Experience 候选池先按查询相关性和必需引用排序，再截取 8～24 项 | 26 个同项目流程中，ID 最后的精确匹配流程进入 24 项候选池；9/9 测试通过，`contribution.ts` 行/分支/函数 100%；发布后用真实存量再测 |
| 2 | 本地修复，跨进程未验收 | Memory 自动晋升绑定支持观察/项目记忆的精确版本；撤销、替换和过期按依赖退出，旧观察停用，读取与文件投影二次核验 | 已有三项目→撤销一项目→全局退出、会话撤销→项目退出、两次新观察再晋升、旧版无引用记录回退核验；外部仅使观察失效时逐层阻止项目及全局读取/晋升。相关组 116/116 通过，五个 Memory 模块新增可执行行、分支、函数 100% 覆盖；尚需跨进程竞争、投影写失败恢复和运行时验证 |
| 3 | 本地修复，运行时未验收 | Experience 子记录缺失父记录且无明确 scope 时失败关闭 | 项目来源丢失父项不能落进 `~/.craft_data/experience` 全局库；显式全局和有效父项仍可写；子项与父项范围冲突被拒；旧孤儿记录迁移后可读。相关 Store/Procedure 组 121/121，场景评测组 15/15，通过；还需正式存量迁移预检及运行时验证 |
| 4 | P1 未完成 | 可信 Host 审定边界 | 公开 Trace 自报的 `actor/source/trust` 不再单独满足晋升资格；受控传输或独立可信审定可核验；伪造字段回归被拒绝 |
| 5 | 门禁未完成 | 当前 Context 覆盖组及增量门禁 | 上次 Context 组 438/438 测试通过但分支 99.82%、函数 99.76%；新增门面测试后需重跑并补齐真实未覆盖分支，再执行本轮差异覆盖审计 |
| 6 | 端到端未完成 | 固定发布候选并经 main、远端 URL 更新 Host | 定向构建/协议/门禁通过；推送 main、Marketplace main；新进程读回版本和包哈希；真实任务产生 Trace、候选、独立评测、晋升/拒绝和使用反馈 |
| 7 | 效果未完成 | 会话证据和留出评测集、Memory/Experience 真实生命周期、五语言 Codebase、并发/性能 | 分别给出来源分母、隔离依据、实际结果、P50/P95/P99、启动与模型成本；局部测试或全局计数不替代结果证据 |

两轴审查分别发现：规范/正确性方面，Experience 缺父记录落全局和 Host 身份自报均触及可信边界；目标符合性方面，Memory 三级晋升缺退出传播、Experience 候选池漏召回。第 1～3 项已有本地补丁，但仍缺正式数据及运行时验收；第 4 项仍需处理可信身份边界。

Memory 退出实现补充：项目晋升记录现在绑定两个独立会话观察的 ID/版本，全局晋升绑定至少三个独立项目记忆的 ID/版本；重复来源、错范围、过期、损坏或旧版本支持均拒绝。Ledger 的撤销在一个存储事务中使依赖的观察和派生记忆退出，随后重建受影响范围的 `memory.md`。同一撤销重放会再次收敛派生状态；读取、Context 贡献和投影也对仍标 `active` 的失格自动晋升项失败关闭。旧版未保存精确引用的自动晋升项通过原候选身份和活动独立来源重新核验。此项仍需证明投影重建失败后的自动修复、跨进程同时采集/撤销的线性化，以及正式数据中的旧记录迁移效果；不能把本地测试当作完整 Memory 验收。

本次增量复核：全局记忆会继续核验其项目支持项背后的观察，避免项目项表面仍为 `active` 时漏出；候选生成也排除这种失格项目项。项目晋升同时核验观察的实际存储范围和 `project_id`；明确引用的空会话身份、缺失项目身份或伪造范围均失败关闭，旧版记录会忽略不属于本项目的无效额外观察。`memory-tiers` 5/5、相关覆盖组 116/116、`tsc --noEmit`、`git diff --check` 均通过。按 main `02aa48b` 的差异统计，五个 Memory 生产模块合计 271 条改动可执行行、325 个改动分支、15 个改动函数，均无未覆盖项。覆盖 JSON 位于 `/private/tmp/craft-memory-exit-coverage-final5/coverage-final.json`，测试日志位于 `/private/tmp/craft-memory-exit-tests-final5.log`。这份覆盖结果只约束这五个模块的本次改动；未执行真实多进程负载或发布后的 Host 调用。

Experience 范围修复：新写入子记录缺父项且无可确定范围时失败关闭；有效父项决定项目范围，显式全局写入仍可用，声明范围与父项冲突时拒绝。发布事务内重新核验父项，避免先读到父项、随后被删除时写出子项。旧版孤儿记录在迁移中保留历史全局读取。相关 Store/Procedure 组 121/121、场景评测 15/15 通过；`store.ts` 本次涉及区间的 53 条可执行行、69 个分支均覆盖，覆盖文件为 `/private/tmp/craft-experience-scope-coverage-final/coverage-final.json`。场景评测夹具也修正了重复的 `project:` 前缀和试图跨范围改写 Procedure 的无效模拟。尚未证明正式数据迁移或发布后行为；更大的混合回归曾有 Knowledge/Memory 项目根夹具失败，不能将本段定向结果扩展为整仓通过。

### 当前复审：Knowledge 审定信任边界

- 复核 `craft_knowledge_evaluation_case_adjudicate` 的公开调用链后确认：接口校验 Trace 状态、事件摘要、版本和 `actor/source/trust` 字段，但这些字段都可由同一个 MCP 调用方通过公开 Trace 接口写入。现有测试辅助函数正是这样构造“合格”Trace 并得到 `host_adjudicated` 案例；因此测试名中的“rejects forged traces”只覆盖字段不匹配，不能证明 Host 身份。当前不应把该标签或由它产生的影子评测当成已认证的模型效果证据。
- 发布前阻断条件：将二次审定请求缩为案例 ID，由受控执行端重读当前案例、Claim、独立 Evidence，构造有界脱敏输入并运行 Codex CLI；执行端自己保存进程完成回执、输入/响应摘要、模型与案例版本，再由该回执原子发布审定。公开 Trace 字段不能单独取得晋升资格。拒绝伪造 Trace、旧案例/Claim 版本、替换响应和跨来源 Evidence 的回归必须通过；空队列保持零模型调用，失败可退避重试。
- 本次定向复核执行 `knowledge-evaluation`、`session-knowledge-adjudication`、`memory-tiers`、`scenario-evaluation` 四组，共 39/39 通过。这仅说明当前测试预期成立，其中正向审定测试也暴露了上述信任缺口；它不构成可信 Host 调用或真实晋升证明。当前仍未改动该接口实现，也未发布。
- 当前 `craft_info` 再次读回安装版本 `0.12.101`、数据根 `~/.craft_data`、内容语言 `zh-CN`；Knowledge Claim 245、评测案例 1、评测运行 2，Experience Pattern 0、Memory 使用信号 0、通用反馈 0。全局计数不能证明本项目已有有效产物，也没有显示本轮工作区改动已进入运行时。`git diff --check` 通过；清单文档仍为未跟踪文件，发布前须与对应代码一起审查纳入。

### 后续实施：服务端持有 Host 调用边界

- MCP 审定接口现在只收当前案例 ID 和版本；服务端重读当前 Claim、留出 Evidence 和 Codex Profile，脱敏后调用受限 `gpt-6-luna` 传输，自行写入 Trace 和审定。公开 Trace 自报不能直接调用内部落库函数；旧版没有 `execution_origin=managed_codex_cli` 的审定不再取得评测资格。按案例跨进程锁阻止并发重复调用；Worker 只提交案例身份，失败仍按案例退避。
- Worker→真实 MCP handler→Store 的隔离集成测试通过：一例生成审定及影子评测，下一轮空闲且模型调用不增加。联调揭出并修复两处旧阻断：语义包不含 `identity_digest`，Worker 原先误判版本；`craft_evidence_get` 返回裸记录，Worker 原先只接收包装形式。新增服务端错误响应、伪造入参、版本漂移、独立 Evidence、负面决定和并发测试。
- 沙箱内真实 Codex CLI 因操作系统 `Operation not permitted` 无法初始化；同一合成输入在获授权的沙箱外探测完成。随后以隔离临时 Craft 数据运行真实服务端审定，Profile 为 `ready_for_adapter`，实际调用 `gpt-6-luna` 一次，得到 `uncertain`；记录有 `managed_codex_cli` 来源及完成 Trace，案例保持 `model_candidate`。这是**真实 CLI 传输和拒绝路径的本地证明**，合成任务不证明真实项目效果或晋升。临时数据已清理。
- 当时尚缺模型返回后、审定落库前退出的恢复路径；下节记录了本轮补充。总覆盖门禁、固定发布候选和新 Host 真实任务验收仍未完成；运行时仍为 `.101`。

### 本轮复审清单与执行记录（以本节状态为准）

| 顺序 | 事项 | 本轮核验/处理 | 剩余验收 |
|---|---|---|---|
| 1 | 可信审定入口 | MCP 只收案例 ID/版本；Host 调用、Trace 和结果由服务端持有。同源拒绝回归为零模型调用；脱敏结果先写入项目 Knowledge 分区，重新打开 Store 后可恢复 Trace 和案例而不再次调用模型 | 模型返回到恢复记录落盘之间仍有不可判定窗口；Codex CLI 未提供可复用调用回执，不能宣称严格一次调用 |
| 2 | 独立评测 | 服务端先核验 Claim 来源与留出 Evidence 独立；`uncertain/rejected` 不进入影子评测。Worker→MCP→Store 的隔离闭环与下一轮空闲行为已测 | 真实任务建立生成/留出来源分母、可信标签和可复查评测集；测量误检与收益，不能用合成用例代替 |
| 3 | 增量门禁 | 本轮审定相关 33/33 测试通过；Worker 模块原生行/分支/函数覆盖均为 100%；服务端托管审定及恢复方法第 3080～3225 行经 c8 审计无未覆盖语句、分支、函数；TypeScript 检查和 `git diff --check` 通过 | 总工作区差异覆盖门禁、发布包和完整协议检查尚未完成 |
| 4 | 已安装运行时 | `craft_info` 为 `0.12.101`、`~/.craft_data`、`zh-CN`；本项目 Context 回执无 Knowledge/Memory/Experience 命中 | 固定发布候选、普通推送 main、远端 URL 更新后，在新进程读回版本/哈希并做真实任务验收 |
| 5 | Memory/Experience 与 Context | 局部实现及测试见前文，不能外推为真实晋升效果 | 跨进程竞争、投影故障恢复、真实使用反馈、场景退出及 Context 性能/成本分位数仍需测 |

当前结论：代码层的受控 Host 调用链比上一轮更完整，但还不能称三个子能力已端到端自进化。一次真实 CLI 合成调用得出 `uncertain`，证明拒绝路径和记录链路；正式运行时和真实任务效果仍未证明。优先关闭第 1、3、4 项，再扩充独立评测与使用反馈。此表不把测试替身、隔离合成输入或安装目录中的旧版本记作线上成功。

发布前基础检查补充：`tsc -p tsconfig.build.json` 通过；MCP 包装与 Worker 锁测试 33/33 通过；分层审计 465 个模块无违规，Surface 审计及文档链接检查通过，协议一致性校验捕获 9/9 个故意扰动。这些仍不代替未完成的总差异覆盖门禁、打包安装及新 Host 的真实运行验收。

恢复路径补充：四个故障点（模型完成事件、审定候选事件、Trace 完结、案例入库）均在持久结果落盘后注入失败，重新打开 Store 后恢复，模型调用数保持 1；损坏的结果绑定、Trace 任务/状态、缺失请求事件和异常事件列表均失败关闭。项目 Knowledge 数据库读到恢复记录 1 条，全局 Knowledge 数据库为 0。隔离定向组 33/33 通过；未在真实 CLI 进程强制退出场景验证，也未发布到已安装 `.101`。

补充真实 Host 冒烟：隔离临时数据上再次执行 `gpt-6-luna` 一次，Profile 为 `ready_for_adapter`，结果为 `uncertain`，案例仍是 `model_candidate`；完成 Trace 包含请求、完成、审定候选和完结四类事件。这验证新增恢复记录代码路径没有阻断真实调用，但不证明真实项目评测效果。临时数据已清理。

### 发布基线及历史数据复核

- 当前本地及 `origin/main` 的 HEAD 均为 `deb9040`，比本审查初始的 `02aa48b` 多一个独立 datasec 发布提交；自进化代码仍在未提交工作区。后续覆盖与发布应以 `deb9040` 为基线，保留该提交。
- 对正式中央 SQLite 只读统计：尚无 Knowledge 分区指针的历史版本中，有 Claim 5,343 条、自动评审 5,092 条、入库回执 11,243 条。Claim 版本按原始 `scope` 分为项目 5,160、`legacy:` 159、全局 24。数字是历史记录版本数，不等于当前有效产物数；直接批量迁移会触及大量旧数据，必须先逐页 dry-run 并核对项目根绑定和备份。
- 对上述 5,160 个项目 Claim 版本按当前 `scope_alias` 与磁盘目录做只读预检：34 个项目范围中，14 个解析到唯一根、18 个缺根、2 个有多个根；缺根与歧义分别涉及 100 和 3 个版本。该统计只覆盖 Claim，不替代其他 Knowledge 类型的逐页迁移预检；不能从项目 ID 猜目录或将失败记录降为全局。
- 总覆盖门禁首次运行的 `knowledge-session-adjudication` 组只选了 14 项旧 Worker 测试，分支覆盖为 99.38%。清单已合并新的 MCP 集成测试并删除重复组；该组合的定向门禁为行、分支、函数各 100%。首次全门禁仍在运行，不能据此宣称总门禁通过。

### 当前门禁复审与未完成项

- 首轮总门禁已在 54/149 组后停止，避免在已知失败上继续长时间运行；该轮 12 组失败是修复前快照。`common-base-package`、`common-store-local-package`、`retrieval-terms`、`capability-assets`、`activation-proof-and-runtime-acceptance`、`internal-host-driver` 已按当前工作区重跑，全部测试及各自原生行/分支/函数 100% 门禁通过。`scope-identity` 97/97、`craft-codebase` 205/205、`universal-runtime` 所余旧夹具的定向文件 7/7 也已通过；后两组的原生覆盖门禁仍需重跑，不把定向通过当成门禁通过。
- `control-plane` 用 V8 原始覆盖数据定位到 `context-working-set.ts` 中“必需 Codebase 引用在预算重平衡后仍保留”的匿名规约函数。新增真实预算冲突用例后，82/82 测试及该组全部模块原生行/分支/函数 100% 门禁通过。`tsc -p tsconfig.build.json --noEmit` 和 `git diff --check` 通过。
- `context-remediation` 447/447 通过，但原生分支门禁仍低于 100%。完整组的 c8 明细剩 7 个未覆盖分支：`repository-onboarding.ts` 第 202 行 2 个、第 208/463/469 行各 1 个，`claim-governance.ts` 第 158 行 1 个；另一个第 202 行计数共 2 个，总计 Codebase 6、Knowledge 1。需要补充真实快照复用/竞争和历史范围拒绝用例，或确认不可达分支后做最小重构。不得降低现有门禁阈值。
- 已修复多个旧测试夹具的项目根绑定，未修改生产隔离规则。正式数据的项目根缺失/歧义、总差异覆盖门禁、发布包、新 Host 加载和真实独立评测仍未通过；当前工作区不能作为已发布效果。
- 本轮末复核时，`main` 与 `origin/main` 已由外部工作推进到 `8c42575`（其间新增 Context Hook 清单与有界输出预算两次提交）；本文开头的 `deb9040` 是审查启动时基线。正式发布前必须重新核对该新基线、工作区差异与覆盖门禁，不能沿用旧提交号。

### 新统一存储约束的发布阻断项

当前 `dataRoot()` 默认是 `~/.craft_data`，但项目和会话分区仍绕过它：`CraftStore` 的项目 Knowledge/Memory/Experience 数据库及正文使用仓库内 `.craft_data`；Memory 会话数据库和 Markdown 使用 `/tmp/.craft_data`；Codebase 快照、分析缓存、图记录及 Go LSP 缓存也直接拼接仓库路径。非文档、非测试代码中至少 38 个文件包含相关路径表达式，不能只改一处配置完成切换。

统一迁移需先建立项目根真实路径到 `末级目录名+SHA-256` 标识的稳定映射、Host/会话 ID 安全目录映射和只读兼容层；之后逐能力逐页预检、备份、幂等复制及崩溃恢复，最后切换写入并验证旧目录不再增长。历史项目根缺失或歧义的记录保持隔离待处理，不能猜目录或回落全局。该变更尚未实现或在正式 30G 数据根上执行，属于当前发布的硬阻断项。

### 统一目录本地实现进展（2026-10-23）

- 项目根按真实绝对路径计算完整 SHA-256，目录为 `projects/<可读名--哈希>/`，同名不同根隔离，符号链接归一，并持久化 `project.json` 映射。Knowledge、Memory、Experience 的项目分区及 Markdown，Codebase 快照、分析缓存和图记录、Knowledge/Experience 场景目录，以及 Codebase 评测输入和报告已切换到该目录。旧项目正文仅按原引用路径受控读取。
- 会话 Memory 的新数据库、正文和 Markdown 投影改写到 `sessions/<Host--会话哈希>/memory/`。Hook 明确绑定 Codex 或 Claude；无 Hook 的直接 MCP 写入以 `craft-mcp` 为来源并保留 Host 观察记录，另一 Host 不得复用同一绑定。归档只删除 `memory/`，保留同会话其他能力目录。旧 `/tmp/.craft_data` 会话内容仍待逐页迁移和回收。
- 存量指针读取新增严格白名单：仅接受当前项目/会话的统一目录，或对应项目根、会话 ID 的旧分区数据库；旧分区只读，新写入走统一目录。隔离夹具验证旧项目 Memory 指针重启后仍可读，随后新 Memory 进入新库。该兼容层不代表旧库已经备份、迁移或退休。
- 相关路径、Knowledge、Experience、Codebase 评测存储和 Memory 投影定向模块的行、分支、函数覆盖率达到 100%；扩大存储集成曾通过 171/171 和 157/157，随后新增旧指针回归 41/41。`tsc --noEmit` 通过。上述数字来自不同改动快照，最终门禁与增量差异覆盖仍需重跑。
- 正式数据只读观察：仓库内旧 `.craft_data` 约 3.8 GB、约 101,106 个文件；中央库当前 50 个活动项目路径别名（摘要均有效），按存在的真实目录分组是 36 个范围：29 个唯一根、4 个缺根、3 个多根。这一分组口径不同于上文只针对历史 Claim 的 34/14/18/2，不可相加。约 432 个 Codebase checkpoint 版本和 5,353 个 Knowledge Claim 版本仍需核验引用及来源；所有正式数据尚未执行迁移。
- 本地工作区改动尚未提交、推送、经远端 URL 安装或由新 Host 读回。完整数据门、工程门、运行门和效果门均未通过；尤其需要正式数据迁移、旧指针撤销/更新的一致性回归、剩余覆盖与并发门禁、真实独立评测和效果反馈。

### 物理分区迁移补充（2026-10-24）

- 正式库只读逐页盘点：91 条物理分区指针中，87 条已指向统一目录，4 条仍指向本项目旧 `.craft_data/memory/memory.db`，它们是同一个候选的 3 个版本和一条 Memory Ledger。该盘点只覆盖已带物理指针的能力记录；5,353 个未分区 Knowledge Claim 版本和 433 个 Codebase checkpoint 版本是单独的迁移分母。
- 盘点查询限定候选能力类型后，同一正式库单页耗时约 4.3 秒；先前全表 JSON 扫描约一分钟。此为一次本机样本，尚无 P50/P95/P99 或并发测量。`storage-migration-apply.ts` 默认仅只读报告，`--apply` 才会处理已确认的旧指针；遇缺根、歧义、越界等状态先停止。
- 旧项目 Memory Markdown 在 `/var` 与 `/private/var` 路径别名下可经范围、常规文件与正文摘要验证后读取。旧分区原地修订和删除现在失败关闭，避免错删新分区。新增的迁移方法先用 SQLite 在线备份中央库、旧分区和目标分区并做完整性检查，再幂等复制、迁移正文并以旧指针内容作 CAS 切换；隔离夹具验证备份、迁移、重试和后续删除。
- **正式 4 条旧指针尚未执行 `--apply`**；旧 Host 是否仍会写旧路径未完成停写检查。旧项目目录约 3.8 GB 的其余索引、快照、缓存及未分区历史记录还需逐能力盘点和迁移。新增迁移方法的故障注入、最终增量覆盖率、完整发布及真实效果门也未完成。
- Codebase 检查点只读细分：433 个版本中，73 个 `snapshot_root` 指向项目内旧 `.craft_data/codebase/`，360 个指向全局旧 `~/.craft_data/runtime/workspaces/`，0 个指向新的 `projects/<项目身份>/codebase/`。新建 Workspace 及旧 Workspace 的后续检查点现统一写到项目 Codebase 目录，但历史快照和检查点引用尚未复制、校验或切换，不能称 Codebase 迁移完成。
- Knowledge 后台分类此前从 `content_ref.path` 反推项目根时只识别项目内旧 `.craft_data`，新统一目录下会跳过项目候选。现在通过项目 `project.json` 映射并复核真实路径哈希识别，旧路径保留受控兼容；临时项目根 `/var` 与 `/private/var` 归一后继续跳过自动后台分类。相关 Worker 35/35 定向测试通过。
- Codebase 检查点逐页预检进一步区分：384 个有唯一且仍存在的项目根、旧来源路径与记录吻合，可进入摘要校验迁移；49 个缺根，均来自已删除的 `/private/tmp` 测试目录，不能自动重绑或回落全局。新迁移器对中央 SQLite 做在线备份，对每个快照核对文件清单、大小和 SHA-256，再以 CAS 切换历史检查点的 `snapshot_root`；隔离夹具验证成功复制、内容篡改拒绝和未列文件拒绝。正式 384 个尚未完成批量迁移。
- 正式单检查点试迁移：先在线备份并完整性检查中央 SQLite，复制并校验 913 个快照文件（目标目录约 13 MB）；第一次中央指针 CAS 遇到 `database is locked`，旧指针保持不变。复用同一备份重试后，迁移 1/1，读回状态为 `current`。这证明该失败点可恢复，但不能推断批量迁移无锁争用；剩余 383 个可迁移检查点和 49 个缺根检查点仍未处理。

### 2026-10-24 迁移读回更新

- Codebase 正式 433 个检查点版本：384 个 `current`，49 个 `missing_root`，0 个仍可迁移的旧路径。384 个对应仍存在且唯一的项目根；逐文件清单、大小、SHA-256 校验后，以中央记录 CAS 切换。12 个旧快照各有 19 个文件与清单大小不符，恢复时仅取同项目、同状态版本且摘要匹配的快照文件，或本地 Git 历史中同路径、摘要匹配的对象；恢复来源逐文件记录。旧快照未删除。49 个缺根版本均指向已删除的临时项目，按项目身份规则不能自动重绑。
- Codebase 迁移遇到过 `database is locked`，复用同一份经过 `quick_check` 的中央库备份重试，最终 384 个可定位版本均读回 `current`。两份备份位于 `~/.craft_data/backups/codebase-storage-migration/`。这仅证明指针迁移和快照校验，不证明旧项目内 3.8 GB 代码索引、旧独立 SQLite、运行缓存已完成迁移。
- Memory 物理分区指针迁移 6 条旧版本，包含 4 条 `memory_candidate` 与 2 条 `memory_ledger`；源/目标 SQLite 和中央头记录备份后切换。最新只读预检为 97 条 `current`、0 条 `legacy_ready`。旧 Host 停写检查与其他旧格式数据迁移仍待完成。
- 本轮隔离 Codebase 恢复测试 3/3，TypeScript `tsc --noEmit` 通过。增量覆盖率 100% 门禁、main 发布、新 Host 版本读回与真实效果门均未通过。正式数据卷仅余约 15 GiB，继续做整库备份前需先核算空间与释放可证明可删的冗余副本。
- Knowledge 旧记录以 500 条为上限分批迁移，首次正式运行检查 23,738 条版本，其中 19,153 条切换成功，2,427 条因项目范围不可用而隔离，1,916 条分区写入失败，242 条不属于 Knowledge 分区。幂等重试又切换 107 条。9 个未分区摄取回执来源均能找到原来源记录，但各自对应的项目根为 0 或 2 个；其中 2,069 条回执不能自动归属。失败分类已区分写锁、旧正文路径越界、内容/范围校验，仍需分组处理；不能把所有剩余项视为同一种故障。旧 Markdown 正文仍有 128 份被引用，本轮未清理。
- 再次重试清除了短暂写锁，迁移器新增确定性失败的组内二分隔离，避免一条越界正文阻断同组正常记录；隔离回归通过。新增切换 93 + 1,466 条。当前只读总量：Knowledge 分区指针 20,819、未分区相关记录 2,929（含 242 条本来不归 Knowledge 的记录）、Memory 指针 97、Experience 指针 52。Knowledge 剩余约 2,437 条范围不可用，163 条内容范围校验失败，87 条正文路径越界；这些是本轮逐页结果，正式库同时有活动写入，数量会漂移。不能自动把缺根项目归全局。正常 Store 初始化一次因 `database is locked` 在 15.6 秒失败，下一次成功用时 843 ms（Memory 11 ms、Experience 81 ms、索引重建 748 ms），须把锁争用作为启动稳定性问题继续处理。
- 启动采样须与真实 Host 使用相同 Node 版本：系统默认 Node 23 在同进程反复开关实验性 SQLite 时退出码 139，不能据此判断 Node 24 Host。以 Host 使用的 Node 24.14.0 每次独立进程采样 10 次正式 Store 初始化，成功 10/10，P50 153 ms、P95 与样本最大值 225 ms、最大 RSS 154 MiB；样本量不足以证明真实 P99 或锁争用消失。20 秒初始化失败仍是单独的异常路径。
- Codebase 恢复器现于中央指针 CAS 前，将逐文件恢复来源写入迁移备份内的不可变回执；隔离测试验证回执内容。此前正式迁移的 12 个损坏快照发生在回执功能之前，补做了标记为 `posthoc_digest_recheck_only` 的审计：228 个曾损坏文件在新快照中逐个与原清单大小和 SHA-256 一致。审计文件位于原 Codebase 备份目录，不声称记录了当时实际选用的每个复制来源。
- 发布候选构建阶段：TypeScript 构建、七个独立公共/能力包、六个 MCP/Hook/Worker 运行包及插件打包均通过；版本清单、插件包、版本、接口、文档与一致性检查通过。层级检查起初指出 Store 向上依赖 common-base 的字符串摘要函数，已用字节等价的字符串专用 SHA-256 消除依赖，复测 0 违规。插件启动 smoke 通过；组件 smoke 更新了旧断言：Context 的正式响应有意不发送完整 Codebase 摘要，改从隔离 Store 校验真实仓库索引范围；后台 Worker 的首个真实调用为存储协调，后续学习按阶段调度。最终组件 smoke 通过。以上仍是本地包验证，未发布或进入 Host。
- 当前覆盖清单仍为 `incomplete`：456 个生产文件中 246 个纳管、210 个未纳管，其中 15 个是新增缺口；三个新存储预检/迁移模块的定向覆盖合计约 90% 行、70% 分支。增量 100% 门禁未通过，不能据此推送 main 或声明工程门完成。
- 最后一次源码变更后重新生成七个独立包、六个运行包并重新打包，完整 Context 组件 smoke 在该重新打包版本上通过。源运行包与插件复制品的摘要一致；但包仍标识 `0.12.104`，尚未形成新版本提交、推送 main、按固定远端 URL 安装，亦无新 Host 的版本/哈希读回。

### 2026-10-24 覆盖门禁与恢复校验增量

- Codebase 迁移与预检补齐检查点 ID/版本的安全校验，避免记录身份进入目标路径或恢复回执文件名时产生越界。会话物理指针预检现在将错误 Host、会话 ID 不匹配或非法绑定标记为 `unbound_session`，不生成目标路径。
- 续跑迁移先对已有备份再次执行 `quick_check`，再逐条核对备份中的原始检查点载荷和时间戳与当前版本完全一致。仅有同 ID/版本不足以复用备份；记录漂移拒绝续跑。复制完成而中央指针尚未更新的正常重试仍可通过。
- 新增故障注入验证：SQLite 触发器分别模拟相同并发赢家和冲突更新；文件发布模拟同内容竞争、I/O 失败和非 Error 异常；另验证 FIFO、跨平台路径分隔符、符号链接、错误 Git 副本、恢复回执冲突、备份完整性失败与缺失 Git。三个新存储模块原生 Node 覆盖门禁为行/函数/分支均 100%，15/15 测试通过，Node 23 与 Host 使用的 Node 24 均通过，已登记 `capability-storage-migration` 门禁组。
- Codex 任务验证、目标脱敏摘要与 Knowledge 会话 Evidence 三个模块亦达到原生 Node 行/函数/分支 100%，56/56 相关测试通过，登记 `codex-task-evidence-verification` 门禁组。修正两处仍读取旧项目内 Knowledge 路径的测试断言；审定恢复测试继续证明重开 Store 后不重复模型调用。
- 相关诊断、场景与记忆检索测试 42/42 通过。修正旧场景目录断言及关系夹具：新关系要求可追溯的来源对象，来源退出后不再检索关系。未降低缺根/缺来源写入门槛。
- 覆盖分母修正：原覆盖清单的 15 个 `new_missing` 是相对于较旧清单基线，不等于本目标新增文件。6 个已完成纳管；剩余 9 个中仅 `cognitive-search.ts` 有本轮差异，其余 8 个在 HEAD 已存在且本轮未改。该协调器的本轮 Memory 预算/摘录差异已有测试覆盖，但其既存诊断功能的整模块覆盖不足，不能据清单缺口数量推算整个发布差异覆盖率。本轮未重新构建、发布或更新 Host，整体工程门与真实效果门仍未完成。
- 对 61 个改动源码文件选取相交的 39 个门禁组，在源码/测试快照不变时运行，耗时 926 秒，18 组通过、21 组未通过。原始 V8 覆盖与分组日志暂存 `/tmp/craft-affected-gates/`。失败包含重复的旧路径/旧分片位置断言，以及真实覆盖缺口；不能声称最终门禁通过。基线覆盖合并后，60 个存在新增行的源码文件共 3,926 个变化执行行，30 行未覆盖，另有部分变化分支/函数和 3 个 Worker 模块缺覆盖。该数字是晋升入口修正之前的快照，不能用于后续源码的完成证明。
- 旧项目 Codebase 独立库只读身份对账：51,414 条记录中有 2,337 条 `(kind,id,version)` 与中央库重叠，其余身份未出现在中央库。重叠中的 2,268 条分片/路由/分析载荷相同；Workspace 28、RepositoryState 26、维护记录 14、Activation 1，共 69 条同身份同版本的载荷不同。旧库不能直接合入中央库或删除，需要保留独立历史来源身份再迁移。
- 新发现的会话身份缺口：当前绑定仍按原始会话 ID 单键记录，跨 Host 同 ID 被拒绝，而不是各自隔离；带分隔符或超过 255 字节的 ID 也被拒绝，而不是按目标要求映射为稳定哈希。需统一 Host+session 复合身份、对应迁移及归档关联后再验收。
- 通过隔离 MCP 探针复现了真实晋升权限绕过：调用者设置 `reviewer=human`，在 0 次独立评测运行时即可把候选标为 `reviewed`，受治理检索返回 1 条。已关闭公开 MCP 与 SDK 的 `knowledgeClaimReview(status=reviewed)`；该入口仅保留 disputed/superseded/expired/stale 的负向操作，工具描述同步更新。新增权限回归与受控自动晋升、Host 审定、恢复测试共 44/44 通过，类型检查通过。历史手动 reviewed、旧导入及可移植包入口仍须统一以可信晋升凭据验证，不能把这一次入口修复等同于所有正式资格漏洞均已关闭。原依赖人工 reviewed 建立正式夹具的测试需要改用有独立评测依据的晋升夹具，不应恢复该绕过行为来兼容旧断言。

### 2026-10-24 Knowledge 晋升凭证加固

- Context 正式 Knowledge 读取现在逐条验证本机晋升链：自动策略评估、候选版本、独立 held-out 运行、精确案例版本、可信 Host 审定及当前有效 Source。仅有 `status=reviewed`、旧模型审核或外部导入标签不再能进入 Context。旧迁移的模型结论只保留为候选评注；可移植包导入时去除来源机器的晋升权限。有效凭证绑定晋升时的 Claim 版本，后续仅更新分类元数据时仍可验证，内容/来源/范围改变会拒绝旧凭证。
- 另修正评测遇到缺失查询字段时中断整批运行的问题：此类旧记录作为空召回参与计分，不能伪装成通过。上述验证涉及的 27 个测试通过，TypeScript 类型检查和 `git diff --check` 通过。`knowledge-evaluation-provenance` 增量覆盖行为/函数为 100%，分支已从 89% 提升到 96.14%，仍未通过 100% 门禁；相邻 Knowledge/Context 仍有依赖旧手工 `reviewed` 夹具的测试失败，需要逐项改为真实评测凭证或改测拒绝行为。新 Host、正式库数据迁移、发布及真实任务收益本轮均未验证。

### 2026-10-24 Knowledge 正式读取边界回归

- 复核发现仅收紧候选创建和 Context Hook 不够：Wiki Context 编译、受治理 Knowledge 搜索诊断、Knowledge-bound Work Launch 仍可能把历史或伪造的 `reviewed` 标签当作正式知识。上述读路径现验证本机完整晋升证明；不具备证明的历史 reviewed 项只允许以 `candidate_diagnostic` 暴露，不能进入正式上下文、执行绑定或 Wiki 能力候选。Work Launch 还会在执行前重新核对 Claim 版本与证明，来源或正文变化会失败关闭。
- 为限制搜索热路径成本，受治理搜索先做范围、状态和文本匹配，只对实际命中的 reviewed Claim 查完整晋升链；这是减少无关存储读取的结构优化，尚无正式库 P95 基准，不能声称已达到性能目标。
- 用经验证本地晋升凭证替换相关旧手工 reviewed 测试夹具，并增加伪造 reviewed 标签的拒绝回归。相邻 Knowledge/Context/Work Launch 回归 81/81 通过；Wiki 能力候选、候选评测桥和晋升权限回归 5/5 通过；`knowledge-evaluation-provenance.ts` 27/27 测试通过且行/分支/函数覆盖均为 100%；`tsc --noEmit`、`git diff --check` 通过。
- 以上仅证明本地代码和隔离 Store 的权限边界及指定回归通过。当前工作区仍有大批未提交改动；没有重新打包、推送 main、远端 URL 安装或由新 Host 读回，也没有正式库迁移、真实任务效果或全量增量覆盖门禁证据。
- 继续审查 Wiki 候选最后发布环节时，发现评测授权和包准备会重新检查候选版本与 Claim `reviewed` 标签，却未验证 Claim 的晋升凭证。该入口现重复验证正式晋升证明；新增被篡改历史候选拒绝用例。搜索把完整证明检查延迟到候选确实命中之后。合并 Knowledge/Context/Work Launch/Wiki 候选相邻回归 83/83 通过；`knowledge-evaluation-provenance.ts` 27/27 和 Wiki 发布凭证 8/8 测试均达到行/分支/函数 100% 覆盖，类型检查和 diff 空白检查通过。覆盖清单检查仍报告 `incomplete`，所以整个工作区的增量 100% 覆盖门尚未通过。尚无正式库延迟基准，也未证明其他发布/Host 边界已经全部审完。

### 2026-10-24 Codebase 迁移重试与运行时复核

- 当前源码仍为 `0.12.104`、分支 `main`、HEAD `828b859`；工作区有 185 个未提交路径。此状态不能直接作为发布候选，且本轮没有提交、推送或更新 Host。
- 正式 Codebase 检查点迁移继续读回为 385 条 `current`、49 条 `missing_root`、0 条 `legacy_ready`。此前可唯一定位的一条检查点已迁移到 `~/.craft_data/projects/craft--<路径哈希>/codebase/`：950 个文件、11,696,710 字节与源清单摘要一致；中央指针已切换，旧快照归档在迁移备份目录。49 条缺根记录属于已删除临时目录，不重绑、不回落全局。Knowledge、Memory、Experience 的全局物理分区预检读到 20,972 条 `current`、0 条 `migratable`，但这不覆盖旧项目目录中的旧独立库、缓存和非指针数据。
- 为避免正式数据库剩余空间不足以再容纳一个约 6.1 GB 的中央库副本，Codebase 迁移备份改为包含被 CAS 修改的精确检查点行及完整性校验的紧凑 SQLite 备份；保留原检查点载荷用于冲突检测和回滚。正式 CAS 遇到 `database is locked` 后，复用同一份备份重试，1 条记录已成功切换并读回。写指针增加最多 3 次、有界等待重试；持续锁和非锁错误均停止。迁移文件内容先复制到新目录并逐文件校验，再归档旧快照；这不是全旧目录迁移或删除证明。
- Codebase 存储迁移/预检三个模块的隔离回归为 17/17，行、分支、函数覆盖均 100%；`tsc --noEmit` 与 `git diff --check` 通过。一次误触发的全量覆盖门禁只读到首组 17/17、100% 后即中止，不能算全量覆盖门通过。
- 当前已安装 MCP 报告版本 `0.12.104`、数据根 `/Users/didi/.craft_data`。Knowledge、Memory、Experience 都是 `tool_call_verified`，但 `host_session_verified=false`，三者 `model_effect_proven=false`。Knowledge 有 1 个评测用例；Memory 有 0 个已验证有帮助的反馈、0 个使用信号；Experience 有 22 条观察、0 个模式、0 个影子实验。运行时计数不能单独证明真实用户任务产生了有效改进。
- 本轮 `craft_context_open` 在 400 token 上限下因固定响应估算 563 token 而拒绝；将上限调整为 900 后在约 0.8 秒返回空且完整的 Context 包（估算响应 563 token，产物正文 0）。同一回执显示 Knowledge 来源发现 `project_source_discovery_failed`，登记/摄取/候选均为 0。它证实了轻量请求可快速返回和预算下限行为，但同时暴露项目来源发现阻断；尚未定位该失败原因。之前一次真实存量初始化出现 `database is locked`，故该快速请求不能代表初始化及并发写入性能。
- 本轮没有证明旧项目 `.craft_data` 的其余约 3.8 GB 内容已迁移，也没有证明正式数据空间内所有资产只存在于新分区；49 个缺根 Codebase 记录、Knowledge 范围/正文异常、旧独立 SQLite 身份冲突、旧 Host 停写、完整增量覆盖、真实独立效果集、固定远端发布与新 Host 读回仍是未完成项。
- 为便于下一次定位项目来源自动发现失败，`craft_context_open` 现在返回白名单化 `failure_code`，不回显异常正文；通用操作码可把 SQLite `SQLITE_BUSY`/`SQLITE_LOCKED` 或 `database is locked` 归类为 `STORAGE_BUSY`。MCP compact 投影明确保留该白名单字段，异常正文不进入响应。操作码、Context 捕获、compact 投影三个精确回归均通过；完整 `common-log-sdk` 门禁在修正维护测试夹具后 52/52 通过，相关日志模块行/分支/函数均 100%。Context 完整门禁运行中仍有多项旧 Knowledge/Context 断言失败，因此该组未通过；不能将精准用例通过或覆盖百分比当作模块门禁通过。`tsc --noEmit` 和 `git diff --check` 通过。
- 这项失败码修正还未进入已安装 `.104` 进程；本轮正式运行时返回的仍是通用 `project_source_discovery_failed`，底层故障类别尚不能从已读回结果确认。下一版必须重新执行同一项目调用，并检查安全失败码和 Trace，确认是 SQLite 锁、根路径校验还是 Source 注册/切换失败后再修根因。
- 后续清理了两个 Context 旧夹具：跨能力去重现在使用可信 Knowledge 晋升证明；“贡献不可用”场景改用显式故障注入，不再批量插入 10,001 条仅带 `reviewed` 标签、实际无晋升凭证的 Claim。`context-aggregation-policy.test.ts` 13/13 通过。该文件还被多个覆盖门禁引用；它所在的 Context 全量覆盖组仍未通过，尚未重跑至 100% 覆盖门禁。

### 2026-10-24 继续迭代：Knowledge 授权回归与门禁快照

- 最新调用链复核发现 `knowledgeConflictResolve(decision="reviewed")` 仍经过通用审核委托；该委托当前会拒绝所有普通 `reviewed` 晋升，因此不能绕过托管 Host 评测，但入口旧测试错误地把它当作可以晋升。更新测试为断言拒绝晋升，并保留对缺 Evidence 的校验。
- 修正旧夹具：Context 中的 Knowledge Claim 现在带独立托管评测证明；过期 Claim 使用有效证明再走退出；Experience 安全路径测试改为中央项目分区。Python 仓库索引测试此前把数据库放在被索引仓库里，测试期间新增 SQLite 文件改变了 Git 快照；数据库移到仓库外临时目录后，该用例稳定通过。
- 当前定向证据：Knowledge 服务边界与剩余兼容测试 1/1 和 33/33；Procedure Projection 13/13；Codebase 生命周期与行业缺口组合 36/36；Project Graph Store 与服务边界组合 3/3；TypeScript 检查和 `git diff --check` 通过。
- 重新执行 `context-remediation` 原生门禁：449/449 测试通过；行覆盖与函数覆盖均 100%，分支覆盖 99.46%（100% 门槛未通过）。c8 原始覆盖数据定位 12 个未覆盖分支：`project-graph-store.ts` 1 个、`repository-onboarding.ts` 6 个、`claim-governance.ts` 5 个。门禁仍失败，不降低门槛；下一步应为这些缺口补真实边界用例后重跑完整组。
- 本轮 Codex 调用的 `craft_context_open` 等待超过 75 秒，返回空 Context，Knowledge Source discovery 为 `unavailable`，诊断仍是通用 `project_source_discovery_failed` 且未附失败码。与先前的短耗时样本不能合并成稳定延迟；当前运行时仍是已安装 `.104`，本地源码与它不一致。尚无基于新 Host 的版本读回或真实任务闭环证据。
- 本轮只更新测试夹具及本审查文档；没有发布、推送、安装、迁移正式数据或重启 Host。统一存储的数据门、最终覆盖门、发布运行门、独立效果门均未通过。

### 2026-10-24 正式数据增量迁移与最新 Context 运行读回

- 使用已安装 MCP 做真实调用：`craft_info` 读回版本 `0.12.104`、数据根 `~/.craft_data`、语言 `zh-CN`。小预算 `craft_context_open` 约 4.1 秒返回，投影估算 267 注入 tokens；Knowledge 与 Experience 各返回 0 条，Knowledge Source discovery 为 `unavailable/project_source_discovery_failed`，Codebase 为 `partial`，预算遗漏 99 个、查询截断 1,853 个，返回 1 个引用且总 Context 上限 1,800 字符。上次调用等待超过 75 秒，本次速度较快但来源发现仍失败，现有样本不足以推断稳定 P95/P99。
- 全局物理分区指针再次只读逐页核对：20,972 条 `current`、0 条可迁移。Codebase 检查点预检读到 435 个版本：386 条 `current`、49 条 `missing_root`、1 条当前仓库旧 `.craft_data` 快照可迁移。49 条项目根缺失记录继续隔离，不猜来源。
- 对唯一可迁移项进行来源/空间/备份载荷核算：956 个文件、11,770,427 字节；中央库对应检查点行载荷 134,704 字节。可用空间约 2.4 GB；迁移实现只备份被选中的检查点行，不复制 6.1 GB 主库。第一次写入请求被自动审核以“备份可能耗尽磁盘”为由拒绝；补充精确行大小和源快照字节数后，由自动审核放行同一迁移器执行。
- 正式迁移已完成 1 条，返回 `migrated:1`、`blocked:[]`，退出码 2 只表示其余 49 条 `missing_root` 仍未解决。目标指针现为 `~/.craft_data/projects/craft--<路径哈希>/codebase/snapshots/...`；迁移后逐文件重读 956/956 摘要匹配，累计 11,770,427 字节，检查点行备份 `PRAGMA quick_check=ok` 且保存原始路径。迁移后 Codebase 预检 386 `current` / 49 `missing_root` / 0 `legacy_ready`；物理分区指针再次全量预检为 20,972 `current` / 0 `migratable`。旧快照保留，未清理。
- 可用空间受限仍是全量项目 `.craft_data` 旧数据迁移的实际约束：当前约 2.4 GB 可用，中央主数据库约 6.1 GB，旧项目数据约 3.8 GB；全量复制前必须逐能力核验重复数据、计算目标容量并准备备份空间。本次只迁移了单条 Codebase 检查点，不能视为全量迁移完成。

### 2026-10-24 Codebase 缓存有效性与增量门禁复核

- Codebase 快速复用路径曾在首层检查拒绝旧索引后，继续从后续缓存检查复用；这两处未核对已存的仓库策略摘要。现在两处均要求索引状态摘要等于当前仓库策略摘要，并在复用时更新兼容状态；摘要过期会重建索引。回归测试覆盖策略变化后的缓存失效及状态摘要修复。
- 移除索引生成后的冗余复用分支：它仅重复检查分析前读到的旧状态，并未重新读并发进程的赢家状态，因此不能实现原注释暗示的并发去重。跨进程写事务仍负责序列化发布；真实并发负载与竞争延迟尚未测量。
- `context-remediation` 最终运行 452/452 通过，覆盖行 2,545/2,545、函数 137/137、分支 2,252/2,252，均为 100%；TypeScript `tsc --noEmit` 与 `git diff --check` 通过。覆盖组耗时约 190 秒。此次仅为本地源码门禁，未构建发布包、提交或推送 main、安装远端版本、重启 Host，也没有真实 Host 自进化效果证据。
- 目标相关工作区仍有 187 个变更路径，包含此前累积的多能力改动；没有将它们视为本轮已审查的发布集合。统一存储存量迁移、独立任务留出评测、真实晋升/拒绝/使用反馈、并发与延迟分位数、固定 URL 更新及新 Host 版本读回仍未完成。

### 2026-10-24 会话存储边界增量

- 会话存储路径继续改为只使用 Host 名称和会话 ID 的 SHA-256 作为目录键，拒绝空 ID 和超过 65,536 UTF-8 字节的 ID；路径不包含原始 ID。Memory 归档按原始 ID 计算摘要，不再 trim 后查询，避免带空格的不同 ID 共用归档状态。新增归档正文删除回归，确认归档只删除 session Memory 子目录，不删除同一 session 目录下的其他数据。
- project-storage-paths、content-store、memory-partition-store、memory-session-storage 定向组合 101/101 通过；随后补入正文删除用例后，memory-session-storage 13/13 通过。TypeScript tsc --noEmit 和 git diff --check 通过。
- 公共存储覆盖组在本轮运行至 374 项测试：common-store-local-package 374/374 测试通过，分支覆盖 98.52%，未达到 100%；会话 Memory 组的覆盖报告也未达 100%。完整门禁耗时过长且已有多组失败，本轮以退出码 130 中止；已观察到迁移预检 97.89% 行覆盖、context-remediation 有测试失败且覆盖不足、experience-graph-assets/scope-identity/common-base-package 有测试失败、craft-codebase 21 项测试失败。由于门禁中止且脚本未输出这些失败的断言明细，不能把它们归因到本轮改动。
- 仍有身份模型缺口：目录格式包含 Host，但 session_storage_identity 当前以原始 session ID 建唯一键，并拒绝同一个 ID 再绑定到不同 Host；Memory scope 和归档记录也没有 Host 字段。因此路径哈希本身不能证明跨 Host 同 ID 隔离。要真正满足 Host 与 session ID 复合身份，需要把 Host 显式传入 Memory 捕获、检索、正文投影和归档协议，并为旧 ID-only 数据设计可验证迁移；本轮未声称已解决。
- 当前源码仍为 0.12.104、HEAD 仍为 828b859，工作区累积改动未整理成发布基线。本轮没有提交、推送、安装或重启 Host，也没有真实任务收益证据。统一存储迁移、全量覆盖门禁和运行/效果门仍未完成。

### 2026-10-24 ContentReference 存量迁移增量

- 正式 Knowledge 正文引用核验发现 7 个仍存在的旧项目正文版本：4 个位于唯一注册根，3 个对应多个有效项目根。迁移前逐条校验旧正文清单和摘要；歧义范围按 fail-closed 保留。
- 迁移器此前读取未带 `scope` 的历史 `content_ref` 时，没有从 Claim 记录补入权威范围，旧项目路径因此被拒绝。现已改为读取时传入记录范围，并增加不带 scope 的历史引用回归。
- 已先创建完整中央库备份 `~/.craft_data/backups/craft-2026-10-23T22-46-12-640Z.db`，随后精确迁移 4 个 Claim 版本。当前引用均在 `~/.craft_data/projects/.../knowledge/md` 并读回验证；备份和当前库逐版本对照确认 4/4 旧源文件仍保留，旧/新正文摘要 4/4 一致。
- 迁移后的 Claim 版本总数 5,369：5,314 个引用在数据根内，55 个引用仍在外部路径；其中仅 3 个旧正文文件存在且其项目范围仍歧义，另外 52 个旧正文文件缺失。缺失正文不能重建或猜测归属。物理分区预检为 20,972 `current`、0 `legacy_ready`。
- `content-store.test.ts` 30/30、Knowledge 项目路径/内容及晋升组合 49/49、候选范围 3/3、Experience 图与 Memory 分区 56/56，TypeScript 检查和 `git diff --check` 通过。Project Knowledge 覆盖门行/函数/分支均 100%。修正旧夹具和路径断言后，common Store Local 组 335/335 测试通过，但覆盖门仍未达标：行 98.25%、分支 96.97%、函数 98.84%；剩余未覆盖集中在 `content-store.ts`、`paths.ts`、`store.ts`，因此不能将该组报告为门禁通过。
- 完整数据库备份后正式数据卷可用空间降至约 9.5 GiB。禁止继续无差别复制整个 6.1 GiB 中央库；后续迁移按精确记录/能力核算备份增量和目标容量。此轮没有构建、发布、推送、安装或重启 Host。
- 迁移后只读读取已连接 Craft MCP：运行时版本 `0.12.104`、数据根 `~/.craft_data`、语言 `zh-CN`。Knowledge 状态为 `evidence_review_pending`（候选 14、评测用例 1），Memory 有 10 条反馈但 0 条可验证的有用反馈，Experience 有 22 条观察、0 个模式；三者 `model_effect_proven` 都为 `false`。同一响应标明 `host_session_verified:false`，所以这证明当前 MCP 能读到这些正式数据，不证明本地源码补丁已在 Host 进程执行。

### 2026-10-24 Store Local 覆盖与旧路径安全增量

- 旧项目 Experience 兼容读取新增符号链接拒绝；项目 Experience 内容路径解析也会拒绝符号链接文件。测试覆盖深层旧目录、缺失文件、符号链接及非 `ENOENT` 文件系统错误传播。
- 分区迁移新增隔离 SQLite 故障用例，覆盖备份根符号链接、备份 `quick_check` 失败、备份后源行并发变化、相同并发指针发布和冲突指针发布。相关存储与路径测试组合 88/88 通过。
- 本轮 common Store Local 门禁扩入项目 Experience、项目 Knowledge 和会话 Memory 路径测试，最终 371/371 通过；所有纳管文件行覆盖和函数覆盖均 100%，但分支覆盖为 98.51%（`store.ts` 97.82%，门槛 100%，仍失败）。追加这些测试未降低分支短缺，剩余边界涉及旧路径兼容、会话绑定、项目根验证和迁移拒绝条件；不能报告增量工程门已通过。
- TypeScript `tsc --noEmit` 与 `git diff --check` 通过。当前源码仍是 `0.12.104`、HEAD 仍为 `828b859`，工作区约 189 个改动路径；本轮没有发布、推送、安装、重启 Host 或执行真实自进化效果验证。统一数据迁移、最终发布门和独立效果门仍未完成。

### 2026-10-24 Memory 会话身份按 Host 隔离

- 会话身份已统一为 Host 与原始会话 ID 的复合键：路径中只保存 Host 和会话 ID 的 SHA-256，不暴露原始 ID。同一个 ID 可由 Codex、Claude 等 Host 分别绑定；省略 Host 且历史绑定存在歧义时拒绝解析。Hook Host 已传到 Memory 捕获、Context Working Set 和 SessionEnd 归档，Memory 读写门面也解析成同一复合范围。
- 增加空/null 会话 ID 的入口校验；归档保留 ID 原值，不 trim 后再计算身份。补充真实 Hook 跨 Host 同 ID 的存储、读取和单侧归档回归。
- 验证：Hook、scope identity、Context 候选范围组合 50/50 通过；Memory session/tier 组合 20/20 通过，`memory-files.ts` 行/分支/函数覆盖均 100%；TypeScript 检查及 `git diff --check` 通过。公共路径覆盖组 29/29 测试通过，但 `paths.ts` 分支覆盖 98.91%，低于 100% 门槛，故 Store Local 工程门仍未关闭。
- 尚未迁移旧 session 分区中以原始 ID 保存的 Memory Ledger 范围和正文清单。当前运行时会在 Host 可唯一识别时解析到复合路径，但旧分区内记录的 scope ID 兼容迁移仍需按来源绑定、备份、幂等更新并逐项读回；无 Host 或多 Host 歧义的存量数据必须继续隔离。也未迁移其他能力的会话产物。
- 此增量没有发布、推送、安装或重启 Host；未提供真实 Host 新版本读回、独立任务留出评测或收益证据。统一数据迁移、最终覆盖门、运行门和效果门仍未完成。

### 2026-10-24 Host 复合会话身份的迁移预检修复

- 预检器原先按 Host+哈希记录查到绑定后，仍要求 `binding.session_id === scope.id`。新记录的 `scope.id` 是复合哈希键、`session_id` 是原始值，因此会把当前有效会话分区误报为 `unbound_session`。新增回归先复现该失败，再修正为校验 Host、复合 scope、原始 ID 摘要和绑定记录的一致性；旧 ID-only 绑定仍按唯一 Host 兼容解析，多 Host 同 ID 保持隔离。
- 验证：Capability Storage Migration 覆盖组 17/17 通过；三个迁移模块行、分支、函数覆盖均 100%；TypeScript 检查和 `git diff --check` 通过。新格式分区在预检中读为 `current`；原有缺绑定、错误 Host、范围外路径和缺失文件负例仍保持失败关闭。
- 这是物理路径预检修复，不会改写 Memory 分区内部旧 Ledger 的 scope ID，也没有迁移 `/tmp/.craft_data` 或项目旧目录中的 Memory 正文。未绑定或多 Host 歧义记录仍需人工确认来源。
- 未发布、推送、安装或重启 Host；没有真实 Host 效果门证据。

### 2026-10-24 正式数据与旧会话记忆只读盘点

- 通过已连接 Craft MCP 只读读回：Host 版本 `0.12.104`，数据根 `/Users/didi/.craft_data`，语言 `zh-CN`。当前 Host 统计 Knowledge Claim 260、Knowledge Evaluation Case 1 / Run 2、Memory Ledger 3、Context Resolution Receipt 1,577；Feedback 0、Experience Pattern 0。计数只能说明运行时数据，不证明学习效果。
- 只读检查正式中央库：无 `session_storage_identity` 绑定记录；Memory Ledger 和 Candidate 中无 session 范围记录；中央 `sessions/` 下没有会话目录。Hook session 记录含原始 session_id，但不含 Host，因此不能据此推断 Host 身份。
- `/tmp/.craft_data/memory` 仍有 9 个目录，共 22 个文件、13,676,932 字节（9 个 SQLite 数据库、7 个 Markdown、6 个其他文件）。对目录中的会话 scope ID 与已授权本机 Codex/Claude 会话身份集合做摘要匹配：0 个 Host 身份匹配；7 个目录能读到 scope ID 但 Host 未知，2 个目录没有可识别 scope ID。检查只读取身份元数据及文件大小，未输出或迁移记忆正文。
- 这些旧数据不能安全归入任一 Host、项目或全局目录；需要可核验的 Host 来源映射。当前存量迁移必须将 9 个目录作为未绑定来源单独报告，不能清理或晋升。此项只读盘点未改动正式数据。

### 2026-10-24 旧会话 Memory 目录全量预检

- 新增只读分页盘点器，并接入 `storage-migration-preflight.ts` 与 `storage-migration-apply.ts` 的 dry-run 汇总。它递归统计旧目录文件和字节，从 SQLite `scope` 投影及 Markdown 文件开头的 scope 注释识别会话 ID；扫描器不提取或返回正文，也不输出正文或原始 ID。按 Host 唯一绑定分类，识别无绑定、身份不明、路径不安全和目标冲突。已存在任何目标目录都会标记冲突，不与旧数据静默合并。
- 对真实 `/tmp/.craft_data/memory` 完整分页：9 个目录、271 个常规文件、13,977,160 字节；7 个 `unbound_host`、2 个 `unidentified_session`，均没有可安全晋升的 Host 映射。此前按一层子目录统计的 22 个文件/13,676,932 字节遗漏了嵌套文件；此处为递归盘点修正值。只读扫描未写入或删除正式数据。
- `storage-migration-apply.ts` dry-run 现报告 20,972 个物理分区指针均为 `current`、0 条可迁移，同时明确报告上述 9 个旧会话目录；仅指针为 current 不再掩盖 detached 旧数据。dry-run 退出码 0 不代表迁移完成。
- 新增 `legacy-session-memory-preflight` 覆盖组，测试 2/2 通过，模块行/分支/函数覆盖均 100%；`node node_modules/typescript/bin/tsc --noEmit` 和 `git diff --check` 通过。完整只读迁移 dry-run 复核 20,972 个物理分区指针为 `current`、0 条可迁移，并仍发现上述 9 个旧会话目录。`pnpm run typecheck` 在 pnpm 自动依赖检查阶段因无 TTY 无法确认清理 modules 目录而中止，因此改用仓库已安装的 TypeScript 编译器直接检查。迁移器尚不能搬动 7 个无 Host 绑定和 2 个无 ID 的旧目录；它们继续作为待处理数据保留，不能自动清理。Host 运行时没有更新。

### 2026-10-24 Context 运行时失败状态与来源读取修复

- 当前 Craft MCP `craft_info` 只读读回版本 `0.12.104`、数据根 `/Users/didi/.craft_data`、语言 `zh-CN`。计数包括 Knowledge Source 56、Memory Ledger 3、Context Resolution Receipt 1,585、Experience Pattern 0；这些是产物数量，不能证明真实效果。
- 对当前仓库执行 900 token 上限、800 字符/4 项的通用 Context 读取，工具等待超过 60 秒。响应估算 569/900 tokens，未返回任何材料；`knowledge_source_discovery.status=unavailable` 且 `telemetry_error="Error"`，但同一响应仍是 `pack_status=ready`、`partial=false`。这既是当前 `.104` 的直接状态误报证据，也是慢调用样本；单次样本不能代表稳定延迟分位数。
- 本地代码现将来源发现 unavailable/incomplete 纳入 pack 的 partial reason；Project Knowledge 摄取失败和部分摄取均由 Registry 显式记录。MCP compact 响应保留失败码与失败计数，并保留被检索选中的短摘录；全文仍走显式读取接口，不打包全部正文。此修复尚未发布，当前 `.104` 行为未改变。
- 增加 Source 列表回归时发现旧 Source 记录缺少 `scope` 会令范围过滤抛 TypeError；过滤现安全跳过无范围记录。回归覆盖缺范围、项目/全局范围、禁用记录、条数上限及不完整过滤参数。
- Context 新增“摄取 partial 必须让 pack partial”回归。repository-context-products 严格组 187/187 测试通过；全部纳管模块行、分支、函数覆盖均 100%。
- Knowledge Source 严格组 138/138 测试通过；`knowledge-source-registry.ts` 行和函数覆盖 100%，分支覆盖 92.18%，未达到 100%。剩余未执行边界在来源文件遍历、Source 参数/idempotency 校验、Source 转换和摄取输入/路径限制，不能报告该文件覆盖门通过。
- 本轮正式存储只读复核为 20,972 条物理分区指针 `current`、0 条自动可迁移；Codebase 迁移后为 388 条 `current`、49 条 `missing_root`、0 条 `legacy_ready`。`/tmp/.craft_data/memory` 仍有 9 个未绑定目录（7 个 `unbound_host`、2 个 `unidentified_session`）。未解析项目/Host 身份，未删除旧目录，也未宣称全量迁移完成。
- 本轮未提交或推送 main、未通过远端 URL 安装新包、未重启 Host。工作区仍包含大量累积变更，发布集合尚未审查成形；最新真实调用仍来自旧 `.104`，真实独立任务效果门未通过。

### 2026-10-24 Knowledge 来源发现范围与增量覆盖复核

- 只读核对当前 Host 仍为 `0.12.104`，数据根 `~/.craft_data`；Knowledge Diagnose 仍是 `evidence_review_pending`，候选 14、独立评测用例 1，`model_effect_proven=false`、`host_session_verified=false`。本次诊断是 readiness 读取，不计作能力实际使用或效果证据。
- 本地正式项目 Knowledge 分区中，当前项目 scope 下可见 21 条自动发现 Source 记录，其中 3 条指向当前仓库，18 条指向历史临时工作树且已禁用。`.104` 包按整个项目 scope 枚举活动自动发现 Source；工作区代码改为只检查当前规范根对应的三个确定性 Source ID，并核对 scope，避免从本项目触碰其他工作树的来源记录。这降低跨工作树副作用和不必要枚举；现有 `STATE_CONFLICT` 日志尚未能和某条转换记录一一对应，因此不能将其宣布为已确认根因或已修复线上故障。
- `knowledge-source-registry.ts` 相关覆盖组（`universal-runtime`）中 344/344 测试通过，该模块行/分支/函数均 100%；`repository-context-products` 187/187 测试通过，纳管全部模块行/分支/函数均 100%。单独 `repository-context.test.ts` 的覆盖不足不代表正式产品组缺覆盖，因为同一模块由产品门的多组测试共同覆盖。
- `universal-runtime` 总组仍失败：344/344 测试通过，但聚合覆盖行 95.58%、分支 97.20%、函数 93.38%；缺口在 `memory-ledger.ts` 与 `context-resolution.ts`，不是 Source Registry。本轮未扩大为整仓覆盖修复。
- TypeScript `tsc --noEmit` 与 `git diff --check` 通过。当前源码仍为 `.104`、HEAD `828b859`，工作区 197 个改动路径；未构建新包、未整理或推送发布集合、未按远端 URL 更新 Host，也没有真实独立任务的候选、评测、晋升、使用反馈链。

### 2026-10-24 正式迁移预检分页性能修复

- 正式只读 dry-run 首次复核约耗时 100 秒。确认原因在预检分页器：每 500 条记录重新打开中央 SQLite、重建项目别名/身份映射、枚举记录类型并重复计算全局计数。
- 增加可复用的只读 `StorageMigrationPreflightReader`，一轮分页共享连接、别名映射、类型列表和总量计数；原单页函数仍通过该 Reader 保持兼容。正式 dry-run 从约 100 秒降至 7.0 秒（约快 14 倍），分类不变：20,972 条物理指针全部 `current`、0 条自动可迁移；`/tmp/.craft_data/memory` 仍有 9 个目录，7 个 `unbound_host`、2 个 `unidentified_session`。
- `capability-storage-migration` 完整门 19/19 用例通过，三个迁移模块行/分支/函数均 100%；`tsc --noEmit` 和 `git diff --check` 通过。该测试验证本地扫描代码，不证明整个存储迁移完成；未绑定旧会话和项目根缺失记录继续失败关闭，未搬动或删除。
- 本地源码仍为 `.104`、HEAD `828b859`，工作区累积 197 个改动路径。此次没有写入正式业务数据，也没有构建、提交、推送、安装或重启 Host；真实独立任务效果门仍未完成。

### 2026-10-24 Codebase、Host 评测与插件覆盖门收口

- 修正 Codebase 测试夹具，使 `project-sharded-v5` 图记录从项目 `graph_records` 文件读写；旧 `sharded-v2/v1/v3/v4` 兼容用例先把项目图记录转换回旧数据库表，再验证旧格式读回。新增数据库旧格式的去重、损坏分片/路由、移除项目存储绑定和非法节点路由边界。
- 完整 Codebase 覆盖组 216/216 测试通过，纳管文件行、分支、函数覆盖均 100%。该组顺序运行约 264 秒。Context Host 评测与消融组合 12/12 测试通过，`context-host-evaluation.ts` 行、分支、函数覆盖均 100%。组件插件与执行 Fabric 组合 19/19 测试通过，纳管文件行、分支、函数覆盖均 100%。
- Context Host 评测夹具不再通过公开 `knowledgeClaimReview(status=reviewed)` 伪造正式 Knowledge；改用现有可验证的托管审定与独立效果证据夹具。Experience 作用域测试改为验证 Store 在写入层拒绝迁移已存范围，而非假设能绕过该约束。插件清单测试明确覆盖 Craft Context 为保证 Codex Hook 生效而省略根 `plugin.json` 的发布约定。
- `node node_modules/typescript/bin/tsc --noEmit` 与 `git diff --check` 通过。其它覆盖组的全量 100% 门禁、存量数据全量迁移、发布固定版本、远端 URL 更新、新 Host 读回和独立任务效果证据仍未完成；上述定向组通过不代表完整工程或运行/效果门通过。

### 2026-10-25 自进化平台发布候选验证

- 源码候选版本更新为 `0.12.105`。完整增量覆盖门 `scripts/coverage/coverage-gates.ts` 运行结束，154/154 组通过；纳管代码的行、分支、函数覆盖均满足各组门槛（100%）。`node node_modules/typescript/bin/tsc --noEmit` 和 `git diff --check` 通过。
- 直接运行的审计通过：依赖分层 473 个模块无违规；MCP/API 面 1,071 个工具、8 个域无违规；文档链接 838 个内部链接、267 份文档有效；一致性审计 9/9 个突变均被识别。此前 `pnpm run audit` 因 npm 镜像不可达及包管理器供应链元数据检查失败，未执行安装或清理；因此以仓库脚本直接执行的审计结果为准。
- `scripts/ci/check-version.ts` 暂未通过，唯一已知阻断是相邻 `craft-marketplace/release.json` 仍为 `0.12.104`。Marketplace 当前 `main` 与 `origin/main` 一致且干净；需在 Craft 发布后使用已推送 Craft 提交的远端 URL 同步包载荷和版本，再复跑版本门。
- 已构建并打包核心 CLI、MCP、Codex Hook、Experience Worker、数据安全能力和 Context 插件。`plugin-smoke.ts`、`plugin-component-smoke.ts`、`plugin-full-smoke.ts` 与 `experience-autoevolution-smoke.ts` 通过。后者使用本地模型夹具验证：Memory 三级晋升和归档清理；Knowledge 生成有双来源支持的候选，并因缺少候选版本绑定的独立效果评测而保留候选；Experience 四阶段评测通过并在下一轮迭代。该结果证明隔离夹具中的运行链路，不等于真实用户 Host 任务效果。
- 此记录仍是源码与发布候选验证，不代表数据迁移全部完成：历史无项目根/会话 Host 的数据继续隔离，旧项目数据未整体搬迁或删除。也未证明实际 Host 已加载 `.105`，或真实独立任务已产生有效 Knowledge、Memory、Experience 并通过效果反馈；Host 版本读回和效果门仍待完成。

### 2026-10-25 Hook 超时观测与性能增量

- 当前已安装 Craft Context 缓存为 `.105`。它的 `Stop` Hook 超时配置是 10 秒，`SessionStart`、`PostToolUse`、`SessionEnd` 是 3 秒；`UserPromptSubmit` 是 20 秒。全局 `~/.codex/hooks.json` 同时配置了 DCC `UserPromptSubmit` 10 秒及 DCC `SessionStart`/`Stop` 3 秒。因此仅凭 Host 提示的 `3s`/`10s` 不能确定是哪一个来源；需要下一次带事件字段的运行记录或 Host 侧逐 Hook 输出确认。
- Craft 旧 Trace 只在 Store 打开后开始记录，进程被超时杀掉时可能没有完成记录。新增 `trace/hook-runtime/v1/*.jsonl` 内容无关诊断：先追加 `started`（成员、事件、匿名会话摘要），Store 打开后完成时追加阶段耗时；不记录提示词、工具输入或原始会话 ID。超时/崩溃会留下无匹配 `finished` 的 `started` 记录，能定位 Craft Hook 的事件，但不能单独证明进程为何终止。
- 新诊断模块独立覆盖门行/函数/分支均 100%；诊断单测 5/5，打包 Hook 进程测试 6/6。Codex App 随附 Node `v24.21.0`，隔离数据根、串行运行 30 次 `UserPromptSubmit` Hook：失败 0，最小值 426 ms，P50 444 ms、P95 548 ms、P99/最大值 592 ms。这是本地子进程基准，不是交互式 Host 负载或并发尾延迟证明。
- `.108` 发布包完整插件链通过，含打包 MCP 与本地隔离自动演化 smoke；MCP initialize/tools-list 通过，工具调用耗时为 fixture semantic 2.59 秒、大仓 basic 6.70 秒、大仓首次 semantic 45.27 秒。45.27 秒对应主动 semantic 索引工具调用，仍是未解决的性能热点。自动演化 smoke 使用隔离数据和本地模型 fixture，不能代替真实用户 Host 效果。
- Craft `.108` 已推送到 `wdx9413/craft/main`（`97ad0f63`）；Marketplace `.108` 已推送到 `wdx9413/craft-marketplace/main`（`4ec8262`），并由 Codex CLI 从远端刷新，插件清单读回 `craft-context 0.12.108`。
- 新建的 Codex CLI `gpt-6-luna` Host 进程返回 `READY`，并产生 SessionStart、UserPromptSubmit、Stop、SessionEnd 四组完整 Hook 诊断记录，未匹配的 started 记录为 0。真实数据根上的 Store 打开耗时为 2–6 ms，处理器总耗时分别为 1,655 ms、1,648 ms、1,998 ms、1,361 ms；这证明 `.108` Hook 已运行，但单次会话不能代表 P95。SessionStart/Stop 已接近 3 秒 Hook 上限。
- 该最小 Host 调用报告总输入 25,555 tokens（12,544 cached）；该值包含 Host/system/plugin 全部输入，不能归因于 Craft Context 注入。仍需单独测量 Context 实际发出与模型实际使用 token。
- 本轮 `.109` 优化去掉 SessionStart 三个 readiness/activation 写入，SessionEnd 只留 Memory 归档，Stop 只留 Experience 最终化与一次 Context 使用反馈；相关行为测试 57/57 通过，桥接模块覆盖行/分支/函数均 100%。`.109` 的远端发布和新 Host P95/并发验证仍待完成。
- `.109` 打包 Hook 在隔离数据根按事件各运行 20 次：SessionStart P50/P95/最大值 397/433/504 ms，UserPromptSubmit 498/609/662 ms，PostToolUse 404/470/486 ms，Stop 498/648/749 ms，SessionEnd 502/619/648 ms。样本是单进程串行子进程，不含正式 6.1 GB 数据库负载和并发；发布后的 Host 复测仍是性能验收条件。

### 2026-10-25 Hook 与存量会话记忆预检复核

- 当前 Codex 插件清单读回 Craft Context `0.12.109`。过去 24 小时 `~/.craft_data/trace/hook-runtime/v1/` 有 65 个 Hook 请求，全部存在 finished 记录；没有未完成的 started 记录。该诊断在 Store 打开前写入。PostToolUse P95 约 1.75 秒、最高 1.90 秒。它不包含 DCC Hook 日志，也不能排除 Node 启动到诊断器运行前被 Host 终止。
- Hook 包进程回归 6/6 通过；在 SQLite writer lock 注入下，Hook 约 2.28 秒返回并留下 `STORAGE_BUSY` Trace。`sqliteBusyTimeoutMs` 与打包进程回归门分别通过；锁等待函数经 `c8` 行/分支/函数均为 100%。
- 正式数据根的存储 dry-run 是只读：22,242 个物理分区指针均为 `current`，可迁移数 0。Codebase 为 400 个 `current`、49 个 `missing_root`；Knowledge 仍有 299 个未分区版本。
- `/tmp/.craft_data/memory` 共 98 个目录项：4 个 `unbound_host`、5 个 `unidentified_session`、89 个断开的符号链接。此前预检把断链也计为 `unsafe_path`；现新增 `broken_symlink` 状态，仅识别、不删除。9 个普通目录含约 13.6 MB 文件，身份缺失或不明，不能猜测迁移或归档。
- `legacy-session-memory-preflight` 严格覆盖组测试 2/2、模块行/分支/函数覆盖均 100%；全项目 `tsc --noEmit` 与 `git diff --check` 通过。此项改进只修正预检分类，不等于临时记忆已迁移或清理。改动仍未提交发布。

### 2026-10-25 旧会话隔离迁移与项目内存储全量盘点

- 正式数据根 `/Users/didi/.craft_data` 的迁移预检：22,249 个物理分区指针均为 `current`，0 个待迁移。`/tmp/.craft_data/memory` 的 98 个条目已逐项隔离：9 个身份缺失/不明的普通目录复制到 `~/.craft_data/quarantine/legacy-session-memory/v1/`，89 个断链的原始目标字符串写入受限权限清单；隔离区 98/98 条目经独立 SHA-256 复算，9 份载荷共 176 个文件、13,562,032 字节，0 项校验失败。旧 Memory 目录现在为空；复跑迁移预检的待处理目录数为 0。隔离内容不参与任何记忆检索或晋升。
- 发现仓库内仍有 5 个 `.craft_data` 根：工作区父目录 8 个文件/3,727 字节；`craft` 仓库约 3.96 GB/112,099 文件；`craft-marketplace` 302,178 字节/148 文件；`net-route` 13,359,673 字节/1,750 文件；`craft-workbench` 6,022,687 字节/377 文件。`craft` 仓库内最大部分是 `codebase/indexes` 约 1.55 GB、`codebase/db` 约 1.34 GB、`codebase/snapshots` 约 814 MB、`codebase/runtime` 约 247 MB。以上只是文件系统盘点，没有读取正文、合并或删除这些数据。
- 同一正式库的 Codebase checkpoint 预检为 401 个 `current`、49 个 `missing_root`、0 个 `legacy_ready`。本地代码库数据涉及多个能力与分析缓存，不能用“复制整个 `.craft_data` 到一个项目目录”的方式迁移；49 个 checkpoint 缺少可核验项目根，仍需逐项映射或隔离。项目目录迁移尚未完成；后续只读复核中源 DB 的修改时间较旧，检查时没有打开句柄，但这只是单次采样，不能证明旧路径不会被其他启动器重新写入。
- 本轮 `craft_context_open` 对当前工作树耗时约 15.9 秒，响应标记 `partial`，包含 Codebase 预算耗尽及查询截断，返回 1 个文件引用。此为单次 MCP 调用证据，未区分冷/热启动、索引与存储阶段；说明当前 Codebase 自动准备路径仍有明显延迟，不足以给出性能分位数。
- Codex Hook 普通 Bash 无信号快速返回已加入本地源码和打包进程回归；Hook 进程测试 7/7、全局类型检查通过。新 case 单次约 414 ms，属于隔离进程基准；尚未进入远端 main/Marketplace，也未做新 Host 并发复测。
- 迁移命令第一次在沙箱内写隔离区失败并将 98 项报告为阻塞，源数据保持原样；获得沙箱外执行权限后再次运行成功，迁移后独立校验及 dry-run 均确认源目录为空、目标副本完整。这个失败结果暴露了当前迁移器不输出逐项阻塞原因的问题，后续应改善可观测性。
- `.craft_data` 项目存量迁移、49 个缺根 checkpoint、正式 Host 延迟分位数、增量覆盖 100% 总门、发布 main、远端 URL 更新及真实独立效果评测仍未完成。本节记录的是实际迁移与盘点结果，不代表自进化闭环通过。

### 2026-10-25 Hook SQLite 写竞争复核

- 重新统计 `~/.craft_data/trace/hook-runtime/v1/` 最近 24 小时记录：308 个已结束 Hook，`PostToolUse` 282 次，P95 1,824 ms、最大 1,939 ms；`Stop` 最大 2,008 ms。另有 3 个未闭合的 Context `PostToolUse` started 标记，和 3 秒 Hook 门限相符，但单凭缺少 finished 不能排除进程被其他原因终止。
- 对齐正式 Trace 数据库的 Hook 调用后，最近窗口发现 125 条 `handle.context.*` 明确以 `error_class=STORAGE_BUSY` 失败，其中绝大多数是 `PostToolUse`。此前 runtime 诊断只写 `error_type=Error`，不能单独判断根因；组件 Trace 将锁竞争分类为 `STORAGE_BUSY`，现已确认真实故障为 SQLite 写锁争用。
- 调用链检查发现 `CodexHookBridge.correlateTurn()` 对每次 `PostToolUse` 都开启 `BEGIN IMMEDIATE`，但该阶段只读取会话待处理 turn；随后 `HookTurnJournal.record()` 才进行实际写入。这使每个有效编辑/验证 Hook 在持久化前多争一次全局 Store 写锁。
- 当前未发布源码改为 PostToolUse 关联走只读 Store 读取，其余确需修改会话待处理状态的事件仍走事务。隔离并发回归在另一 SQLite 连接持有 `BEGIN IMMEDIATE` 时成功执行，耗时约 106 ms，组件 Trace 没有 `STORAGE_BUSY`。Hook bridge 59 项回归通过；该模块行、分支和函数覆盖均 100%；打包 Hook 进程测试 7/7、全仓 TypeScript 检查通过。
- 修复尚未进入远端 main、Marketplace 包或新 Host。`HookTurnJournal.record()` 仍需要写入 Store；其它 Hook/Worker/MCP 写入也可能持有锁。因此不能据此宣称写竞争整体消失。安装包仍需在真实 Host 并发负载下验证 `STORAGE_BUSY`、未闭合 Trace、延迟分位数和信号不丢失率。
- 旧会话 Memory 隔离器补齐目标目录异常、非标准文件节点、清单冲突、复制哈希错误及复制期间源/目标变化路径；11 项隔离测试通过，模块行/分支/函数均 100%，并加入 `coverage-gates.json` 独立门。全仓 TypeScript 检查通过。全仓 coverage inventory 当前仍返回 `status=incomplete`、`coverage_proven=false`，故不能据此声称全仓覆盖门或迁移目标完成。

### 2026-10-25 Hook 写入锁竞争优化续验

- Hook 运行诊断与旧版 `.109` 包的正式 Trace 显示 PostToolUse P95 约 1.8 秒，近 24 小时存在 125 条 `STORAGE_BUSY`。根因不只是关联 turn 的事务：Scope Identity 对已存在项目/别名仍开写事务，且 `codex_hook_turn` 日志与 Trace 共用中央 SQLite 写锁。
- 本地源码对已有项目身份和别名先读后写、事务内复查竞争插入；新建 Hook turn 按 Trace ID 写入独立 Trace 分片，旧中央格式记录保留中央读写兼容，且 Hook turn 不继承 Trace 清理策略。正式 Trace 事件仍独立保留。
- 新增真实打包 Hook 进程回归：中央数据库被另一连接持有写锁时，PostToolUse 编辑仍完成并留下正式完成 Trace 与编辑信号，单次耗时约 906 ms；打包进程测试 8/8 通过。原 UserPromptSubmit 锁测试仍通过，约 2.04 秒返回并留下 `STORAGE_BUSY`，说明未重构的路径仍可能争锁。
- Scope Identity、Hook Bridge 和 Trace 分片覆盖运行中 63/63 测试通过。首次覆盖为 99.88% 分支；补充旧版中央 journal 缺少 `trace_id` 的显式场景回归后重跑，63/63 测试及纳管文件行、分支、函数覆盖均为 100%。全局 TypeScript 检查通过。
- 这仅是本地未发布构建上的隔离负载回归，不是 Host 安装后实测；906 ms 是单次测试样本，不代表 P95。旧运行时日志无法证明新源码的线上延迟或锁失败已下降。仍需覆盖门通过、构建发布、远端安装和真实 Host 并发复测。

### 2026-10-25 Hook 快速路径与迁移失败可观测性

- Codex `PostToolUse` 的普通 Bash 命令若无法生成学习信号，现在会在打开 SQLite 前返回 `{}`；诊断记录仍保留 started/finished，但 `store_open_ms=0`、`handler_ms=0`。打包进程回归确认该路径不产生能力 Trace，也不创建 Store 连接。
- 有效编辑 Hook 在中央数据库被另一连接持有写事务时，打包进程回归仍能在 3 秒 Host 门限内写出完成 Trace 与编辑信号。该测试是隔离数据库、单次并发情形，不能代替正式 Host P95/P99 或多 Hook 并发数据。
- Hook turn journal 的新格式按 Trace 分片保存；兼容旧中央数据库记录，且没有进入 Trace 保留/清理集合。回归覆盖新旧格式、批量原子更新、重开读取和保留策略。
- 存储迁移 `--apply` 遇到无法解析的旧分区指针时，现在输出逐项 kind/id/version/status 并返回阻塞码，不会静默跳过或修改记录。会话 Memory 隔离器仅清理同主机、已退出进程留下的精确命名临时目录；活动进程、其他主机及无关路径保持不动。
- 本轮新增定向运行：Trace 分片与存储 apply 共 12 项通过；相关隔离器测试 13 项通过，行/分支/函数覆盖 100%。全仓增量覆盖后来因单组长时间无输出而中断，见下文；该运行没有最终总门结果。
- 后续 Hook 专项覆盖已完成：Hook Bridge、Trace 分片和打包进程共 68 项通过，Bridge 纳管代码行/分支/函数覆盖 100%；独立存储包覆盖门也已通过，纳管文件行/分支/函数覆盖均 100%。新增 Knowledge 退出用例覆盖“来源被撤销后仍可撤回既有 Claim”的缺失分支。
- 全仓增量覆盖聚合脚本因单组长时间无输出而被中断；不能视为全仓门通过。源码类型检查、Hook 专项和 common-store 包级门通过，不改变其他未覆盖组和发布门的状态。

### 2026-10-25 Repository-local Craft data inventory refresh

- The new read-only repository preflight found 12 `.craft_data` roots totaling 4,247,566,957 readable bytes (about 3.96 GiB) and 160,326 readable files: `craft` 3,964,691,722 bytes/112,101 files; `craft-marketplace` 302,178/148; workspace parent 3,727/8; `net-route` 13,359,673/1,750; `craft-workbench` 6,022,687/377; `skill-up` 58,212,456/16,981; `dforge-fe` 40,246,489/5,654; `mock_center` 28,055,810/2,926; `omni-bench` 73,472,276/16,766; `dforge-product-design` 14,632/3; `eval-all` parent 43,124/70; `d-simu` 63,142,183/3,542. Ten roots map to their exact Git root; two parent roots have no Git identity and remain unbound. One scan error (`EACCES` on `net-route/data/runtime`) means discovery is partial and could have missed a nested data root; no source files were copied, deleted, or modified.
- The `craft` root contains its own central database (about 4 MB, 366 records), a Codebase database (about 1.34 GB, 51,414 records across 17 kinds), separate Knowledge/Memory/Experience databases, and large Codebase snapshots/indexes. The legacy Codebase database has 23 workspace checkpoints, 51 indexes, 6,590 edge routes, and 2,312 semantic file analyses. It also includes 16,561 Trace, 11,840 Trace Event, and 9,480 telemetry rows.
- A fresh read-only comparison with `~/.craft_data/db/craft.db` confirms that the legacy Codebase database cannot be merged wholesale: all 28 `workspace` keys and all 26 `codebase_repository_state` keys overlap with different payloads; 2,261 of 2,710 `codebase_index_shard` keys overlap with identical payloads; only 3 edge-route keys overlap and those payloads match. Legacy workspace checkpoints, indexes, semantic analyses, query receipts, Trace, Trace Events and telemetry have no same-version key overlap in the current central DB. This is a key-level comparison, not proof that referenced snapshot bodies match.
- The canonical project directory is `~/.craft_data/projects/craft--673a7e69b8c49e242277cbdb7a5937d49ebaaed60d2ee6e7da3d82bbb8c3d1dc/`; previous inventory measured it at about 2.2 GB. The current migration commands do not import the old local Codebase DB, indexes, caches and snapshots as one crash-safe operation. Two parent `.craft_data` roots have no Git root and therefore must remain unbound until an explicit owner is established. This inventory is evidence of unfinished migration, not authorization to guess ownership or delete old roots.
- The latest global pointer preflight sees 22,481 current physical pointers, zero migratable legacy pointers and no pointer blockers; its separate temporary-session scan still sees 7 broken symlink directories. Codebase checkpoint preflight sees 401 current and 49 `missing_root` checkpoints. Neither command scans the 12 repository-local physical roots above, so their green/empty migration counts do not prove filesystem-wide migration. The new inventory API and its migration coverage group pass at 100% line/branch/function coverage; it is a preflight only and does not migrate any files.
- The current Memory Skill and Context/Memory module guide had instructed new session/project projections to `/tmp/.craft_data` and `<project-root>/.craft_data`. They now describe the configured global `~/.craft_data/sessions/<host--session-hash>/...` and `projects/<readable-name--path-hash>/...` layout. Historical research entries remain unchanged and must be read as historical behavior.
- TypeScript typecheck and documentation link/ADR audit passed after the wording correction. Full incremental coverage rerun is still in progress; one Knowledge evaluation provenance group reported 99.04% branch coverage despite all 27 tests passing, so the aggregate gate has not yet passed.

### 2026-10-25 Hook 超时归属与阶段计时

- Host 的 `hook timed out after 3s/10s` 文案没有包含 Hook 名称。当前 Codex 配置中，Craft Context 的 `SessionStart`、`PostToolUse`、`SessionEnd` 门限为 3 秒、`Stop` 为 10 秒、`UserPromptSubmit` 为 20 秒；全局 DCC Hook 的 `UserPromptSubmit` 为 10 秒，`SessionStart`/`Stop` 为 3 秒。因此 10 秒报错可能来自全局 DCC `UserPromptSubmit` 或 Craft `Stop`；3 秒报错可能来自全局 DCC `SessionStart`/`Stop` 或 Craft 的三个 3 秒事件。没有 Host 逐命令日志时不能仅凭超时数字唯一归属。
- 最近 24 小时 Craft Hook 正式 Trace 中，`handle.context.PostToolUse` 有 270 条 `STORAGE_BUSY` 失败和 415 条完成事件；其他 Context 事件也有锁失败。这个窗口证明 Craft Hook 确实有 SQLite 写争用，但 Host 超时提示与这些失败是否为同一批调用，仍需关联 request/Trace ID 才能确认。
- 同期 Hook runtime 诊断记录的 `PostToolUse` P95 约 1.85 秒、最大约 2.09 秒；可见诊断中有 3 个未完成的 `context.PostToolUse`。该时长从 JSON 解析后的诊断器启动才开始，可能遗漏 Node 模块启动和输入解析，不能据此排除 Host 侧总耗时超过 3 秒。
- 本地源码为 Hook 诊断加入内容无关的 `process_elapsed_ms`、stdin 读取、JSON 解析、Store 打开、处理器、stdout 写入和 Store 关闭耗时。未记录 stdin 内容、提示词、工具输入或原始会话 ID。新版打包进程回归 8/8、诊断器回归 5/5；诊断器纳管代码行/分支/函数覆盖均 100%，`tsc --noEmit` 通过。
- 当前 Host 仍读到 Craft Context `.109`，以上阶段计时改动和锁路径改动尚未发布。最新诊断只能说明存在 Craft `PostToolUse` 写失败风险；不能把没有 Hook 名称的 `3s/10s` 提示确定归因给 Craft，也不能证明本地修复已经降低线上错误率。
- 后续 16 个并发同会话 Hook 进程回归，在每次 `PostToolUse` 都生成组件 Trace 时复现 `STORAGE_BUSY` 和信号丢失。最终实现改为用 started/finished 运行回执记录调用、把学习信号按信号 ID 分散写入 Trace 分片；中央 Store 与 Trace 分片的 Hook busy timeout 都保持 750 ms，没有通过延长 SQLite 锁等待解决争用。16/16 信号全部保留，每个进程低于 3 秒。全局提高等待时间的尝试曾使中央库锁回归达到约 3.49 秒，已撤销。
- 最终隔离进程验证：中央 Store 被写锁占用时，UserPromptSubmit 和 PostToolUse 均在 Host 的 3 秒门限内完成；16 个同会话并发 PostToolUse 全部保留信号。最新打包进程样本 P50 1.73 秒、P95/最大值 2.01 秒，距离 3 秒门限仍约 1 秒余量。Bridge、Trace shard 和 Hook timeout helper 的定向覆盖行/分支/函数均为 100%。这是本地隔离数据，不代表 Host 更新后的线上分位数。
- `HookTurnJournal.find` 原先每次都解码最多 10,000 条 `codex_hook_signal` 再按项目/会话/轮次过滤。现改为每个 Trace 分片维护窄的 `hook_signal_lookup` 表，索引复合范围键；信号行与定位行在同一 Trace 写事务内更新，查询只回取命中轮次的记录。首次遇到旧分片时只建空小表，并只从已有 `codex_hook_signal` 类型索引回填，不扫描其他 Trace 正文。分片查询 12 项通过，Trace shard 行/分支/函数覆盖 100%；Bridge+Hookless 65 项通过，Bridge 覆盖 100%。
- 最新打包回归已在此信号定位实现之后完成：Hook 进程 9/9 通过，16 并发 PostToolUse P50 1.73 秒、P95/最大值 2.01 秒；`tsc --noEmit` 和 `git diff --check` 通过。数据仍来自本地隔离测试，没有更新当前 Host `.109`，没有真实 Host 的线上 P95/P99。
- 本次再次只读统计当前安装版 `.109` 最近 24 小时：Craft `context.PostToolUse` 诊断有 850 个 started、847 个 finished、3 个未闭合；已完成耗时 P50 261 ms、P95 1,844 ms、最大 2,085 ms。`Stop` 最大 2,008 ms。`.109` 诊断没有 `process_elapsed_ms` 阶段字段，因而无法拆出模块启动、stdin、Store 和处理器各自耗时。
- 同一 24 小时正式 Trace 的最新版本事件统计：`handle.context.PostToolUse` 507 次 completed、346 次 `STORAGE_BUSY` failed；`SessionStart` 12 次 started 中 5 次 `STORAGE_BUSY`，`SessionEnd` 10 次 started 中 3 次，`Stop` 13 次 started 中 5 次，`UserPromptSubmit` 5 次 started 中 1 次。Runtime 诊断与正式 Trace 尚不能按同一 Hook request ID 一一关联，因此它们证明当前版本有持续写锁争用，但不能直接证明这些失败就是界面上的 3 秒/10 秒超时。
- 当前 10 秒提示仍可能来自全局 DCC `UserPromptSubmit` 或 Craft `Stop`；3 秒提示可能来自 Craft 的 3 秒事件或全局 DCC `SessionStart`/`Stop`。当前 Craft `Stop` 的已完成诊断最高约 2.01 秒，10 秒报错更像其他全局 Hook 或未闭合调用，但没有 Host 带 Hook 名称的逐命令日志，不能唯一归属。
- 2026-10-25 复查最近 24 小时滚动窗口：Craft runtime 回执约有 894 个 `PostToolUse started`、891 个 `finished`；已完成样本 P50 256 ms、P95 1,849 ms、最大 2,085 ms。阶段计时显示 Store 打开 P95 4 ms、处理器 P95 426 ms、最大 1,788 ms；这说明主要延迟在 Hook 处理路径，单看 SQLite 打开不是慢点。旧 `.109` 回执记录的 `error_type=Error` 不能还原具体错误正文，也没有覆盖 Node 模块加载前时间；三个未闭合请求可能是 Host 超时或其它进程终止，不能视为三次已证实超时。
- 同期正式 Trace 最近版本仍记录大量 `STORAGE_BUSY`；runtime 回执与组件 Trace 缺少共同 request ID，无法逐条证明两者对应。故障既可能造成 Hook 失败，也会增加处理延迟；但界面显示的 `3s/10s` 仍不能仅据时长归因给 Craft。当前 Host 仍运行 `.109`，本地分片索引、低锁等待与更细阶段诊断尚未进入该 Host，性能修复需要发布后复测才算生效。
- 全仓增量覆盖门运行 161/163 组通过；失败项为 Codebase LSP stdio 客户端函数覆盖 98.53%，以及 `local-supervisor` 组 19 项测试中 15 项失败。它们不是 Hook 改动的专项门；因此总门仍未通过。以上 Hook 优化仍只存在于未发布源码，真实 Host 仍需更新后复测。

### 2026-10-25 Hook 超时复核与 Codebase 旧快照恢复

- 更正上一轮关于 10 秒提示的判断：当前 Craft Context `Stop` 本身也配置 10 秒，全局 DCC `UserPromptSubmit` 同样为 10 秒；单凭数字不能把 10 秒提示排除为 Craft。3 秒也同时覆盖 Craft 和 DCC 的不同事件，必须结合 Host 的具体事件日志判断。
- 当前 `.109` Hook Runtime 诊断近期开出 1,008 次 `context.PostToolUse`，P50 311 ms、P95 1,873 ms、最大 2,085 ms；404 条记录只有通用 `Error`，另有 3 条 PostToolUse `started` 无 `finished`。这些记录证明 Craft Hook 有失败和被中断风险，但不能单独证明它们就是界面上的超时。已安装包的阶段信息不足；当前未发布源码会记录更多阶段，并对无信号 PostToolUse 在 SQLite 打开前返回。
- Context `SessionStart` 在桥接器内不执行实际能力操作。本地 Hook 加入直接返回并保留 `hook-runtime` 回执的快路径；重建后的隔离打包进程用例 9/9 通过，其中该事件约 336 ms 返回，且诊断为 `outcome=skipped`、`store_open_ms=0`。Host 缓存仍是 `.109`，此变更尚未对真实会话生效。
- Codebase 旧库迁移备份 `quick_check=ok`，23/23 检查点记录键与源库匹配。14 个已迁移检查点的 12,484 个目标文件逐个按大小和 SHA-256 验证通过；剩余 9 个旧快照有 171 个文件与检查点的大小不一致，未发现缺失或多余源文件。目标侧另有 630 个未被数据库指针引用的部分复制文件，源文件和旧指针仍保留。
- 恢复策略现允许从同一规范项目的其他 Workspace 检查点寻找路径、大小和 SHA-256 全匹配的 Peer，并拒绝跨项目 Peer。31 项迁移覆盖组全通过，`codebase-storage-migration.ts` 行/函数/分支覆盖均为 100%；真实重试仍未找到剩余 171 个文件的精确来源，状态保持 14 `current`、9 `legacy_ready`。全局正式库的项目检查点也未发现这些文件的精确副本，因此不能安全晋升这 9 个旧快照。
- 扩大到 `Documents/work`、`project`、`Codex`、`simple` 四个已知树的只读扫描，发现 21 个项目内 `.craft_data` 根、198,122 个文件、4,690,753,382 字节；18 个绑定到明确 Git 根，3 个未绑定，另有 1 个 `EACCES` 导致发现结果不完整。此扫描没有复制、删除或改写源数据；3 个未绑定目录不得猜测归属，访问失败范围也仍需处理。
- 全部迁移数据仍保留在源目录与既有备份中。旧数据总体迁移、统一路径切换、当前 Host Hook 效果、全仓覆盖门和真实自进化效果仍未完成。

### 2026-10-25 旧仓库数据归档迁移执行结果

- 对已绑定到精确 Git 根的 18 个仓库执行只复制归档：198,024 个文件、4,690,725,394 字节。源文件保留；每个目标文件由迁移器校验大小与 SHA-256，并写入项目级及全局备份收据。
- 独立复核再次遍历全部 198,024 个目标文件，确认文件仍存在且大小匹配、源文件仍保留、18 份双位置收据一致；另对每个项目抽样复算一个目标文件 SHA-256。迁移代码本身已逐文件校验哈希。归档不代表能力运行时已切换到这些目录，也不代表旧数据已转换成可直接读取的正式资产。
- 仍有 3 个 `.craft_data` 根无法绑定 Git 项目身份，另有 `net-route/data/runtime` 因 `EACCES` 未能完整扫描。未绑定数据未复制；访问失败意味着发现清单仍可能不完整。Codebase 的 9 个旧检查点仍因 171 个文件与快照清单大小不符而不能恢复。
- Hook 性能修复当前仅在工作区：PostToolUse 的 Hook SQLite 等锁等待由 750ms 降至 100ms、无学习信号事件跳过 Store 初始化、SessionStart 走无 Store 快路径，并将 Hook 写入收据分片。隔离进程与定向测试不能替代发布后 Host 实测；当前 Host 缓存仍为 `.109`。

### 2026-10-26 Hook 超时归属与冷启动优化复核

- Codex UI 的 `hook timed out after 10s/3s` 不包含命令名。当前配置中 Craft Context 的 Stop 为 10 秒、PostToolUse/SessionStart/SessionEnd 为 3 秒；全局 DCC 的 UserPromptSubmit 为 10 秒，SessionStart/Stop 为 3 秒。因此两条提示都不能只凭时长归属给 Craft。正式 Craft 留痕也没有 Host 超时 request ID，尚不能把具体 UI 提示与某条 Craft 运行记录一一对应。
- 只读统计 `~/.craft_data/trace/hook-runtime/v1/`：1,376 条完成记录含 PostToolUse 1,321 次（P50 257ms、P95 1,876ms、最大 2,210ms）、Stop 21 次（最大 2,008ms）；5 个未完成的 started 事件均为 PostToolUse。记录中有 512 条旧版通用 `Error`，诊断字段不足以判定每条原因。可见 Craft PostToolUse 距 3 秒门限较近；没有 Craft Stop 跑到 10 秒的证据。该日志最新时间为 2026-10-25，早于本次改动，不能代表新包 Host 表现。
- 新版 Hook 将纯信号分类拆至轻量模块，并延后加载 Store、CraftService 和完整 Hook Bridge；同时诊断记录增加模块加载及 CraftService 构造耗时。隔离进程空操作对比 `.109` 缓存包 P50 211ms / 最大 266ms，本地新包 P50 141ms / 最大 147ms；6 次有效编辑 Hook 全部完成，端到端 253–437ms，16 路并发 PostToolUse 最大约 1,003ms，信号均保留。
- Hook Bridge、信号分类器、Hook 诊断及进程测试共 67 项通过；相关增量行/分支/函数覆盖均 100%。全量覆盖脚本在沙箱中 163/164 组通过；剩余 `local-supervisor` 因 loopback 权限失败，随后在获批的本机 loopback 下 19/19 通过且覆盖 100%。类型检查、插件打包与 Context/三能力/Codebase MCP smoke 通过。
- 插件 smoke 另测得首次大仓 `craft_context_open`：basic 约 8.1 秒，semantic 约 49.0 秒。这是 Codebase 首次语义索引路径，不是 Hook；本次未优化该索引阶段，也不应把 Hook 的空操作加速误报为完整 Context 性能达标。
- 上述优化仍只在未发布 `.110` 工作区；安装 Host 仍为 `.109`。发布后须用新 Host 回读版本，并把 Hook request ID 与 Host 级超时记录关联，才能判断两类超时是否消失。另需独立优化并测量大仓首次语义索引。
- 全量增量覆盖门最终以允许本地 loopback 集成测试的运行环境完成：164/164 组通过，所有纳管文件行、分支、函数覆盖均为 100%。此前沙箱内的 `local-supervisor` 组因随机 loopback `listen` 被拒绝而失败；提权单组复跑 19/19、三项覆盖均 100%。迁移组在全量运行启动前的旧覆盖结果已过时，使用当前代码单组复跑 12/12、三项覆盖均 100%。

### 2026-10-25 无 Git 根但已有精确项目登记的数据

- 发现旧仓库预检把“必须是 Git 根”当成项目身份前提，超出了项目存储契约。项目身份以规范路径为准，不要求 Git；但无 Git 路径只有在 `~/.craft_data/projects/<name--sha256>/project.json` 已存在且 canonical path、完整 SHA-256 和目录名全部精确匹配时才可绑定。预检只读验证，不会创建或猜测映射；无映射或映射不符仍标为 `unbound`。
- 为上述条件新增预检与失败关闭回归，`legacy-repository-storage-preflight` 组行/分支/函数覆盖均为 100%。复扫后 `eval-all`、`worksheet-system`、`my-craft` 三个既有登记路径转为 ready，各自仍绑定原路径，没有合并子仓库身份。
- 对这三处执行只复制归档：70、22、8 个文件，共 100 个文件、60,756 字节。源文件保留；独立复核全部目标文件的大小与 SHA-256、源文件存在性和项目级/全局收据一致性，全部通过。
- 仍有 `net-route/data/runtime` 因 `EACCES` 未完整扫描；需要再次以可读权限核实此路径下是否隐藏额外 `.craft_data` 根。历史 Codebase 9 个快照问题也未改变。运行时读写切换和 Host `.109` 的发布后实测仍未完成。

### 2026-10-26 `.115` 归档与运行态复核

- 当前 Craft 源码 `main` 为 `c22ab60`（`.115`），Marketplace `main` 为 `5d6c519`。Codex CLI 刷新 Git Marketplace 后读回 Craft Context `0.12.115`；Marketplace、插件缓存和 MCP 入口包 SHA-256 均为 `f678a94c...`。MCP 进程自报 `.115`，但 `host_session_verified=false`，所以只证明当前 MCP 进程的构建身份，不证明另一个 Host 会话已切换。
- 只读旧仓库盘点覆盖 `/Users/didi/Documents/work/my-craft`、`work/other` 和 `/private/tmp`：14 个 `.craft_data` 根中 8 个具有精确项目映射且无符号链接，可安全归档；6 个因项目身份不可用或包含符号链接而阻塞，另有 `net-route/data/runtime` 的 `EACCES` 和一个临时 Codex daemon 目录的 `EPERM` 扫描错误。
- 对 8 个可绑定项目运行幂等归档复制。2 个新来源共 17,016 个文件、98,263,086 字节复制并逐文件 SHA-256 校验；另外 6 个与既有 manifest/目标一致，读回 `already_migrated`。这 8 个来源合计 4,141,023,465 字节（约 3.86 GiB），源目录全部保留。命令退出码 2 是因为 6 个不具身份映射的来源及扫描错误仍被明确阻塞，不是已迁移来源校验失败。该步骤只完成旧数据归档，不代表知识/记忆/索引运行时读取路径已切换，也不授权删除这些源目录。
- 正式 Store 迁移 dry-run 读回 23,535 个物理分区指针均为 `current`、0 个可迁移/阻塞；对 `/tmp/.craft_data/memory` 执行带校验的隔离后，22 个断链均写入 `~/.craft_data/quarantine/legacy-session-memory/v1/` 摘要清单并退役，复扫 0 个残留会话目录，`remaining=0`。这只关闭这 22 个无内容断链，不解决仍存在于其他项目或临时目录的旧数据。
- 当前 MCP 诊断读回：Knowledge 有 64 candidate、189 stale、1 reviewed、53 revalidation_required、仅 1 个 Evaluation Case；Memory 有 10 条反馈但 0 条已验证 helpful；Experience 有 22 条 Observation、0 个 Pattern，且没有本次调用写入 verified observation。三个能力均为 `model_effect_proven=false`，Host session 均未核验，usage measurement unavailable。产物/回执数量不是效果证据。
- 尚未完成：身份不明的 2.96 GB 临时 Codebase 旧目录、6 个 unbound 临时 `.craft_data` 根、`net-route/data/runtime` 权限受限区域、剩余项目存量的运行时切换及停写证明；独立真实会话生成/留出集；Knowledge/Memory/Experience 效果门；Context/Codebase 真实负载性能与五语言独立评测。归档和 MCP 读回不能替代这些验收。

### 2026-10-26 HoH 迭代控制审查与候选评测绑定修复

- 将 XERJ 视为可对照的检索后端，而非替代 Codebase 快照治理或 Knowledge 来源管理；2.7 倍结果来自项目方小样本输出 token 对比，不能外推为 Craft 的综合 token、时延或任务收益。[XERJ 案例](https://github.com/xerj-org/xerj/blob/main/docs/case-studies/reference-coding/CASE_STUDY.md)
- HoH 的独立验收和按小步重规划与 Craft 现有 Workflow DAG、Delivery Evaluation、Harness Topology 及 Continual Harness 设计有较大重合；不新增平行调度器。核对发现 DAG Kernel 的 `verified` 原来只要求任意 `passed + held_out` Evaluation Run，未检查被评测对象、候选版本；`routable` 也可传入一条新评测，未沿用验证时绑定的精确记录。
- 已收紧 `WorkflowDagKernel.transition`：验证阶段要求 Evaluation Run 的 `subject_type/id/version` 精确绑定当前候选 DAG；记录评测 ID/版本和被评测候选版本。进入 `routable` 时只读取这一条冻结的评测版本并复核绑定，不允许替换评测。新增成功、失败、错范围、错版本、评测后记录更新及改绑拒绝用例。
- `tests/workflow-dag-coverage.test.ts` 与 `tests/agent-foundation.test.ts` 共 9/9 通过；对 `core/workflow-dag.ts` 单文件执行行、分支、函数覆盖均为 100%；`node node_modules/typescript/bin/tsc --noEmit` 通过。`pnpm exec` 包装因 pnpm 11 无交互环境尝试重建依赖目录而中止，使用现有 `node_modules/.bin/c8` 直接执行了同一覆盖门。尚未运行全仓增量覆盖门，也尚未发布。
- 当前 `.115` MCP 进程的范围诊断仍为 `host_session_verified=false`：Knowledge 64 candidate、190 stale、1 reviewed、53 revalidation_required、1 Evaluation Case；Memory 10 条反馈中 0 条已验证 helpful；Experience 22 observations、0 patterns、0 draft proposal、0 shadow experiment。三项的 `model_effect_proven` 都是 `false`，无可用 usage measurement。
- 本轮 `craft_context_open` 用 1,000 token 响应预算耗时约 11.3 秒，Knowledge/Experience 均未命中，只返回一个 Codebase 文件引用；索引报告 `partial`、99 条预算省略、1,638 条查询省略，分析置信度为 partial。响应估算 891 token，材料估算 281 token（估算值，不是 Host 实测）。并发调用 `craft_codebase_repository_ensure(index_depth=semantic)` 返回 `database is locked`；这次并发检查不能单独证明生产负载故障，但再次说明启动、索引和共享 SQLite 的竞争需要作为发布门测试。
- 本地补上的是通用候选评测绑定，不等同于 HoH 风格的完整多轮控制面，也不证明自动候选生成、正式晋升或收益。仍须完成全量数据路径切换、独立真实留出样本、真实 Host Trace 和效果反馈、并发及性能门、全语言 Codebase 评测及最终发布验收。

### 2026-10-26 MCP SQLite busy 留痕补强

- 本轮新请求中，`craft_context_open`（含 `include_codebase:false`）及 `craft_codebase_repository_ensure(index_depth=semantic)` 都出现 SQLite `database is locked`；MCP 结构化回执为 `ERR_SQLITE_ERROR`、stage `dispatch`、details 空，无法通过该请求读回组件诊断。不能据此区分 Store 初始化、Trace 写入或并发事务哪个阶段占锁。
- `~/.craft_data/db/craft.db` 约 6.1 GiB，WAL 约 15 MiB；只读 `lsof` 在采样时看到 10 个 Node 进程持有该数据库文件句柄，均以 Marketplace `.115` 插件缓存为工作目录。Knowledge/Experience/Trace-retention 锁文件中的 PID 也持有同库句柄，但进程枚举命令被系统限制，无法检查每个进程参数或将某次 busy 错误对应到具体调用方。进程数证明共享数据访问并发存在，不证明哪一个进程造成锁。
- Store 启动扫描的 7 类内容引用记录共 5,876 个版本、约 6.0 MiB；因此不能仅凭主数据库 6.1 GiB 推断启动时会全表读取全部历史正文。`trace` 和 `trace_event` 分别约 597,666 与 442,438 行，历史 Trace 规模仍需单独纳入存储/保留性能测量。
- 修复 MCP `safeFailure` 的结构化错误分类：原生 `ERR_SQLITE_ERROR` 仅在公共分类器判定为 locked/busy 时映射 `STORAGE_BUSY`，非 busy 的 SQLite 错误保留原分类；响应不额外复制错误消息到 `details`。通过真实 MCP `tools/call` 测试分别覆盖 locked 与非 busy SQL 错误。`tests/mcp.test.ts` 19/19、`workflow-dag` 与 `agent-foundation` 9/9；`workflow-dag.ts` 行/分支/函数覆盖均 100%；MCP 新增诊断行的语句与分支均命中，类型检查、文档链接检查及 `git diff --check` 通过。MCP 整个模块定向测试覆盖为行 85.53%、分支 90.78%、函数 93.33%，该数字不是增量覆盖率；全仓增量覆盖门尚未运行。
- 错误类别补强提升可聚合性，但没有修复锁争用本身。还需用 Host 带关联 ID 的 Trace 区分 SQLite 打开、Hook、Trace 记录和业务写入阶段，并在固定版本下进行多 Host 并发读写与延迟测试；当前仍未发布，真实 Host 的 lock failure 率没有变化证据。

### 2026-10-26 当前 MCP Context 与能力读回

- 当前对话实际可调用的 Craft MCP 自报 `0.12.115`，数据根为 `~/.craft_data`，内容语言为 `zh-CN`；入口哈希为 `f678a94c...`。诊断只验证了这个 MCP 进程可响应，`host_session_verified=false`，不能证明用户另一个 Host 会话已加载同一包。
- 针对本仓库的首次 `craft_context_open` 约 10.5 秒，估算响应 879/900 token，返回 1 个 Codebase 符号引用、Knowledge/Experience 零命中；Codebase 为 `partial`，有 99 条预算省略、1,516 条查询省略及不支持文件分析。相同查询热调用约 1.45 秒，仍为 `partial`，返回 1 个符号引用、257 条查询省略。跳过 Codebase 的热调用约 442 ms，结果为空且 `pack_status=ready`。这些是本对话的单机 MCP 时延样本，不是 Host Hook P95/P99 或并发基准。
- 将响应预算降到 500 token 时，MCP 明确返回 `Compact Context response exceeds estimated token budget (679/500)`，没有静默截断；`task_kind=planning` 则被输入校验拒绝，属于无效参数探测，不计入成功时延样本。
- 同期能力诊断：Knowledge 有 64 candidate、190 stale、53 revalidation_required、1 条评测用例；Memory 有 10 条反馈、0 条已验证 helpful；Experience 有 22 条 observation、0 个 pattern、0 个 shadow experiment。三项均 `model_effect_proven=false`，usage measurement unavailable。没有触发模型调用或候选生成，因此这次仅证明当前 MCP 的诊断与 Context 返回行为，不证明自进化收益。
- 下一步应分别测量真正 Host Hook 的端到端冷/热时延和请求关联 Trace，再对 Codebase 检索省略率及 Context 空包率做真实任务评测；不能把跳过 Codebase 的快速空包当作有效检索。

### 2026-10-26 Codebase Context 投影复用与 SQLite 锁错误复核

- 同一 MCP 进程的成功 Trace 已能按阶段核算：跳过 Codebase 的一次调用总计约 717 ms，其中 Knowledge/Memory 检索约 214 ms、Context resolve 539 ms；含 Codebase 的一次调用总计约 1,760 ms，其中仓库索引复用 369 ms、Codebase Context 投影 792 ms、Knowledge/Memory 检索 211 ms、Context resolve 484 ms。Trace 事件只含操作名和阶段耗时，没有记录提示词正文。两条均为单次样本，不能作为分位数。
- 投影 Trace 指向明确热点：`codeContextCandidates` 每次都新建完整 `CodeSymbolSearchIndex`，再对全部候选排序。现将查询索引加入 `CodebaseIndexKernel` 单项缓存，键绑定不可变 `index.id + graph_digest`；图仍先经 `loadGraph` 校验完整性。缓存只在当前进程保留一个图，避免跨项目累积。检索顺序、候选和预算未变。
- Context/Codebase 真实调用函数级合成基准使用 8,000 个符号、16,000 条关系，热身后 P50：每次重建检索索引 830.5 ms、复用索引 27.4 ms，约 30.34 倍；两路径输出完全一致。此基准只隔离测量索引构建复用，不等同真实仓库端到端或多进程负载收益。
- 相关覆盖门组通过：Context remediation 491/491，Codebase 232/232；两个组纳管文件行/分支/函数覆盖均为 100%。`tsc --noEmit` 与 `git diff --check` 通过。全仓其他门未在本轮重跑。
- 用户另报告项目 `/Users/didi/Documents/project/inte/fitan` 的 `craft_context_open` 返回 `database is locked`，未提供该调用的 request/Trace ID。该文本确认一次请求失败，但无法区分中央 Store、项目 Codebase 数据库或其他事务阶段，也不能量化影响范围。本轮随后当前 MCP 的 `craft_info`（322 ms）和本仓 Context 调用都成功，说明未见持续性全局不可用；不证明其它服务或并发写入无失败。锁竞争仍需将 Host 请求 ID 与 SQLite 阶段及具体数据库文件关联后才能确认根因。
- 按用户给出的同一 Fitan 参数单次重试成功，4.34 秒；随后热调用也成功，2.80 秒。两次都返回 `pack_status=partial`，原因为文件省略、预算耗尽、查询截断。对应 Trace 中 Codebase ensure 分别约 1,060/451 ms，Context projection 约 2,245/1,662 ms，Context resolve 约 608/469 ms；两次均未记录 `STORAGE_BUSY`。这证明当前没有持续锁住该请求路径，但不推翻先前一次锁失败；热路径投影仍慢，且它运行于未含本轮缓存改动的 `.115` 包。
- 缓存改动尚未进入 Marketplace 新包或 Host；锁错误也未修复。发布后须在真实 Host/多进程负载下核对锁失败率、Hook 完整信号率和 P95/P99，不能以合成检索基准推断线上收益。

### 2026-10-26 Context 回执重放与共享库锁影响

- 本轮按 Skill 打开 Craft 仓库上下文时，MCP 再次返回 `ERR_SQLITE_ERROR`、stage `dispatch`、`details={}`，实际耗时超过 30 秒后失败。错误发生在 Context 打开路径，但没有阶段 Trace，无法判断具体哪个 SQL 写事务或哪个进程持锁。只读 `lsof` 看到 12 个 Node 进程同时打开 `~/.craft_data/db/craft.db`（约 6.1 GiB，WAL 约 16 MiB）；`ps` 被系统拒绝，`lsof` 也不能识别其中哪一个进程正持有写锁。
- Craft 的 MCP 进程共享这个中央 SQLite 文件。WAL 允许并发读取，但同一数据库同一时间只能有一个写事务；同库服务在写事务期间仍可读，任何需要写中央库的服务可能等待或在忙超时后报错。独立 Codebase 分片库或其他不使用此中央库的服务不受这把锁直接影响。测试 Fixture 使用临时数据根，代码编辑本身不会锁正式数据库；本机存在多个共享正式库的 Host/worker 进程，是比“正在改代码”更直接的竞争条件。当前证据不支持“所有其他服务都不可用”，但已足以确认同库写服务存在间歇性可用性风险。
- 本地为不可变 Context Resolution、Working Set 和最终 Pack 回执增加已有记录的只读重放分支，避免重复读取时进入 `BEGIN IMMEDIATE`；首次创建仍需事务，Codebase 重索引及 Knowledge 来源发现也可能写数据，因此它不能修复所有锁错误。新增临时库回归：先生成回执，再由第二连接持有 `BEGIN IMMEDIATE`，重复打开仍成功并复用相同 Pack 回执。Context remediation 84/84，`context-working-set.ts` 行/分支/函数覆盖均 100%。
- 补上显式 ID 冲突、Context Resolution 并发创建、Working Set 并发创建、Pack Receipt 并发创建四条隔离竞态用例后，Context Resolution 覆盖组 377/377 且 `context-resolution.ts` 行/分支/函数 100%；`repository-context-products` 覆盖组 194/194 且纳管文件行/分支/函数 100%。`context-remediation.test.ts` 31/31，`context-working-set.ts` 行/分支/函数 100%；`tsc --noEmit`、文档链接检查和 `git diff --check` 通过。`pnpm exec tsc` 曾触发 pnpm workspace 安装，网络不可用后中止，后续改用仓库现有 `node_modules/.bin/tsc --noEmit -p tsconfig.json`。以上源码和测试尚未发布，当前 `.115` Runtime 行为没有改变。
- 因此对“开发中其他服务是否不能用”的准确回答是：不会普遍停服；同一 `craft.db` 上的写服务会受 SQLite 单写者约束，用户这次遇到的 `craft_context_open` 失败及本轮 MCP 再现证明它已造成真实请求失败。下一步应为首次写入/索引/Source discovery 继续拆分写路径或分片，并让 busy 错误回执标记具体数据库、阶段、等待时长及请求 ID；在正式库多进程压力测试和固定版 Host 复验前，不能宣称争锁已解决。

### 2026-10-26 SQLite 写锁诊断阶段留痕

- `CraftStore.transaction()` 与分区 `transactionOn()` 遇到 SQLite busy/locked 时，现保留原始错误码并附加白名单诊断：`stage=storage_lock`、数据库角色（`primary`/`capability_partition`）、失败阶段（事务开始、保存点开始或事务操作）、该连接的 `busy_timeout_ms` 和 `retryable=true`。不写 SQL 文本、绝对路径或用户内容；MCP `safeFailure` 会保留这些安全字段。该改动让下一次 Host 请求能从泛化 `dispatch` 进一步区分存储锁阶段，但还没有真实 `.115` Host 读回证据。
- 加入真实 SQLite 连接锁定与异常注入回归，覆盖主库和分区库事务开始、嵌套保存点、无错误消息的 SQLite 错误，以及忙错误上已有安全诊断时的保留行为。MCP 回归验证该诊断能传到结构化失败回执。
- 验收：`store-atomicity` 组 392/392，通过 `store.ts` 行、分支、函数覆盖各 100%；`context-remediation` 31/31、`mcp` 19/19 与新增存储锁场景用例通过；`tsc --noEmit`、Core 构建、Standalone common packages 构建、MCP bundle 构建及最终 diff 检查通过。
- 这只提升故障可定位性，不消除 SQLite 单写者竞争，也不表明其他 Craft 服务在所有时段可用。当前运行时仍是 `.115`；未做正式库压力写入、Host 多进程 P95/P99、数据迁移或发布验证。

### 2026-10-26 新增自进化控制面验收要求

- 后续改造须采用追加式进化轨迹和版本化产物，记录目标、触发原因、范围、Host 会话、代码快照、候选版本、评测来源、证据、决策、成本/时延和使用反馈；固定状态流转为 Observe → Retrieve → Act → Feedback → Attribute → Candidate → Evaluate → Promote/Reject/Rollback → Replan。
- 失败归因需区分环境、检索/路由、执行、流程和评测故障；环境故障不应触发能力产物修改。Experience、Knowledge、Memory、Context、Codebase 各自按用户给出的演进边界实现；本轮不修改 Skill。
- 评测需结合固定回归、历史失败、成功样例和生成来源隔离的留出任务；模型判官只作辅助。发布候选需绑定隔离工作区和基线快照，限制改写范围/次数/预算，切换时保留用户改动；评测异常或失败不得晋升。
- 本节是新增验收合同，不代表控制面、留出集、安全发布或回滚能力已完成。下一步需盘点现有 `verified_iteration`、`iteration_attempt`、Evaluation/Promotion、Work Loop 与 Experience 状态模型的覆盖和缺口，再把这些要求映射到可验收实现，避免平行新建重复调度器。

### 2026-10-26 Verified Iteration 评测消费与原子结算

- 现有 `verified_iteration` 已限制重试次数、路径和失败分类；环境/评测配置错误走阻塞交接，范围违规与无进展停止重试。此前一次 assessment 可重复用于多个 attempt，且 attempt 插入与 iteration 状态更新不是同一事务。
- 将 assessment 结算提取到 `core/application/use-cases/verified-iteration.ts`：终态读取先走只读路径，活动态在单一事务内重读、校验冻结的 Acceptance Plan 版本及摘要、拒绝重复消费相同 assessment，再追加 attempt 并更新 iteration。Attempt 绑定 assessment ID/版本/摘要、plan 版本以及 Work Launch 版本/摘要；事务失败时两项写入一起回滚。
- 回归覆盖同一 assessment 重用拒绝、plan 改版拒绝、环境与验证配置交接、范围/无进展停止、尝试预算、成功终态、事务中途故障回滚，以及观察后状态改变的竞态。`verified-iteration` 新覆盖门 1/1 测试通过；Use Case 行/分支/函数均 100%。
- 这仍不是完整的进化控制面：Work Launch 摘要绑定的是任务运行配置，不是实际 Git/Workspace 代码快照；当前记录也未统一采集模型 token/成本、端到端延迟、候选产物版本、发布回滚和实际使用反馈。独立留出评测仍需绑定生成来源并在真实 Host 任务中验收。

### 2026-10-26 统一进化轨迹首个实现

- 新增 `EvolutionCycleKernel` 和三个 MCP 操作：`craft_evolution_cycle_start/advance/get`。它是跨能力的追加式控制记录，不替代已有 `verified_iteration` 重试调度器，也不直接改写 Experience、Knowledge、Memory 或 Codebase 的正式状态。
- 周期状态按项目写入 `~/.craft_data/projects/<项目名--路径哈希>/evolution/evolution.db`；主库只保留分区指针和事件事务。无项目范围或项目根未注册时拒绝写入。
- `start` 要求真实存在的活动 Host 会话、与 workspace 根路径一致的项目身份、该 workspace 最新代码检查点，以及带版本的触发引用。快照绑定项目路径摘要、分支、revision、工作区摘要和源文件摘要；不把绝对项目路径放进回执。每次 `advance` 使用乐观版本校验，引用均解析为精确资产版本。
- 事件记录附前序摘要和事件摘要；读取时验证事件顺序、周期 ID、事件摘要和周期头。模型 token、耗时和成本为可选非负指标；原因只保存摘要。环境故障归因强制转入 `replan`，并在下一次 `observe` 前清除环境分类。
- `Knowledge` 留出评测引用必须绑定确切候选版本，且评测记录需来自候选影子评测；系统重新验证案例的独立来源、脱敏状态、已完成审定和逐案例评测结果。晋升事件仍只记录能力治理系统提供的精确授权引用，不授予通用控制面晋升权。
- 新增 11 项状态流转、竞态、评测来源、分区边界、篡改与拒绝路径测试。`evolution-cycle` 增量覆盖门通过：11/11，`core/evolution-cycle.ts` 行/分支/函数覆盖均为 100%；扩展 Store 原子性组通过 403/403，纳管 `store.ts` 行/分支/函数覆盖均为 100%；MCP/Agent foundation 25/25，直接 TypeScript 检查和 `git diff --check` 通过。`pnpm run typecheck` 因 pnpm 试图访问不可达的 registry 并要求清理 modules 而中止；改用已安装 TypeScript 直接执行 `node node_modules/typescript/bin/tsc --noEmit` 成功。
- 这些测试使用临时数据根；Knowledge 审定夹具使用测试合成 Trace。它们证明数据契约和拒绝逻辑，不证明真实 Host 曾跑完整闭环或产物提升有效。主库事件事务仍需评估并发成本；全量覆盖门、候选隔离工作区、固定/历史/成功/留出任务集、真实候选生成、发布前基线复核、原子晋升/回滚、实际使用反馈、正式库迁移与 Host 性能分位数仍未完成。工作区保持 dirty，未提交、未推送、未安装或重启 Host。
- 本轮只读查询活动 MCP：Host 报告版本 `0.12.115`、data root 为 `~/.craft_data`、语言 `zh-CN`；已注册工具列表不含新建的 Evolution Cycle API。故真实 Host 尚未执行本轮代码，也未产生真实 Evolution Cycle 记录。当前 `main` 与 `origin/main` 仍为 `c22ab60134a3a6f38642b7a79667d152a552340e`；本轮没有提交或推送。
- 后续复核发现晋升门控允许 `evaluation_run.verdict=failed` 的候选继续记为 `promote`。现已在记录晋升事件前重新校验 exact candidate 的留出评测：普通评测要求 run 与所有 trial outcome 均通过；Knowledge 影子评测要求状态为 `eligible`。失败评测仍可进入拒绝路径，但晋升被拒绝。新增回归后 Evolution Cycle 为 12/12；该模块行/分支/函数覆盖仍为 100%，直接 TypeScript 检查通过。此补丁仍只在本地源码，未进入运行时。
- 并发只读核对发现 13 个 Node 进程同时打开 `~/.craft_data/db/craft.db`（约 6.1 GB，WAL 约 15 MB），与用户观察到的 `database is locked` 一致，表明共享主库写入存在竞争。`lsof` 可见 PID 和 Node 进程名，但当前工具权限不允许读取父进程关系及完整命令行，因此无法据此归因到具体 Hook 或服务；Evolution Cycle 的事件仍落在主库，这个分区实现尚未消除主库写锁竞争。没有重启进程或写入正式库。
- 随后将 Evolution Cycle 的当前版本与追加事件一并迁到项目级 `evolution.db` 事务；中央库保留启动指针以支持发现和路由。版本推进带乐观版本校验，事件序列与幂等键在同一项目写锁内检查。增加同项目写竞争、跨项目锁隔离、重复请求和冲突重试覆盖。Storage 严格门禁现为 407/407，`store.ts` 行/分支/函数覆盖 100%；Evolution Cycle 为 15/15，`core/evolution-cycle.ts` 行/分支/函数覆盖 100%；直接 TypeScript 检查和 `git diff --check` 通过。
- 这只降低 Evolution Cycle 写路径对共享主库写锁的依赖，没有消除主库竞争：其他能力仍使用主库索引，且上次只读检查的 13 个 Node 持有者无法可靠映射到具体 Hook。写锁错误现在附带不含业务正文的数据库角色、阶段、等待上限和可重试标记；还没有从真实超时 Hook 留痕反查其具体调用进程。未向正式数据根写入、未重启服务。
- 晋升前现在会再次读取周期绑定的 Workspace 与检查点，要求 Workspace 版本、最新检查点 ID 及检查点版本仍与周期基线一致；原检查点即使原位改版也会被识别。基线漂移时拒绝晋升且不追加事件，要求重规划和重评。Evolution Cycle 专项测试 16/16，`core/evolution-cycle.ts` 行/分支/函数覆盖 100%；此改动仍在本地源码，尚未加载到 Host。
- 统一轨迹的每个事件现在固定带 `input_tokens`、`output_tokens`、`duration_ms`、`cost_usd` 四项；没有测量值时存 `null` 而不省略或伪记为零。该改动只消除记录形状歧义，仍需由真实 Host/模型调用方提交实测值，并报告来源、缺失率与聚合延迟；不代表现有轨迹已经收集到真实成本。
- 对照 2026-10-26 提交的五项进化控制要求，追加轨迹、状态约束、失败归因字段、候选确切版本引用、独立留出评测及基线漂移拒绝已有代码证据。尚未实现或验证的部分包括：控制面自动接入真实任务闭环；Experience/Knowledge/Memory/Codebase 各自候选与正式状态的原子切换和可执行回滚；隔离候选工作区及保留未提交改动；会话级修改/成本预算；固定回归集与留出集的统一报告。当前能力授权引用只记录晋升依据，不等于跨子能力发布器已完成。
- 2026-10-26 当日复核把锁源定位到 Craft Context：当前 13 个持有 `~/.craft_data/db/craft.db` 的 Node 进程工作目录均为 Codex 插件缓存 `craft-context/0.12.115`。`ps` 仍因系统权限被拒；无需依赖命令行参数即可从工作目录确认这些是 Craft Context 插件进程。全局 PII Hook 配置为 5 秒；Craft Context Codex Hook 配置为 `PostToolUse=3s`、`Stop=10s`、`UserPromptSubmit=20s`，SessionStart/SessionEnd 为 3 秒。
- 只读汇总 `~/.craft_data/trace/hook-runtime/v1/*.jsonl`：Context `PostToolUse` 有 3,205 个开始、3,200 个完成，5 个开始无结束记录且采样时都已超过 20 秒；完成记录 P50/P95/最大耗时 65/1,822/2,210 ms。开始无结束与 3 秒 Host 超时一致，但也可能是进程异常退出，日志没有 Host 提供的终止原因。`UserPromptSubmit` 64 次中 16 次标为 `STORAGE_BUSY`（P95 2,180 ms、最大 2,498 ms）；`Stop` 86 次中 20 次 `STORAGE_BUSY`（最大 2,008 ms）；`SessionEnd` 37 次中 5 次 `STORAGE_BUSY`（最大 1,883 ms）。近期 Hook Runtime 中没有超过 10 秒的 Stop 未完成记录，因此当前数据没有证实用户看到的 10 秒超时来自 Stop。
- Trace 分片里的历史遥测另显示 `craft_context_open` 有 22 次 `STORAGE_BUSY`，P50/P95/最大耗时 16.3/36.6/43.6 秒；Knowledge `sourceIngest` 有 152 次 `STORAGE_BUSY`，P50/P95/最大耗时 31.6/33.1/34.9 秒，另有 312 次 `OPERATION_FAILED`。这些是历史累计事件，不能与上面的当日 Hook Runtime 计数混为一组。Trace 只存错误摘要，原有 Hook Runtime 只存 `STORAGE_BUSY` 类别，旧记录无法追溯数据库角色和事务阶段。
- 新增的安全诊断会在后续 Trace 和 Hook Runtime 记录白名单 `database_role`、`database_phase`、`busy_timeout_ms` 和 `retryable`，错误正文、路径及 SQL 不落盘。`common-log-sdk` 覆盖门 52/52、行/分支/函数 100%；`hook-runtime-diagnostics` 7/7、行/分支/函数 100%；直接 TypeScript 检查通过。当前运行时仍为 `.115`，因此这些新字段尚未在真实 Host 中读回，主库锁竞争也尚未消除。

### 2026-10-27 Evolution Cycle 轨迹与基线门控

- 当前 MCP 只读读回仍是 `0.12.115`，数据根 `~/.craft_data`、语言 `zh-CN`；`host_session_verified=false`。Knowledge 64 候选/191 stale/53 revalidation_required/1 评测案例；Memory 10 条反馈、0 条 verified helpful；Experience 22 observations、0 patterns、0 shadow experiments。三者 `model_effect_proven=false`。这些是当前组件状态，不是本地新源码的运行证据。
- 为避免把“字段缺失”误读成成本为零，Evolution Cycle 每条事件固定包含输入 token、输出 token、耗时与成本四项；未采集时保存 `null`。真实 Host/模型调用目前尚未向控制面持续提交这些指标，仍缺指标来源绑定与缺失率报告。
- 晋升前重新核对周期开始时的 Workspace 版本、最新检查点 ID 和原检查点版本；基线变化时拒绝晋升，且不写决策事件。这里绑定的是未改动的基线 Workspace；候选隔离工作区及原子发布器仍未实现。
- Evolution Cycle 专项测试 17/17；`core/evolution-cycle.ts` 行/分支/函数覆盖均 100%；直接 TypeScript 检查与 `git diff --check` 通过。源码仍在 `main` 的本地 dirty worktree（33 个改动路径），未提交、未推送、未安装；Host 仍为 `.115`。
- `craft_evolution_cycle_advance` 新增可选 `trace_refs`：指标可从明确引用的 `trace_event` 汇总，事件必须为 `observed`/`verified` 且所属 Trace 的 `task_id` 与周期任务一致；不接受同一事件同时手填与引用 Trace 指标。每项缺失仍为 `null`，手填值会标 `caller_reported`，不冒充 Trace 来源。17 项 Evolution Cycle 与 19 项 MCP 测试合计 36/36 通过；受影响源码行/分支/函数覆盖 100%。这是基于当前存储信任标签的来源绑定，Host 签名和自动从真实 Worker 传入 Trace 引用仍未实现。
- 尚未关闭的五项要求包括：把 Evolution Cycle 自动连接到 Host 任务收尾；让各能力在自身治理边界内原子发布/回滚正式版本；隔离候选且保留已有未提交文件；在真实工作流中执行回归/失败/成功/留出数据集；落实会话次数与成本预算。Skill 本轮未修改。
- 2026-10-27 后续收口：候选创建、held-out 评测和晋升均重新校验周期基线未变化；候选证据引用必须是 Evidence；普通评测与 Knowledge 留出案例还会拒绝与候选 Evidence 已记录的来源任务/会话重叠。无来源身份的 Evidence 不会被补造身份。新增快照漂移和候选来源重叠回归后，Evolution Cycle 为 22/22；`core/evolution-cycle.ts` 行/分支/函数覆盖均 100%，`tsc --noEmit` 与 `git diff --check` 通过。
- 本次实时只读 `craft_info` 仍读回 Host `0.12.115`、数据根 `~/.craft_data`、语言 `zh-CN`；该运行时没有新 Evolution Cycle 接口/记录，不能验证本地改动已运行。评测留出仍依赖当前可写存储中的 Evidence/Outcome 来源标记，不是签名来源证明；候选沙箱、统一原子发布/回滚、真实独立效果集、正式数据迁移和 Host 负载分位数仍未完成。

### 2026-10-27 Context 冷热调用和 Codebase 图缓存

- 实时 MCP `craft_info` 仍报告 `0.12.115`、数据根 `~/.craft_data`、语言 `zh-CN`。本轮 `craft_context_open` 首次重试超过 30 秒后返回 `database is locked`；后续一次失败实际是 Compact 响应估算 560/500 超预算，并非锁；将响应上限调到 700 后，不含 Codebase 的调用约 2 秒成功。之后含 basic Codebase 的冷调用约 20.4 秒，热调用约 3.3 秒，均没有再次报锁。工具回执 `host_execution_authority=false`，属于 MCP 组件调用，不能算真实 Host 任务证据；锁错误也未携带数据库角色/阶段，根因仍未定位。
- 该仓库实时索引为 5,510 节点、0 条关系、`analysis_confidence=partial`。冷调用返回 `codebase_analyzer_unsupported_files`、`codebase_budget_exhausted`、`codebase_query_truncated`；上下文预算省略 99 项、查询截断 1,901 项。索引状态为 ready 不代表选材完整，当前该仓库 Basic Codebase 也没有任何关系边。
- 本地 Codebase Context 投影现在对已完整校验的不可变图保留单条进程内缓存，键含索引 ID、版本及图摘要；最多缓存 8,000 个节点和 16,000 条边，超限图不保留。缓存不跨项目累积，不改变候选排序或 Context 预算；索引新版本会自然失效。完整 `craft-codebase` 覆盖组 233/233，`codebase-index.ts` 行/分支/函数覆盖均 100%，直接 `tsc --noEmit` 通过。
- 缓存只在本地 dirty 源码。Host 仍加载 `.115`，因此 3.3 秒是旧运行时热调用数据，不是新缓存收益；需固定版本发布并由新 Host 重读后再测冷/热延迟和并发 P95/P99。此次 Codebase 冷调用虽消除了后续锁报错，但仍耗时约 20.4 秒且返回部分结果；不能据此宣称初始化性能达标。

### 2026-10-27 候选写入范围与冻结

- `craft_evolution_cycle_start` 接收可选相对路径白名单 `allowed_paths`；未设置时默认不允许候选工作区发生修改。候选、评测和晋升阶段重新扫描隔离副本，拒绝越界路径、符号链接和非普通文件，并把文件清单摘要写入候选事件。
- 评测及晋升前均重新核对候选摘要；候选在冻结后发生改动必须重建候选并重跑评测。候选树扫描最多检查 10,000 个文件，避免目录规模无限放大。
- 候选工作区、Evolution Cycle 增量测试均通过；对应两个源码文件行/分支/函数覆盖率 100%，直接 TypeScript 检查与 `git diff --check` 通过。覆盖测试使用临时数据根，不等同于真实 Host 执行。
- 这仍未把 Host 执行重定向到候选工作区，也未限制跨多个 Cycle 的会话写入次数或模型预算；这些限制需 Host 调度层的授权、写入回执和实际 Trace 一起实施，不能由本地周期记录单独保证。原子晋升/回滚和真实独立任务效果仍未验收。
- 追加基线校验：Cycle 启动和晋升前调用 `WorkspaceState.freshness`，直接比对检查点与当前项目文件及 Git 状态；候选和评测阶段只核对不可变检查点身份，避免在每个阶段重复扫描项目并启动 Git 子进程。新增“检查点后用户修改文件”启动拒绝及晋升前拒绝用例；Evolution Cycle 27/27 通过，`evolution-cycle.ts` 行/分支/函数覆盖 100%。性能分位数仍未测量。

### 2026-10-27 Knowledge 迁移盘点响应

- `~/.craft_data` 只读预检：25,108 条已有分区指针均指向当前路径；Knowledge Claim 另有 296 个未分区版本（scope 前缀 `project` 137、`legacy` 159）。这不等同于 296 个当前有效 Claim。
- 运行时 Knowledge 迁移 dry-run 的首 500 条：76 可迁移、242 跳过、182 因范围不可解析阻塞，单页返回约 38 KB。后台 Worker 实际只使用阻塞数量，却接收并回传逐记录明细。
- 为迁移 API 和 Worker 增加 `summary_only`：保留原逐条模式；汇总模式返回 `blocked_count` 与按原因分组的 `blocked_reasons`，不返回记录 ID。Worker 请求汇总模式并校验计数，减少每页响应体。
- 以上迁移盘点为只读；尚未应用迁移。当前 Host 版本不支持新参数，本地改动未推送。阻塞记录的可靠范围仍未明确，不能自动归全局或猜项目根。

### 2026-10-27 Store 覆盖与实时锁复核

- Knowledge 存储新增 `summary_only` 类型拒绝分支的直接 Store 断言后，Store 原子性覆盖组 419/419 通过，`store.ts` 行、分支、函数覆盖均为 100%；`tsc --noEmit` 和 `git diff --check` 通过。
- 实时 `craft_context_open`（明确关闭 Codebase）首次返回 `database is locked`，约 16 秒后失败；同参数单次重试约 0.6 秒成功，返回 `resolved/ready` 但 0 个知识/经验条目，`host_execution_authority=false`，并留下 Context Receipt 与 Trace 相关 ID。这是间歇性锁证据，不是任务效果证据。
- 对成功重试的 Trace 分片做只读回读：`craft_context_open` 端到端 Span 494ms，Context resolve 415ms，Memory contribute 125ms，Knowledge contribute 126ms（其中项目 Source discovery 21ms），Experience contribute 3.6ms；没有模型 usage/token 字段。单次低延迟不构成 P95/P99 或并发稳定性证明。
- 单独用只读连接打开 `~/.craft_data/db/craft.db`、读取 `journal_mode`/`busy_timeout` 和查询 `sqlite_master`，分别约 2ms/2ms 成功。之前把完整 `PRAGMA quick_check` 放在同一个输出表达式里并将超过 30 秒误记为数据库打开卡住；该结论已撤回，未再执行完整性扫描。
- `craft_info` 约 0.2 秒读回 Host `0.12.115` 与 `~/.craft_data`。`lsof` 观察到 PID 5585（node）的工作目录是已安装的 Craft Context `.115`，并打开全局 `craft.db` 及约 65 个 `.db` 主文件/其 WAL 与 SHM；这确认了 Craft Context 进程持有许多分区连接，但沙箱拒绝 `ps`/`sample`，无法确认具体被锁的数据库、持锁事务及调用栈。不能据此断言其他服务不可用或认定根因。
- 进一步按全局 `craft.db` 文件句柄去重，观察到 13 个不同 PID，工作目录全部是 Craft Context `.115` 插件缓存；它们共享同一全局 SQLite 文件。`~/.craft_data/runtime` 的跨进程 Worker 锁显示 Knowledge/Experience 由 PID 57584 持有，Experience 资产迁移由 57624 持有，Trace retention 由 35270 持有；因此有 Worker leader 机制，不能把问题直接归咎为 13 份重复学习 Worker。
- 用独立临时数据根启动 13 个 Node 进程，各自打开同一全新 Craft Store 并写 5 条记录：13/13 成功，整体约 1.2 秒，进程总时长 P95/max 247ms；没有复现锁。该数据集是空库，不代表正式库或长事务性能，不能据此排除真实库的竞争。
- 本地锁诊断已能在 Store 写事务错误中记录数据库角色、阶段和等待时长，但当前运行时错误仍只有通用文本；这次实时锁没有数据库角色/阶段证据，不能用本地改动声称已修复。需在可识别运行进程/事务来源后，再验证修复与并发影响。

### 2026-10-27 Codebase 冷语义索引剖析

- 当前工作树 Codebase 覆盖组 237/237 通过，`codebase-index.ts` 行/分支/函数覆盖均为 100%。新增行为用例覆盖小文件跨路径分片后仍可按路径查符号、跨文件查调用者，并确保修改某文件不会使其他路径的内容寻址分片全部失效；已校验源码复用也覆盖越界路径、重复路径、摘要漂移和 checkpoint 大小漂移。
- 原打包 smoke 的当前仓库 `craft_context_open(index_depth=semantic)` 单次耗时 32.3 秒。基于分片写入批处理并重新打包后，同 smoke 单次为 29.9 秒；只有一次前后样本，差值约 7.5%，不能当成稳定收益或 P95。
- 同一工作树的独立临时数据根剖析：`repositoryFiles` 选出 988 个文件、其中 976 个受支持；TypeScript 分析 955 个文件约 7.8 秒，Python 15 个约 0.3 秒、Java 6 个约 1.2 秒；快照提交约 0.5 秒；索引导入约 8.2 秒；图文件写入 386 次、合计约 2.9 秒；整次 semantic ensure 约 20.5 秒。该运行未配置 Go LSP，与打包 smoke 设置不同，计时不应直接横向比较。
- 图文件按源路径哈希的 16 个稳定桶批量打包，单文件内容变化只影响其所属桶，仍保留未修改桶的内容寻址复用。它减少了图记录写入数，但 smoke 仍接近 30 秒；冷语义索引仍是阻塞项，当前证据不支持宣称性能问题已解决。
- 完成 verified-source 复用后，重新构建的插件完整组件 smoke 仍可启动并调用；其 large-semantic 场景单次为 33.5 秒。与此前 29.9 秒单次结果相比没有稳定改善证据，继续把冷语义全量索引视为待优化项，不以 smoke 单样本推断 P95。
- 实时安装的 `0.12.115` MCP 热路径本轮一次返回约 2.2 秒，因复用既有索引且响应预算导致 partial；该结果不是新源码 Host 的冷启动、并发或效果验证。
