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
