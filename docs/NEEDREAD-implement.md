# NEEDREAD.md 实施追踪与验收

目标：把 NEEDREAD.md 的蓝图落到「可运行、可测试」的代码，不升级版本号、不写 Codex/Claude 宿主配置。

## GitHub #15–30 验收边界

下表记录代码和当前可证明的验收范围。Issue 状态仍由维护者决定；本地实现或模拟测试不等于可信外部验收。

| Issue | 当前实现证据 | 尚缺的验收证据 / 限制 |
| --- | --- | --- |
| #15–18、#20、#22、#28 | 本文各功能映射及对应 Workbench / Craft 定向测试 | 尚未逐票完成旧链接恢复、并发人工修改、路径迁移、子项目隔离和真实三模式一致性矩阵；不能仅凭功能存在判为整票验收完成 |
| #21 | Attention 决策按卡片来源版本与状态逐项校验；批量操作逐卡提交并回报部分失败 | 外部真实用户操作验收未执行 |
| #23 | 身份迁移、存量清点、备份清单与损坏输入拒绝路径有实现和测试 | 中断续跑及并发增量对账尚无真实存量数据验收 |
| #24 | Model Gateway 的 Fetch、Codex CLI 与 Craft 各 transport 调用点在最终发送前重做内容脱敏，并把 URL 绑定到 provider 配置；工具参数和敏感 Schema 默认值保留结构、改写值 | 已补**机械化出站路径盘点**（`pnpm run audit:egress`）：扫描 `core/`+`capability/` 全部 `.complete(` 发送点，要求每个调用被 `sanitizeModelEgressRequest` 包裹（或凭理由列入 allowlist），新增发送点未脱敏即构建失败；`craft-eval` 的 `ask()` 也改为走统一出站检查。仍未验收：外部直接调用的 Host/网关、附件提取、真实流式发送、误报/参数保真/性能样本 |
| #25–26 | 有界 Context、撤销/过期/纠错及 Knowledge、Memory、Experience 候选退出路径的定向测试 | 真实重复使用带来的独立效果尚未测量 |
| #27 | 具体 Workflow 自动晋升：同一项目场景下，两个不同 Host session、不同 task 的终态成功证据，分别绑定到该 Workflow 精确版本的成功程序 Trial；来源任务、失败 Trial、版本漂移和含糊匹配不计入晋升。通用引擎不晋升；Workbench 任意 held-out Suite 不具晋升权。证据：`tests/codex-hook-bridge.test.ts` 的合成 Host／任务接口回归，`tests/workbench-evaluations.test.ts` 的任意 Suite 拒绝回归 | 本地自动晋升逻辑和合成接口测试已完成；独立真实任务效果、安装 Host 和跨版本迁移仍未验收。无需人工 Suite JSON 或公私钥；本地管理员直接篡改底层存储不在该证据链的防护范围 |
| #29 | 备份清单缺失或畸形会在写出前拒绝；固定版本运行时包有隔离安装测试 | Workspace restore 因无法保护并发写入而 fail-closed；跨版本升级、回滚和真实 Host 恢复未验收 |
| #30 | 本地功能测试和受控评测器覆盖可重复的执行路径 | 固定 Host 上的独立真实任务、效果对照、失败恢复及桌面/跨平台冒烟未完成 |

## 需求 → 实现 → 证据

### 内部 Host 与共享任务链路的当前边界

- 首次准备可固定跨尝试总时间与总美元限制。时间包含等待和暂停，重试不重置；内部 Host 汇总整链已用及预留费用，把下一次上限收紧到剩余额度，未知费用先对账。任务页和待处理展示耗尽原因。原生 CLI 已绑定总截止，但累计美元硬限制仍需可信计费能力；新根重新规划治理尚未完成。

- 已接通显式冻结成果文件、独立操作者审查、阻塞缺陷/建议分类和返工继承。冻结保存原始字节及摘要并开启新验收轮次；普通人工确认不能绕过受保护条件，其他必需检查仍保留。当前是有界成果集合与可信接口角色分离，尚不等于完整工作区隔离、自动风险路由或真实外部身份独立性证明。

- 任务页和共享接口支持唯一负责人接手、转交及释放，责任跨新尝试保留；交接快照绑定负责人版本，过期后需重新生成。同一幂等请求不重复接单，接单不启动执行、不授予权限、不代表完成。操作者字段沿用现有可信接口身份，不替代账号认证或独立审查。

- 新尝试链最多三次返工，每个源启动只有一个后续尝试；共享准备入口覆盖普通、知识绑定和 Task Run 路径。达到上限且仍失败时进入人工重新规划，任务页显示用量，当前 Task Run 进入控制台待处理。该次数约束尚未替代跨尝试总时间／费用预算及角色接单合同。

- 任务页可暂停、恢复观察、取消和生成交接快照，提交当前 Task Run 版本防止旧页面误操作。恢复只重新观察，不重放已停止执行；写入续做走新尝试并重新审批，部分产物保留，取消后的当前尝试不能恢复。技术接口未提供版本的调用保留兼容。

- 内部 Host 的共享任务路径绑定任务、工作目录和沙箱；目录内读取可执行，写入同时要求启动授权和逐次动作审批。旧的独立内部调用仍保留原有工具范围。
- 显式模型在已配置提供方中唯一匹配；重名要求指定提供方。同一启动编号的重复提交核对模型选择、轮次、输出、时间、美元及循环限额，重试保留派发配置。
- `output_limit` 累计模型文本与工具调用的 UTF-8 字节；超限回复不派发动作，计数持久化，恢复不重置。它与传输响应内存上限、工具输出限制分别生效。
- `max_turns` 按模型请求计数，请求前持久化，恢复不重置；一轮多个工具调用只累计一次模型 token。
- 模型 HTTP 传输支持调用方取消、取消后停止重试，以及逐块按字节限制响应；这不等于远端服务已停止处理，也不等于任务输出限额。
- 审批容量检查、最终决定和消费分别使用存储事务；过期及无效期限不能批准或消费，也不占待审批容量；关闭审批器会取消其本地等待请求。
- 证据入口：`tests/internal-task-host.test.ts`、`tests/model-gateway.test.ts`、`tests/runtime-completion.test.ts`。审批模块和内部 Host 已有模块级 100% 行、函数、分支覆盖测试；覆盖率配置位于 `tests/coverage-gates.json`。这些是本地模拟证据。
- 内部 Host 共享启动入口已接通任务级超时和循环限额，恢复沿用原截止时间；取消依赖传输适配器响应取消信号，不能据此证明远端处理已停止。美元限额要求固定版本价格及可信输入用量上界报价；默认 HTTP/Codex 传输尚无可信报价，启用美元限额时拒绝启动，不能宣称真实提供方已全覆盖。
- 未知费用保留预算占额。终态派发可经人工账单确认对账，必须显式填写金额（包括零）、账单引用和操作者；原未知用量回执保留，人工报告不等于提供方验证。孤儿派发须先按精确 Host Run 版本明确确认原执行端已停止，同一主库事务将对应内部派发标为 interrupted 并禁止再次执行；旧 owner 批量恢复未记操作者时，可用精确恢复入口补充确认。超预留账单另需 confirmed_overrun=true，按实际金额结算并保留原预算上限和负余额，不伪造预算未超限。
- 跨进程审批决定通过等待期间的 250ms 状态轮询通知原等待者；读取暂时失败时继续等待，记录不可用时拒绝继续，仍不能把批准等同于动作执行成功。

### Windows 环境下的覆盖率门修复（2026-11-08）

`pnpm run test:coverage-gates` 在 Windows 上暴露了 10 个未达标组与 1 个真实测试失败；本轮修复其中 2 组，其余如实保留为未达标缺口。

| 组 | 修复前 | 修复后 | 说明 |
| --- | --- | --- | --- |
| `work-review` | FAIL（1 个测试真失败） | **PASS**（24 测试 / 100% 行·函数·分支） | 根因：Windows 无提权无法创建文件 symlink（EPERM）。`tests/work-review.test.ts` 改用 `tests/symlink-support.ts` 既有约定——目录链接用 junction（`linkDirectory`），文件 symlink 在 `supportsFileSymlinks()` 为真时才断言；断言不削弱 |
| `native-cli-discovery` | FAIL（分支 96.94%） | **PASS**（15 测试 / 100%） | 补覆盖：settings 里相对路径/非字符串 `claudeExecutable` 被忽略；Windows 打包二进制优先于 `.cmd` shim；`LOCALAPPDATA` npm 前缀；无 PATH 时的 `?? "PATH"` 兜底 |
| `legacy-session-memory-quarantine` | FAIL（行 94.44% / 分支 86.11%，4 个测试 SKIP） | **PASS**（15 测试 / 100%，0 skip） | 把 4 个"仅文件 symlink 才跑"的测试改为目录 junction（`linkDirectorySync`）：指向缺失目录=broken link、指向真实目录=live link。`lstat().isSymbolicLink()` 与 `realpathSync` 对 junction 语义等价，覆盖真正生效而不再跳过 |
| `legacy-session-memory-preflight` | FAIL（行 99.49% / 分支 99.18%） | **PASS**（5 测试 / 100%） | 目录内 junction 覆盖 per-entry link 分支；POSIX 专属的"非文件/目录/链接类型"分支用 `fs.lstatSync` seam 注入构造，不靠平台豁免，line/function/branch 三门均强制 |
| `session-evidence-repair-preflight` | FAIL（分支 98.15%） | 未达标（分支 98.21%，提升） | 补齐 `preflightSessionEvidencePage` 全部边界校验用例（limit 0/1001/1.5/unsafe-int、cursor>1024）与分区 payload 的 identity_digest/project_scope_id 不一致用例；剩余分支为 affected 后 identity 校验的个别 `||` 子条件，未逐一构造 |

仍未达标（如实登记，未修复）：`session-evidence-repair-preflight`、`capability-storage-migration`、`legacy-repository-storage-migration`、`codex-session-provenance`、`knowledge-evaluation-provenance`（行/函数 100%，分支 96.55%；本轮补齐了 `candidate_claim_refs` 过滤/去重、`task_contract` 摘要，以及 case id/version/identity 漂移用例；剩余为 `knowledgeClaimPromotionProofVerified` 单个大函数内 9 处防御性短路分支，需构造完整晋升链 fixtures，暂未逐一构造）、`memory-session-storage`（branch 97.94%，本轮补了 capture intent 丢失 project identity 的防御用例并命中 `SESSION_ARCHIVE_OBSERVATION_UNVERIFIED: project identity is unavailable` 分支；剩余为 Windows 不可达的 `chmod` 分支与防御性兜底分支，未逐一构造）。

验证：`tsc --noEmit` 0 错误；8 个相关测试文件 99/99 通过；`craft-eval` kernel 16/16 通过（model 用例因缺 `WORKBUDDY_API_KEY` 如实 inconclusive）。

### 本地 OpenAI 兼容网关接入（2026-11-08）

把本地代理（`http://127.0.0.1:3425/v1`，模型 `group/free`）接入 `craft-eval`，使模型驱动的评测、端到端与治理用例可以真跑；此前这些用例因缺凭据一律 `INCONCLUSIVE`。

**配置的存放边界（遵守仓库既有约定）**

| 文件 | 进 git | 内容 |
| --- | --- | --- |
| `.env.example` | 是 | 变量名与端点模板：`CRAFT_EVAL_PROVIDER/LABEL/BASE_URL/MODEL/FRONTIER_MODEL/API_KEY_ENV`、`OPENAI_BASE_URL`、占位 `OPENAI_API_KEY` |
| `.env.local` | 否（`.gitignore` 的 `.env.*` 命中，已验证） | 真实密钥；只在运行时注入 |
| `settings.json` 的 `models[]` | 否（在 `~/.craft_data`） | 运行时模型登记，`apiKeyEnv` 只存变量名，不存密钥 |

密钥从不写进源码或提交内容：`api_key_env` 只是变量名，取值来自进程环境；仓库既有的 secret detector 会拦截源码里的凭据形状字符串。

**新增入口**

- `scripts/dev/load-env.ts`：用 Node 内建 `process.loadEnvFile` 读取 `.env.local`/`.env`，且**已存在的环境变量优先**（文件不覆盖显式传入的值），不引入 dotenv 依赖。
- `package.json`：`eval:local`、`eval:local:live`（run → recurrence → suite 全链）。
- `scripts/dev/eval-model-probe.ts`：探测网关实际行为（finish reason、推理/输出 token 分配、可见文本），把“环境限制”与“答错”分开。

**修复的推理型模型兼容缺陷**

探测实测：`max_tokens: 32` → `output_tokens: 32`、可见文本为空；`max_tokens: 512` → 正确返回 `391`。即推理模型先用预算输出隐藏推理，小预算会把“预算不足”误判成“能力失败”。

- `capability/craft-eval/model.ts`：`ask()` 默认预算 64 → `1024`（`EVAL_ANSWER_MAX_TOKENS`）；空文本且 `output_tokens` 已打满预算时显式抛“预算不足”错误，而不是把空白当答案参与评分。
- `capability/craft-eval/recurrence.ts`：去掉硬编码的 32 token。

**真实运行结果**（`pnpm run eval:local:live`）

| 环节 | 结果 |
| --- | --- |
| `run.ts` 确定性任务 | 4/4 PASS（arithmetic 391、reverse tfarc、sort 1 3 5 9、json `{"ok":true}`） |
| `recurrence.ts` 失败复现 | 3/3 PASS |
| `suite.ts` capability | 18/18（observed 18，failed 0，inconclusive 0） |
| `suite.ts` safety / governance | 1/1 PASS（此前 INCL） |
| `suite.ts` end_to_end | 3 个 model 用例全部 PASS（此前 2 INCL + 1 FAIL） |

验证：`tsc --noEmit` 0 错误；`tests/eval-model-config.test.ts` + `tests/model-gateway.test.ts` 50/50 通过。

### 端到端受控回路测试（2026-11-08，真实网关 + 真实进程 + 真实 HTTP）

单元门只证明内核本身；本节补上"seam 之间的真实验证"，按业界分层（真实进程 / 真实 HTTP / 故障注入）执行，全部基于上一节接入的本地网关。

`pnpm run e2e` → `tests/e2e-governed-loop.test.ts`（3 用例，网关不可达时全部 skip，CI 保持绿）：

| 用例 | 证明的链路 | 结果 |
| --- | --- | --- |
| `pilot model split creates ordinary tasks through the real gateway` | `pilotSessionOpen` → `pilotTurnWithModel`（真实 `group/free` 返回 JSON 拆分）→ intake 校验 → 普通 Task 创建 | PASS（tasks ≥ 1，model=group/free） |
| `craft run --goal drives task -> dispatch -> real model -> receipt over the CLI` | **真实 CLI 进程**：`craft init` → `craft run --goal` → task → dispatch → internal host → 真模型 → receipt（`final_message` 与确定性验收对齐）→ acceptance gate 挂起待审 | PASS（`final_message=391`，`loop.verdict=model_final_message`） |
| `pilot HTTP surface serves the same intake the UI would call` | **真实 HTTP**：`LocalWorkbenchServer.start()` → `POST /api/pilot/sessions` → `POST /api/pilot/sessions/:id/turns/auto`（UI 同款确定性 intake + Reviewer 硬规则）→ tasks 创建 + review pass | PASS |

**已验证的运行时登记（不在 git，落在用户数据根）**：`settings.json` 注册 `local-free → group/free`（`apiKeyEnv=OPENAI_API_KEY`），`pilotTurnWithModel` 真跑确认拆分 3 个任务。

**回答"内核是否也有三模式"**：有，但分层不同——

- 内核 `CraftMode = agent | supervisor | provider`（`craft mode`，config 层）：这是**运行角色**，切换的是"谁用 Craft"，不是 UI 投影。
- 产品三模式 **领航员/控制台/工作台**（`pilot/control/workshop`）是同一 Runtime 的 UI 投影：领航 = Pilot 编排链（`/api/pilot/*` 全套路由已在内核 HTTP 层），控制台/工作台消费同一套 Task/Approval/Evidence。切换模式不建第二套 Store、不改权限——这正是本 e2e 用真实 HTTP 证明的 seam。

**补充发现（设计确认，非缺陷）**：`--tier small` 对"只配置 standard 一个模型"的 provider 报 `declares no usable model tier`。`selectModel` 的 `TIER_ORDER=[frontier,standard,small]` 只允许**向低成本方向**降级（请求 frontier 可落 standard/small），不允许反向升级到更贵档位——这是成本安全设计，不是 bug；单模型网关应请求 `standard`。

### 覆盖门发现的两个真实缺陷（2026-11-08）

全量 `test:coverage-gates`（228 组）暴露 2 个组的**真实测试失败**（不是覆盖率不足），已修复：

| 组 | 症状 | 根因 | 修复 |
| --- | --- | --- | --- |
| `store-atomicity` / `common-store-local-package` | `concurrent first opens wait for the shared database WAL initialization` 在多测试同进程时偶发失败；单独跑 5 次全过 | 4 个进程并发首次打开同一数据根时，`rebuildDomainIndexes` 打开的 index 数据库用**无重试**的 `ensureJournalMode`，而 primary 用带重试的 `ensurePrimaryJournalMode`。`PRAGMA journal_mode=WAL` 需要独占窗口，并发时 `database is locked` 直接崩掉整个进程 | 把重试封装泛化为 `ensureJournalModeWithRetry(database, role)`，index 也走同一重试路径；`rebuildDomainIndexes` 改为 async 并 await。复现脚本 6 轮 × 4 并发进程：修复前每轮都有 `database is locked` 退出码 1，修复后全部 exit 0 |
| `common-store-local-package` | `CraftStore keeps Memory records in the database for their scope and can reopen them` 断言失败 | 测试用**写死 `/`** 的正则匹配路径，Windows 实际是 `\`；实现（`task--<32位hash>`）本身正确 | 断言改为先 `replaceAll("\\", "/")` 归一再匹配，跨平台一致 |

这正是"单元门通过、真实进程/并发层才暴露"的缺陷类型——前者验机制，后者验可靠性。

### 本地进程沙箱：补齐"没有 Docker 就没有执行沙箱"的缺口（2026-11-08）

**缺口**：`SandboxKernel` 只登记声明，真正执行只有 `DockerSandboxAdapter`；`LocalIsolatedAdapter` 依赖 macOS `sandbox-exec` / Linux `bwrap`，在 Windows 上直接"不可用"。也就是说，没有 Docker 的机器**没有任何可执行的本地沙箱**。

**实现**：`core/local-process-sandbox.ts`（`LocalProcessSandboxAdapter`，MCP 工具 `craft_local_sandbox_*`）

| 能力 | 是否提供 | 说明 |
| --- | --- | --- |
| argv-only 执行 | ✅ | `shell:false`，不做引号/展开 |
| 工作目录限定 runtime root | ✅ | `localProcessWorkspace` 复用容器后端的越界判定 |
| 环境变量白名单 | ✅ | 只转发 `PATH`/`HOME`/`TEMP` 等；名字含 key/token/secret/password 的一律丢弃 |
| 超时 + 进程树终止 | ✅ | Windows 用 `taskkill /T /F`，POSIX 用进程组 `SIGKILL` |
| 输出上限 | ✅ | 超限即终止并截断 |
| 输出脱敏 | ✅ | `api_key=...` 等改写为 `[REDACTED]` |
| 文件系统隔离 / 网络拒绝 | ❌ **不提供** | 子进程仍可读写工作区外文件、访问网络 |

诚实性约束：每条结果都带 `os_sandbox_guaranteed: false`；`conformance()` 只验证它真正声称的四项（工作目录、环境、超时、输出），**不**声称 `network_denied` 或 `root_read_only`；capability 声明 `network` 必须为 `unrestricted`，否则拒绝（要求网络隔离必须用容器后端）。

验证：`tests/local-process-sandbox.test.ts` + `tests/local-sandbox-service.test.ts` 共 20 例，真实 spawn；`core/local-process-sandbox.ts` **行/函数/分支 100%**，已登记为 `local-process-sandbox` 覆盖门。服务层链路 `profileSave(backend=local_process) → probe → conformance(→verified) → plan → execute → receipt` 端到端通过，并验证 receipt 的 `boundary_matches=true`。

### 测试金字塔：从"单元门绿"到"真实链路绿"（2026-11-08）

业界（Anthropic long-running harness / LangGraph 持久化 / SWE-bench 类）对 Agent 系统的验证是分层的，本项目按此补齐：

| 层 | 现状 | 证据入口 |
| --- | --- | --- |
| 单元/模块（机制） | 469 个测试文件；228 个覆盖率组按能力分组，多数 100% 行/函数/分支 | `pnpm run test:ts`、`pnpm run test:coverage-gates` |
| 进程级（真实 spawn） | 85 个测试文件使用真实子进程；本轮修复了 4 进程并发打开同一数据根的 WAL 竞态 | `tests/store.test.ts`、`tests/runtime-package-start.test.ts` |
| 真实 HTTP（服务面） | `LocalWorkbenchServer` 真端口 + token + 路由 | `tests/e2e-governed-loop.test.ts` |
| 真实模型（评测/回路） | 本地 OpenAI 兼容网关跑 capability/safety/e2e | `pnpm run eval:local`、`pnpm run eval:local:live` |
| 真实 CLI（受控回路） | `craft init` → `craft run --goal` → 真模型 → receipt | `pnpm run e2e` |
| 故障注入 | WAL 忙、磁盘写失败、SQLite 错误、超时、输出洪泛 | `tests/store-*.test.ts`、`tests/local-process-sandbox.test.ts` |

新增 `pnpm run e2e`（`tests/e2e-governed-loop.test.ts`，3 例）：网关不可达时 **全部 skip**，绝不假装通过。

### 出站脱敏全路径盘点（#24，2026-11-08）

- `scripts/ci/audit-model-egress.ts`：遍历 `core/` 与 `capability/` 的 `.ts`，对每个 `transport.complete(` 发送点检查前 12 行是否有 `sanitizeModelEgressRequest(`；若请求被脱敏成命名变量再发送，则接受“该变量由 `sanitizeModelEgressRequest` 赋值”的写法。允许清单只有一项（`core/codex-cli-model-transport.ts`，委托型 transport），且必须写明理由。
- `tests/model-egress-coverage.test.ts`（2 例）：仓库当前 **7 个发送点 / 0 违规**；并构造“未脱敏新增发送点”证明审计会失败（不是恒真检查）。
- `capability/craft-eval/model.ts` 的 `ask()` 补充 `sanitizeModelEgressRequest`，让评测调用也走同一最终检查；`pnpm run eval:local` 复跑仍 18/18 + 1/1 + 3 model。
- CI `test.yml` 增加 `pnpm run audit:egress`。

### value 账本从"诚实为空"到"真实被观测"（2026-11-08）

**缺口**：`craft-eval` 的三账本里 `value`（是否帮到人）自建立起没有任何用例，`score` 永远 `null`、`quotable` 永远 `false`。这是当时的诚实状态，但也是评测体系最大的结构缺口——一个"全绿"的报告仍然无法回答"用户是否受益"。

**为什么不能直接改个标签**：`AXIS_LEDGER` 的注释写明，把合规或正确性检查改标成 `value` 正是账本要防止的造假。所以新增的是一个**真正的受益用例**，配对对照设计：

| 要素 | 设计 | 字节判定 |
| --- | --- | --- |
| 事实 | 合成项目规则：发布前必须运行 `pnpm quilt-7143-xq`（模型不可能预知） | 答案必须包含该标识符 |
| 对照回合 | 只发问题 + 统一的"不确定就答 unknown"指令，无任何 Craft 上下文 | 答案**不得**包含标识符（否则证明是模型已知，不是 Craft 供给） |
| 供给回合 | 与对照逐字节相同，仅在前面加上 Craft 的有界上下文（≤1200 字符） | 答案**必须**包含标识符 |

两回合唯一的差异就是 Craft 供给的内容，因此通过与否只能归因于上下文供给。baseline 因为面对不可知的规则会长时间推理吃满预算，统一的不确定指令让对照回合可判定，而不是把环境失败误报成测量结果。

**实现**：
- `core/eval-suite.ts`：`context_supply` 轴加入 `CAPABILITY_AXES`，映射到 `value` 账本；注释同步更新为"账本已被一个配对受益用例占据，替换的是测量而非改名"。
- `core/eval-cases.ts`：`context_supply.supplied_context_replaces_explanation` 用例与共享的 prompt 构造（runner 与 case 永远不会各自漂移）。
- `capability/craft-eval/suite.ts`：runner 执行两回合、测量供给字符数是否在预算内、记录三要素判定。
- `tests/eval-context-supply.test.ts`（3 例，离线）：钉住"value 账本唯一占据者 + model_output 证据"、"供给与对照唯一差异 = 供给内容"、"供给在预算内且对照不含答案"。
- `tests/eval-suite.test.ts`：原"value 账本故意为空"的断言更新为新契约，并验证"kernel 证据不能挂在非 capability 账本"这一防伪门仍在。

**真实网关结果**（`pnpm run eval:local`）：

| 账本 | 之前 | 现在 |
| --- | --- | --- |
| capability | 18/18 | 18/18 |
| safety | 1/1 | 1/1 |
| **value** | **NO OBSERVATION（无用例）** | **1/1**（observed 1，context_supply 轴） |
| `quotable` | false（value 无观测） | **true — every ledger has at least one observation** |
| model observations | 3 | 4 |

注意边界：这是**机制受益**的测量（有界上下文替代了用户解释），不等于独立真实用户任务上的业务收益；`comparable_to_published_benchmarks` 仍为 `false`，该边界不变。

### 评测门槛与第二类受益场景（2026-11-09，craft-eval 持续迭代）

**实测暴露的问题**：首个 value 用例上线后被真实网关判 `0/1` 一次、`1/1` 一次——单回合模型输出有随机性；新增的 Memory 场景又报 `Memory kind is unsupported`。两者都不是套件"偶发"，而是评测设计缺陷：单样本不足以支撑受益结论，且 case 定义与真实内核白名单脱节。

**修复（本批同一功能批次）**：

1. **双次配对观测**：`observePair()` 对每对 control/aided 回合最多观测两次，两回合一起重发，两次都满足"baseline 无 marker、aided 有 marker"才算通过；`attempts` 写进 `failure_reason`，单次幸运回答不能变成结论。
2. **第二个 value 场景**：`context_supply.memory_hit_replaces_repetition`。规则写入真实 `memoryLedgerRemember`（`kind: preference`，对齐内核白名单），经 `memorySearch` 真实取回，只有内核返回的内容才允许进入 aided 回合；检索未命中则 aid 为空、用例失败——套件不能把自己的 fixture 回显成"收益"。两个场景用两个独立合成 marker，避免一个答案同时满足两条。
3. **预先声明的最小样本门槛**：`LEDGER_MIN_OBSERVATIONS = { capability: 8, safety: 1, value: 2 }`，与 ledger 定义同文件声明，`sufficient_evidence` 从 `observed > 0` 升级为 `observed >= minimum`。报告每个 ledger 打印 `minimum`，低于门槛时打印缺口；`quotable_reason` 改为"cleared its declared minimum / below the declared minimum"，不再说"at least one observation"。
4. **可证伪测试**：`tests/eval-context-supply.test.ts` 钉住两个场景的配对形状、独立 marker、预算、门槛不能悄悄降到 0；`tests/eval-suite.test.ts` 新增"每账本各 1 个观测仍不可引用"的反向用例。

**真实网关最终输出**（`pnpm run eval:local`）：

| ledger | 分数 | 门槛 | 结果 |
| --- | --- | --- | --- |
| capability | 18/18 | 8 | 达标 |
| safety | 1/1 | 1 | 达标 |
| value | **2/2**（context_supply 轴） | 2 | 达标 |

`model observations: 5`，`quotable: true — every ledger cleared its declared minimum (capability:8, safety:1, value:2)`。五个 model 用例全 PASS，无 INCL/FAIL。

**边界不变**：仍是机制受益测量（上下文/Memory 替代用户重复解释），不是独立真实用户任务的业务收益；`comparable_to_published_benchmarks: false` 保持。

### 主动服务正反例与多数配对观测（2026-11-09，craft-eval 持续迭代）

**按 NEEDREAD §13.3 补的缺口**：此前 value 账本只有"上下文替代解释"这一类正例，没有主动服务的"不应行动"反例；而 §13.3 明确要求"正例与不应行动反例按完整轨迹配对，不能靠一直沉默降低误报，也不能靠多提醒提高召回"。

**实现**：

- 新增 `proactive_restraint` 轴（映射 value 账本）与 4 个配对场景：1 个正例（开放、无人认领、在窗口内、未勿扰 → 可建议一次）+ 3 个反例（已由他人完成并验证 / 先前拒绝 + 勿扰 + 来源过期 / 目标被新指令取代且已有活跃负责人）。四回合共用**同一段决策合同**，唯一差异是情境描述。
- 联合防刷分门：runner 收集 4 个回合的字节决策，若 `allSilent` 或 `allNudging`，则整组判失败——即便某些单条字面吻合。这直接实现"不能靠一直沉默降低误报，也不能靠多提醒提高召回"。
- `LEDGER_MIN_OBSERVATIONS.value` 升到 **4**（2 个 context_supply + 4 个 proactive_restraint = 6 个观测，门槛 4 留出一个失败余量，不让单条抖动推翻账本）。
- **修正配对观测的统计语义**：真实网关连续跑时，首个 context_supply 用例曾出现 `5/6` 与 `6/6` 两种结果——模型单回合偶发未带 marker。原"两次都成功才通过"把随机抖动误判成能力回归。改为**3 次观测的多数判定**：至少 2/3 次 aided 带 marker 才通过；但 **baseline 任意一次泄漏 marker 就立即失败**（硬约束：模型本来就知道这条规则时，不能声称是 Craft 供给带来的收益）。`successes/attempts` 写进每条 `failure_reason`。

**离线可证伪测试**：`tests/eval-context-supply.test.ts` 钉住正例恰好 1 个、反例覆盖 handled/勿扰/过期/目标变更、四回合合同同一、门槛不能降到 0；`tests/eval-suite.test.ts` 钉住 value 账本 6 例（2+4）且全部 `model_output` 证据。

**真实网关验证（连续两次 `pnpm run eval:local`）**：

| ledger | run 1 | run 2 | 门槛 |
| --- | --- | --- | --- |
| capability | 18/18 | 18/18 | 8 |
| safety | 1/1 | 1/1 | 1 |
| value | **6/6** | **6/6** | 4 |

两次均 `quotable: true — every ledger cleared its declared minimum`，9 个模型回合全 PASS、无 INCL/FAIL。`pnpm run e2e` 3/3（真 CLI/真 HTTP/真模型），五审计全绿。

### 评测 runner 的深模块接缝（2026-11-09，按 codebase-design 审视）

**问题**：`capability/craft-eval/suite.ts` 膨胀到 696 行、21 个 bespoke `if (inScope(...))` 分支、5 处分散的 `modelTurns +=`。每加一个 value 场景都要同时改用例定义、runner、两个测试文件——一次逻辑变化散弹到多处（Shotgun Surgery），且配对逻辑与主动服务逻辑重复各自的观测/计数/防刷分形状（Duplicated Code）。

**接缝**：把两类 value 配对场景收进一个深模块 `capability/craft-eval/paired-value-runs.ts`。接口只有一个 `runPairedValueCases(runner)`，调用方只提供 5 个 seam：`ask`、`addTurns`、`inScope`、`gap`、`memoryAid`（真实 Memory 检索）。重试策略、硬泄漏约束、多数判定、退化策略联合门、字节评分、回合记账全部藏在实现里。新增场景只需在 `core/eval-cases.ts` 声明数据，runner 无需改动。

- `suite.ts` 696 → **603 行**（-93），value 段从 ~120 行 bespoke 变成一次调用；`modelTurns` 只剩一处累加。
- `tests/eval-paired-value-runs.test.ts`（6 例，离线可证伪）：干净运行 6 例全过且回合数精确（2×3×2 + 4 = 16 次）、**baseline 任一次泄漏 marker 立即硬失败**、3 次里 2 次成功即通过（单回合抖动不误报）、全沉默/全提醒两种退化策略各自让 4 个反例全失败、缺凭据时 6 例全 `inconclusive` 且零模型回合、Memory 内核不可用时只影响那一个 case。
- 输出口径修正：`model observations (graded cases)`（决定性用例数 9）与 `prompted turns (incl. retries)`（实际请求数 19）分别命名打印，避免把重试回合误读成独立观测。

**验证**：重构后 `pnpm run eval:local` 与原实现**行为完全等价**——18/18 + 1/1 + 6/6、`quotable: true`、9 个决定性观测、6 个 value 用例全 PASS、无 INCL/FAIL；`tsc --noEmit` 0 错误；五审计全绿（587 模块 0 违规）；相关测试 96/96；`pnpm run e2e` 3/3。

### 评测的可复现交付物（2026-11-09，ponytail 视角最小完整改动）

**问题**：此前评测只把结果打到 stdout，无法做"基线 vs 候选"比较；无凭据时的报错只说 `WORKBUDDY_API_KEY is not set`，不告诉使用者本仓库已提供 `.env.example` 与 `pnpm run eval:local`；且 `model observations` 与实际模型请求数并列打印容易误读。

**改动（不引入依赖、不新增配置、不默认写盘）**：

- `evaluationCredentialMissing()` 的错误文案改为可直接照做：复制 `.env.example` → `.env.local` → `pnpm run eval:local`（或显式 export），并打印当前 provider / base_url；明确"model cases 记 inconclusive，绝不记 failed"。
- 报告头打印 `provider / base_url / api_key_env` + suite digest；两次运行只有在该身份与 digest 一致时才可比较。两个分母分别命名：`model observations (graded cases)` 与 `prompted turns (incl. retries)`。
- 新增可选 `--report <new-path>`：显式写 `craft-eval-run-report.v1` JSON，含 run identity、suite digest、门槛、三账本、逐 case verdict、两个分母；**不含凭据值、不含原始模型正文**。用 `flag: "wx"` 防止覆盖已有报告（基线不能被候选静默替换）。不传该参数时零写盘。
- `tests/eval-report-artifact.test.ts`（2 例，离线）：不传则不写盘；传则写出且 `wx` 防覆盖、报告无密钥、schema/digest/门槛/ledgers/results 齐全；`--report` 缺路径立即失败而不猜路径。

**实测**：`node --import ./scripts/dev/load-env.ts --experimental-strip-types capability/craft-eval/suite.ts all --report <path>` 写出 25 个 case 的报告，`has magpie? false`，`prompted_turns 19`、`model_observations 9`、门槛 `{capability:8,safety:1,value:4}`，`quotable true`；复用同一路径报 `EEXIST` 且原文件不变。

### 基线 vs 候选比较器（2026-11-09，持续迭代的验收动作）

**问题**：有了 `--report` 产物后，"持续迭代"仍缺一个动作：两份报告是否可比、候选有没有让某个已通过的 case 退步，靠人眼看 stdout 不可靠。注意这与 `core/workbench-evaluations.ts` 调用的 `craft-eval` 包 `compareRuns` 是不同 seam——后者比较受控 evaluator 结果目录（case/trial 级），这里比较两份三账本 suite 摘要（ledger/case 级），两者不重复。

**实现**（深模块 + 薄 CLI）：

- `capability/craft-eval/compare-run-reports.ts`：`compareRunReports(baseline, candidate)` 一个纯函数接口。先校验两份 `craft-eval-run-report.v1` 的 **run identity 四元组**（provider / base_url / model / suite_digest）完全一致；任一不同立即返回 `comparable: false` 并列出差异字段，绝不把"换了个网关或换了个套件"的结果当成同一基线的候选。
- 输出每个 ledger 的 `分数 / observed / passed / delta`，以及 `regressions`（`passed -> 非 passed`）、`improvements`（`非 passed -> passed`）、`newCases` / `removedCases`。
- `capability/craft-eval/compare.ts`（`pnpm run eval:compare <baseline.json> <candidate.json>`）：只读两个文件、打印差异；`comparable=false` 或存在 regression 时 `exit 1`，让候选无法靠"某个账本看起来还行"蒙混过关。
- `tests/eval-compare-run-reports.test.ts`（6 例，离线）：自比零 delta；四种身份字段各自被拒；passing→failed 报 regression 且 delta -1；inconclusive→passed 报 improvement（NO OBSERVATION → `1/1`）；新增/移除 case 不误标为回归；错误 schema / null / 空身份字段在信任边界被拒。
- 与 `core/workbench-evaluations.ts` 的受控比较不同粒度，故未复用其 `compareRuns`，避免把"受控 evaluator 目录比较"与"三账本摘要比较"混成一个接口。

**实机验证**：

| 场景 | 输出 | exit |
| --- | --- | --- |
| 同一报告自比 | `comparable: true`、三账本 delta 0 | 0 |
| `memory` scope vs `datasec` scope（digest 不同） | `run identity differs: suite_digest` | 1 |
| 人为把 `memory.decay_orders_recent_first` 改成 failed | `capability 5/5 -> 4/5`、`regressions: 1` | 1 |

这使"基线→改动→候选→比较→退步阻断"成为可执行的验收动作，而不是口号。

### 待决定事项的结构化决策包 + Windows 进程清理根因修复（2026-11-09）

**按 NEEDREAD §2 审视的缺口**：`AttentionKernel.list()` 只返回零散 `details`，而 §2 要求"待决定事项展示触发原因、最新证据、选项与影响、建议及不确定性，不把整段 Trace 当审批材料"。

**实现（读模型，不新增存储）**：

- `core/attention-decision-brief.ts`：`attentionDecisionBrief(item)` 从卡片派生 `DecisionBrief { trigger, evidence, options, impact, recommendation, uncertainty, source_stale }`。`evidence` 是类型化的来源快照（kind/id/version/status + details），不是自由文本；`options` 按 action 映射（审批 / 启动 / 验收 / 重规划 / 评测器 / 维护 / 候选 / 恢复等待），并标注哪些选项会产生写入或返工；`impact` 明确说明"是否改变执行事实"；`recommendation` 在来源引用缺失时改为"先刷新来源，再决定"，不推荐任何动作；`uncertainty` 显式列出未绑定 Task、来源缺失、候选有效期、后台重试时间等未知。
- `AttentionKernel.list()` 给每个返回项附 `decision_brief`。它是**派生读模型**，从不落库，所以来源版本刷新后不会残留旧决策包；`decide()` 的 source-version 硬校验完全不变。
- `tests/attention-decision-brief.test.ts`（4 例）：所有列出的卡片都有完整 brief、审批卡的三个选项、有效期不确定性、缺失来源引用时拒绝推荐动作、destructive 选项的 impact 可见、来源变化后 brief 反映新 version。
- 既有 `tests/attention.test.ts` **85/85 全过**（含 source-changed 拒绝、defer/ack 幂等、audience 过滤）。

**顺带修掉的两个既有真失败**（不是本批引入）：`tests/codex-driver.test.ts` 与 `tests/host-run.test.ts` 的 Windows 进程级用例报 `HostProcessCleanupError`。根因是 `core/host-driver.ts` 的 `stopWindowsHostProcessTree()` 把 `taskkill /T /F` 的任意非零返回都当作"清理未确认"；而进程在 spawn 与 cleanup 之间自行退出时，taskkill 返回 **exit code 128**（stderr 是本地化且在 zh-CN Windows 上为非 UTF-8 控制台编码）。目标 PID 已不在运行正是清理目的达成，不应报错。

- 改用语言无关的 `error.code === 128` 判定"已退出 = 清理成功"，保留文本兜底；其它错误码（如 `EACCES`）仍原样抛出，不掩盖真实清理失败。
- `tests/host-output-limit.test.ts` 新增回归：code 128 视为成功、`EACCES` 仍拒绝；`tests/attention.test.ts` 从 83/85 恢复为 **85/85**。

### Trial 级成本与证据（2026-11-09，按 Anthropic 评测词汇对齐）

**依据**：Anthropic《Demystifying evals for AI agents》（2026-01-09，<https://www.anthropic.com/research/demystifying-evals-for-ai-agents>）明确区分 task / trial / grader / transcript / outcome，并强调"因模型输出有差异要跑多次 trial"、确定性 grader、trial 隔离、以及延迟/token/成本随分母报告。此前 craft-eval 只有 case 级 verdict 与两个聚合回合数，缺 trial 级证据。同系列的《Harness design for long-running apps》（2026-03-24）也把"每个 criterion 有硬阈值 + 独立 evaluator"作为验收形状，与本仓库的三账本门槛同向。

**实现**：

- `capability/craft-eval/model.ts`：新增 `askTrial(prompt)` 返回 `{ text, model, usage, elapsed_ms, max_tokens }`；`ask()` 保留为薄封装，不破坏 governance/e2e 等既有调用点。
- 深模块 `runPairedValueCases` 的 `ask` seam 改为返回 `EvalTrial`，配对判定从 `trial.text` 取字节；suite 用单一 `askTrialWithLedger` 包装记录**所有**模型回合（含 3 次配对重试），避免重复计数。
- 报告新增 `trials[]`（每个回合的 model / usage / elapsed_ms / max_tokens，**不含原始回复**）与 `trial_totals`（input/output tokens、总耗时、带 usage 的回合数）；stdout 打印 `trials / with usage / tokens in/out / elapsed`。
- `tests/eval-report-artifact.test.ts` 钉住 `trials.length === prompted_turns` 且产物不含原始回复；`tests/eval-paired-value-runs.test.ts` 的 harness 同步为 `EvalTrial` 形状。

**真实网关实测**：19 个 trial 全部带 usage，`tokens in/out 1218/3744`、`elapsed 64826ms`；报告 `trials 19`、`totals {"input_tokens":1218,"output_tokens":3744,"elapsed_ms":64826,"with_usage":19}`，`has raw reply? false`；三账本仍 18/18 + 1/1 + 6/6、`quotable: true`。

**边界（如实登记）**：这里的成本是**模型用量与本地耗时**，不是美元价格（无可信计费输入时不编造费用）；trial 之间共享同一个本地 store，尚未达到 Anthropic 建议的"每个 trial 从干净环境隔离启动"，该差异作为后续迭代项保留。

### 隔离级别显式声明与比较门禁（2026-11-09）

**把上条的"边界"变成机器可检查的事实**，而不是文档里的一句免责声明：

- `--report` 产物新增 `isolation: "shared_local_store_scoped"`；比较器把 isolation 纳入 run identity：两份都声明但不同、或一份声明一份未声明（旧报告），一律 `comparable: false` 并列出 `isolation`。这样"将来升级到每 trial 干净环境"的运行不会被误当成共享 store 基线的候选；旧报告彼此仍可比（向后兼容）。
- `capability/craft-eval/compare.ts` 打印 `isolation=...`。
- `tests/eval-scope-isolation.test.ts`（2 例，可证伪）：直接读 runner 源，证明 store-backed 两段用例的 `scope_id` **不相交**（Memory value 的 `eval-memory-workspace` 不出现在 scope-isolation kernel case 里），并证明 aided prompt 来自 `memory.text`（真实 `memorySearch` 结果）而非把 `MEMORY_SUPPLY_FACT` 内联回显。这是"scoped"这一声明的下限证据。
- `tests/eval-compare-run-reports.test.ts` 新增：相同 isolation 可比、不同 isolation 拒绝、legacy 无字段报告彼此可比但与声明过 isolation 的报告不可比；`tests/eval-report-artifact.test.ts` 钉住报告必带该字段。

**实测**：`--report` 产物 `isolation shared_local_store_scoped`、19 trials 全带 usage；比较器 `identity: ... isolation=shared_local_store_scoped`、`comparable: true`、0 regression。三账本仍 18/18 + 1/1 + 6/6、`quotable: true`。

**仍未做（诚实保留）**：真正的 per-trial 隔离需要把 21 个 bespoke kernel 分支各自放进独立 store，属于 runner 深化的下一批，不在本批伪造。

### 三模式与 goal/plan/permission 的落点（澄清）

- 内核运行角色 `CraftMode = agent | supervisor | provider`（`craft mode`）是"谁在用 Craft"；产品三模式 **领航员/控制台/工作台**（`pilot/control/workshop`）是同一 Runtime 的 UI 投影。领航编排链路的 HTTP 路由已在内核：`/api/pilot/sessions`、`/sessions/:id/turns`、`/turns/auto`、`/status`、`/review`、`/reconcile`、`/tasks/:id/route`、`/routes/:id/reassign`。
- `goal` 走 `craft run --goal`（真实模型回路，本轮端到端验证 `final_message=391`）；`plan` 走 `task-replan` 与 `verified-work-loop`；`permission` 走 `ApprovalGrant` + `tiered-autonomy` + `execution-safety`。
- 插件生态：`plugin-adapters`、`generic-adapter-runtime`、`dsh-plugin-host-runtime`、`mcp-adapter-client`，外加入口 `craft adapter` / `craft source` / `craft kit`。

| NEEDREAD 需求 | 实现 | 证据 |
| --- | --- | --- |
| 三模式（领航员/控制台/工作台）+ Fresh Load | `mode-shell.js` + `setMode` 重载文档 | 既有；`tests/mode-shell.test.ts` |
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
| 自进化：捕获 Trace（配置快照、目录解析来源、用户结局） | `pilot.turn.mod_configuration` 是未按任务过滤的启用配置快照，不证明 Host 注入；`pilotTurnAuto` 记 `workspace_resolution`，`pilotDeliveryAdoption` 记用户结局 | `tests/pilot-mod-trace.test.ts`、`tests/workbench-server.test.ts` |
| 自进化：归因 | 既有 `core/failure-attribution.ts` | `tests/failure-attribution.test.ts` |
| 自进化：失败终态可核验轨迹 | `pilotFinalizeSessionReviews` 为每个 `needs_attention` 结果幂等写 `pilot_failure_observation`；Mod 仅为未经任务过滤的配置快照，不是注入证据，不臆测 failure_class | `tests/workbench-server.test.ts` |
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
| 消息插件：纯工程监听 + 0 Token 展示 | `message-inbox.ts` + `messageIngest` webhook + `message-listener.ts`（`LocalDropAdapter` 本地/挂载云目录轮询，`message_seen` 持久去重，一源失败不影响其余，`ImapAdapter` 无配置诚实报错）+ `messagePoll` HTTP/CLI + `message-dock.js` 三模式（领航员播报/控制台待办含目录拉取/工作台 Toast+侧栏） | `tests/message-inbox.test.ts`、`tests/message-listener.test.ts`、`tests/message-dock.test.ts`、`tests/cli-dirs.test.ts`、`tests/workbench-server.test.ts` |
| 安全边界：脱敏先于落库 | `messageIngest` 用 `craft-datasec` 全部内置规则脱敏正文，发件人/主题只去凭据以保留可读性，绝不把密钥原文写入本地库 | `tests/message-inbox.test.ts` |
| 消息插件：按需 AI | `messageProcess` 派发 Pilot turn（幂等），仅此步消耗模型 | `tests/message-inbox.test.ts` |
| 控制台消息批量治理 | `messageBatch`（read 0 Token / summarize 才按需派发，逐条报告失败）+ 控制台勾选与底部浮条「批量标记已读 / 丢给 AI 统一总结」 | `tests/message-inbox.test.ts`、`tests/message-dock.test.ts` |
| 工作台消息流一键拖拽到 Chat | 消息卡片可拖拽，把「参考消息：发件人《主题》」写入当前输入框，不发送、0 Token | `tests/message-dock.test.ts` |
| `craft-file-dir-desc` 目录↔描述双向检索 | `core/file-dir-desc.ts`：`observe`（自动强化，不改写描述）与 `record`（人工纠错）分离；observed→promoted（3 次真实使用）；`relocate` 保留身份与使用次数并拒绝覆盖；`revoke` 署名撤销后停止召回且不会被再次使用自动恢复。CLI `craft dirs`，HTTP record/promote/relocate/revoke/resolve/list | `tests/file-dir-desc.test.ts`、`tests/cli-dirs.test.ts`、`tests/workbench-server.test.ts`、`tests/pilot-coordinator.test.ts` |
| 工作台 UI 融合 | `mod-pages.js`（认知约束/目录语义/首次引导/切模式确认/观察室/阻塞队列）+ NAV + 三模式导航 | `tests/mod-pages.test.ts`、169 测试全绿 |
| 控制台待我批准批量治理 | `app.js` 勾选列 + 底部浮条「批量批准 / 批量稍后」，逐条走 `/api/inbox/decide`（一 effect 一授权，不合并语义），勾选跨重绘保持 | `tests/visual-layer.test.ts` |
| 桌面双击即应用（隐藏控制台） | `.tools/start-craft-workbench.ps1` 优先拉起 Tauri release exe、单实例、`-Browser` 降级；`.vbs` 隐藏窗口；`scripts/install-desktop-shortcut.ps1` 生成桌面/开始菜单 `.lnk`（图标 `assets/craft.ico`），数据目录固定 `~/.craft_data` | 构建产物 `craft-workbench-desktop.exe` 存在，快捷方式指向该 exe |

历史事件 `pilot.turn.mods.active_mods` 是旧版未过滤的配置记录，不能作为实际注入证据；新记录使用 `pilot.turn.mod_configuration.configured_mods` 并标记 `injection_verified: false`。历史事件保持原样，读取方应兼容两个事件名并将旧数据视为未验证。旧失败观察的 `active_mods` 在归因接口返回时不再暴露，标记为 `legacy_unverified`。

### 新增验证
- `tests/pilot-coordinator.test.ts`：目录打分、描述命中、歧义反问、历史任务冲突、workspace_resolution 回写（服务层 3 例 + 纯函数 12 例）。

## 安全边界（刻意保留，非缺口）
- 插件发现只产出提案，不自动安装、不写宿主配置、不执行外部命令；`writes_host_config: false` / `auto_installed: false` 是显式契约。
- 消息 `智能处理` 是唯一会触发模型/Worker 的路径；基础展示与监听全程 0 Token。
- 自进化 Mod 必须过影子回归集 `passed` 且人工署名批准，才进入 Worker 上下文。
- 不升级版本号；未触碰 `pnpm-lock` 版本与任何 Codex/Claude 配置。

### 收尾批次：注意力批量决策 + 评测覆盖补强（2026-11-09 续作）

**Attention 批量决策（一处用户动作 ≠ 一次授权）**：内核 `AttentionKernel.decideBatch` 对每张卡单独校验其原始版本并产出独立回执；单卡失败不回滚其余成功项，每张结果都命名所属卡片。入口贯通 service / MCP handler / HTTP：`craft inbox batch-ack|batch-defer --ids a,b [--by user]`、`craft_attention_decide_batch`、HTTP `POST /api/inbox/decide-batch`。校验项：非空数组、决策取值、单批 ≤50、去重；每张卡沿用 `decide` 的单卡合同（含 `source changed` 漂移拒绝）。测试 `tests/attention-batch.test.ts` 4 例覆盖：部分失败隔离、校验/去重/上限、defer 每卡 `until/reason`、service+MCP+HTTP 同源路由。

**评测覆盖补强（knowledge-evaluation-provenance）**：把晋升证明（promotion-proof）与裁定绑定（adjudication binding）的防御分支显式补测——`run.candidate_claim_refs/case_refs/case_ids` 缺失或类型异常、case ref `case_id` 非字符串/不存在/版本或 identity 漂移、`expected_claim_ids` 缺失、任务合同摘要缺失或不匹配、以及 `adjudication_id` 非字符串。该模块分支覆盖率由 96.55% 提升至 96.87%（剩余项集中于 `knowledgeClaimPromotionProofVerified` 内 `Array.isArray` 三元防御分支在 V8 单进程插桩下的假阴性，属已知遗留，不伪造覆盖）。

**本地网关接入（group/free）**：`.env.local` 已写入 `CRAFT_EVAL_PROVIDER=local-openai`、`CRAFT_EVAL_BASE_URL=http://127.0.0.1:3425/v1`、`CRAFT_EVAL_MODEL=group/free`、`CRAFT_EVAL_FRONTIER_MODEL=group/free`、`OPENAI_API_KEY_ENV=OPENAI_API_KEY`；`.env.example` 同形但 `OPENAI_API_KEY` 为占位（已被 gitignore，密钥不进仓）。`pnpm run eval:local` 即走该网关，跑评测/模拟/晋升/识别均可用；`eval:memory` 实测 5/5 通过（kernel 驱动，不消耗模型）。

**未做（诚实保留）**：`knowledge-evaluation-provenance` 剩余防御分支为假阴性；per-trial 干净隔离（Anthropic 建议）仍属 runner 深化下一批；跨平台桌面真机冒烟、真实 IMAP/WebSocket、云电脑远端仍为后续。

### 业界前沿（含本体论）对照 + 经验去重评测闭环（2026-11-09 续作）

**前沿调研（一手来源：arXiv 2507.10644 / 2506.18019 / 2505.02279、Anthropic *Effective context engineering*、TrustGraph PROV-O、MNEME/FlowX、OpenOntology、Semantica、GMEOW、SparrowOntology、HydraDB/EXL 生产后见）**：

- 协议分层已收敛为 MCP（工具/结构化上下文）→ ACP（消息）→ A2A（Agent Card/Task/Artifact 协作）→ ANP（DID/JSON-LD 开放市场）；OWL/FIPA 老标准被取代，但**「共享本体 + 类型化关系 + 可查询溯源」**仍是语义互操作核心。craft 已有 `a2a-*`、`mcp-*`、`plugin-adapters`、`generic-adapter-runtime` 等对应层。
- 知识单元应是 **claim 而非 fact**：每条 claim 带 source、confidence、valid-time、状态（asserted/proposed/disputed/retracted/superseded/derived）与 PROV-O 证据链；生产系统需要 append-only、bitemporal、permission-aware 的 context graph，并严格区分 Memory / Context / State。
- craft 对照结论：`knowledge_claim`/`memory_ledger` 已具备 `valid_until`、`supersedes`、`contradiction_ids`、`derived_from_ids`、`identity_digest`、scope envelope、双时钟（`observed_at`/`effective_from`）；`knowledge-relation.ts` 泛化 6 种 typed relation（`derives_from`/`supersedes`/`contradicts`/`supports`/`refines`/`references`）并支持 bitemporal `valid_to` + `as_of` 快照。这些恰是业界论文指出的多数系统缺失项，craft 已领先平均线。
- 生产后见警告（Lamco "technical success ≠ functional success"、Hendrickson "agent memory has a truth problem"）：平面 PITFALLS 日志无法程序化回答「这个组合是不是早被证伪」，会导致重复实验。craft 的 `experience-deduplication.ts` 正是补这个缺口——结构化 factor combination + 保守 `unknown` verdict + 按组合去重/防重蹈覆辙。

**本批交付（闭环）**：

- `ExperienceLedgerKernel.propose` 前置调用 `dedup.hasRefutedCombination(scenario_keys, "kind:id")`：已证伪组合直接拒绝，未证伪 subject 不受影响（正反两向都有测试）。
- service/MCP 暴露 `craft_experience_conclusion_record` / `_find` / `_refuted`，经 `durable-experience.ts` 安装、`kernel-delegates.ts` 类型声明、`action-handlers.ts` 路由；`ownership.ts` 的 `EXPERIENCE_FAMILIES` 声明该家族（防止 surface 静默漂移，与 ADR-0025 的历史 bug 模式同源）。
- **craft-eval 新轴 `experience_dedup`**（capability ledger，3 个 kernel 用例）：`refuted_combination_blocks_propose`、`untouched_combination_still_proposes`、`repeated_finding_reinforces_not_multiplies`。`core/eval-suite.ts` 的 `CAPABILITY_AXES`/`AXIS_LEDGER` 同步；`capability/craft-eval/suite.ts` 用真实 `ExperienceLedgerKernel` + `ExperienceDeduplicationKernel` 驱动，不凭字符串断言。
- 覆盖率：`experience-ledger.ts` 门禁组补 `tests/experience-ledger-dedup.test.ts` 后达到 **100% 行/函数/分支**；`eval-suite.ts`/`eval-cases.ts` 门禁补 singular-verb 分支后保持 100%。

**真实网关全量评测（group/free）**：28/28 全绿，capability 21/21（min 8）、safety 1/1、value 6/6（min 4），`quotable: true`，19 trials 全带 usage。四项审计（layering 591 模块 0 违规 / surfaces clean / consistency 9/9 / egress 0 违规）+ `tsc --noEmit` 0 错误 + 相关 94 项测试全绿。

### 本体论前沿落地：派生链失效传播 + 置信度衰减（2026-11-09 续作）

**调研对照结论**：PROV-O / SparrowOntology / GMEOW / MNEME 都把 `DERIVED_FROM` 当作一等关系，要求「基础 claim 被推翻时沿图找出所有需重评的派生 claim」，且置信度沿派生链下降。craft 的 `knowledge-relation.ts` 已有 `derives_from` 与有界遍历，但 `traverse` 不区分方向语义、不传播失效、不衰减置信——这是有证据的真实缺口。opencode 的 allow/ask/deny 权限精华 craft 已用 `action-gate.ts` 的 learn-not-to-ask（guard/invariant 分离）+ `internal-tool-authorization.ts` 的四级 tiered 分类更严谨地覆盖，不重复引入。

**本批交付**：

- 新深模块 `capability/craft-knowledge/knowledge-lineage-impact.ts`：**组合**（不复制）`KnowledgeRelationKernel.neighbors` 公开 seam，只读、有界（3 跳 / 200 节点、可选 `max_nodes`、visited 集防环）。语义：`source --derives_from--> target` 表示 source 派生自 target；refute target 时沿「以 target 为 target 的边」传播到 source，再递归。`contradicts`/`supersedes` 活边触发 `needs_reevaluation`；retracted 边（`as_of` 快照）不算。置信度以**衰减因子**表达（confirmed 1 / bounded 0.8 / 其余 0.5），不臆造绝对概率；缺 confidence 的遗留边 fail-closed 到最低信任。
- 接线：`knowledge-relation.ts` use-case 安装 `knowledgeLineageImpact` delegate、`kernel-delegates.ts` 类型声明、`action-handlers.ts` 路由、MCP `craft_knowledge_lineage_impact`、`ownership.ts` 的 `KNOWLEDGE_FAMILIES` 声明该家族（防 surface 静默漂移）。
- **craft-eval 新轴 `knowledge_lineage`**：2 个 kernel 用例（`refutation_flags_derived_claims` 验 2 个派生节点/深度/0.8 衰减/需重评，`unchallenged_root_does_not_claim_invalidation` 验不谎报失效）。用真实 `relationSave` + `knowledgeLineageImpact` 驱动，不是字符串断言。
- 覆盖：`tests/knowledge-lineage-impact.test.ts` 9 例全绿，模块 100% 行/函数/分支；新增独立门禁组 `knowledge-lineage-impact`；`eval-suite`/`eval-cases` 门禁保持 100%。

**真实网关全量评测（group/free）**：**30/30 全绿**，capability 23/23（min 8）、safety 1/1、value 6/6（min 4），`quotable: true`。`tsc --noEmit` 0 错误；layering **592 模块 0 违规** / surfaces clean / consistency 9/9 / egress 0 违规；service→MCP 冒烟读回 6 个契约字段；相关 39 项测试全绿。

### 评测治理：演进式套件比较 + CI 消费 + 元能力评测（2026-11-09 续作）

**发现的结构缺陷**：`compare-run-reports.ts` 把 `suite_digest` 纳入阻断身份。但**每次给 craft-eval 加轴/加用例都会改变 digest**——本会话刚加了 `experience_dedup`、`knowledge_lineage` 两个轴，旧基线报告立刻被判 `comparable: false`。也就是说「用评测驱动持续迭代」在套件演化时反而丧失回归检测，与目标直接冲突。

**本批交付（4 个相互支撑的能力）**：

1. **演进式比较**：`suite_digest` 从阻断身份改为 **evolution 元数据**。执行身份（provider / base_url / model）与 isolation 仍然必须一致；digest 不同时比较仍有效，回归检测在两份报告**共有 case_id 的交集**上运行，新增/移除用例显式列出，分母缩小不能藏回归。新增 `suite_evolution` + `suite_digest_delta` 字段，reason 标注 `suite evolved`。
2. **`compare.ts --json`**：输出单一机器可读 `Comparison` 对象供 CI 消费，退出契约不变（不可比较或存在回归 → exit 1）；人读模式追加 `suite evolution` 行。两种模式均已用真实文件冒烟（演进套件下检出回归、exit=1）。
3. **craft-eval 新轴 `eval_governance`**：2 个 held-out kernel 用例直接观察真实比较器——`evolved_suite_still_detects_regression`（digest 变化仍可比、仍检出 passed→failed）、`different_gateway_is_refused`（换模型/网关被拒）。评测工具自身的元能力从此也被评测。
4. **新门禁组 `eval-comparator`**：`compare-run-reports.ts` 达到 100% 行/函数/分支；补最小报告（缺 ledgers/results/verdict）fail-closed 用例。

**真实网关全量评测（group/free）**：**32/32 全绿**，capability 25/25（min 8）、safety 1/1、value 6/6（min 4），`quotable: true`，19 trials 全带 usage。`tsc --noEmit` 0 错误；五审计（layering 592 模块 0 违规 / surfaces clean / consistency 9/9 / egress 0 违规 / doc links clean）；`eval-suite`/`eval-cases`、新 `eval-comparator` 门禁均 100% 三项；相关 40 项测试全绿。

### 覆盖门禁子集运行（工程效率，2026-11-09 续作）

**缺口**：`scripts/coverage/coverage-gates.ts` 只能全量跑——232 个组、单次约数小时。改一个模块时，要么等完整扫完，要么手工 `node --test` 丢掉 manifest 里的阈值与分组语义。这正是迭代反复起数小时后台任务的原因，也让「小步快速验证」无法成立。

**本批交付**：

- 新增纯模块 `scripts/coverage/coverage-gate-select.ts`（可测，不进产物）：`selectGateGroups` 按**组名**或**被 include 的源文件路径**筛选（路径归一化 Windows/Unix 分隔符），同名多命中去重、保持 manifest 顺序；**未知选择器是错误而非空跑**（"0/0 组通过"会被误读成成功）；`parseGroupArguments` 支持 `--group a,b` / `--group=a,b` / 重复 `--group` / `--list`，未知选项直接失败。
- `coverage-gates.ts` 接入：`--list` 打印全部组名；`--group <sel>` 只跑选中组，汇总计数按**选中组数**计算（`2/2 groups passed`），不再用全量分母冒充。
- 新增独立门禁组 `coverage-gate-select`（100% 行/函数/分支）；`package.json` 增加 `test:coverage-gates:list` 与 `test:coverage-gates:one` 两个入口（pnpm 会吞参数，故直接用 node 调用）。
- 实测：`--list` 列出 232 组；`--group eval-comparator` → `selected 1/232` 且 `1/1 groups passed`；`--group coverage-gate-select,eval-comparator` → `2/2 groups passed`；`--group no-such` 明确报错 exit 1。

**验证**：`tsc --noEmit` 0 错误；四审计（layering 592 模块 0 违规 / surfaces clean / consistency 9/9 / doc links clean）；新门禁 100% 三项；相关 20 项测试全绿。

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
| self_evolution | 14 / 14 全过 | 影子门禁不可绕过、回归非恒真、候选可观测、坏源隔离、同内容不同文件都入库、目录语义用过才存／常用才转正／不虚增频次／撤销终局／搬迁保身份、项目名解析、合并图不丢跨文件 calls、选择器收纳大声明文件、shell/PowerShell 定义与调用边、TS 缺口内外分项 |
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

`local_type_parameters`（泛型参数 `T`/`K` 本地绑定）、`computed_invocations`（`a[b]()`、`(a ?? b)()` 等运行时调用）与 `inline_invocations`（`(() => …)()`）也单独计数；`!` 非空断言包裹的方法调用按普通属性调用解析。

实测（craft 自身仓库，1131 个 TS 文件）：`unresolved_relations` 125,980 → **86**（类型引用 / 继承 / 导入均归零，剩余为真实的同名歧义），`external_references` 125,178，`local_type_parameters` 112，`computed_invocations` 144，`inline_invocations` 47。评测 `evaluation_pass` 仍为 true 且 precision/recall 全 1.0，说明这不是靠放宽门槛。

其中最后一跳来自**解构式动态导入**：`const { Kernel } = await import("./kernel.ts")` 把 `Kernel` 绑到 `BindingElement` 而非类声明，因此所有 `new Kernel()` 都连不上边。现在记录「局部名 → 来源模块」映射，并在目标模块内按唯一同名声明解析（同名多定义仍拒绝猜测）。

工作台「关系健康」页读取 `GET /api/workbench/codebase/status` 的顶层 `relation_diagnostics`：既然按文件单元增量合并，样本也必须随单元携带（v10 起 `TypeScriptFileUnit` 带 `unresolved_call_samples`），否则页面在实际路径上永远看不到样本。健康摘要只挂最新索引，避免把 25 行索引的状态载荷撑破。


#### 有证据重新规划当前边界

`task_replan_prepare/decide/execute/get` 提供版本固定的申请、决定、单次消费和读回；Workbench 任务页提供同链操作。停止与清理不明、未知费用、过期/撤销/已消费证据、来源版本变化均拒绝继续；事务失败不产生半份新计划。完整指令保存在任务域提案中供批准前核对，人工计划变更与程序修复证据严格区分。新根保留原任务范围和验收约束，写入重新审批，原账单与旧结果不被覆盖。

围栏覆盖总预算根、开始返工的链及显式申请重新规划的旧根；未纳入的无限制历史根暂保持兼容。专用 activation/managed 编排回原规划入口，可信操作者标识不等同新增认证；真实账单与平台证明仍未完成。详见 `whole-plan-batches.md`，总理想态继续按 A–F 推进。


#### 风险触发审查当前边界

`TaskControl.review_risks` 和 WorkControl 准备参数固定事前风险声明；外部写入权限自动命中规则。风险任务自动拥有必需程序条件及 `risk_independent_review` 冻结人工条件，普通通过接口不能绕过，返工和重新规划保留风险与审查门。任务页显示命中规则及版本，冻结时自动选择必需审查条件。规则依据结构化声明，不自动识别未声明的语义风险；未声称原生聊天、全部权限/扩展/晋升入口已经绑定、隔离复验或身份认证已完成。实现与验证见 `whole-plan-batches.md`。
