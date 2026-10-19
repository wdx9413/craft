Warning: truncated output (original token count: 37798)
Total output lines: 2618

## v0.12.72（Knowledge 独立评测来源门禁）

- Knowledge 检索评测只有在来源会话、任务、Evidence、脱敏状态和留出分区均可核验，且与被评 Claim 来源隔离时才具备评测资格。
- Wiki 候选评测授权要求绑定具备来源证明的 Knowledge 检索评测；普通 `eligible` 状态或被篡改的指标不能绕过来源门禁。
- 增加独立会话来源、候选评测桥接和失败分支回归验证。

## v0.12.71（Experience 空闲轮询退避）

- Experience Worker 空队列时逐步延长轮询间隔，最长 5 分钟；检测到分类、候选或评测工作后恢复基础间隔。
- 增加长驻 Worker 间隔验证，保持 Worker 文件语句、分支、函数、行覆盖率 100%。

## v0.12.70（Experience 独立会话来源）

- Experience Host 观察保留精确来源会话标识；候选提案要求来源来自不同 Host 会话，同一会话内的多条任务不再冒充独立证据。
- 场景分类 Worker 将来源会话标识带回终结记录；旧请求不补造会话标识。
- 增加 Hook、MCP、分类 Worker 和 Experience 提案的独立会话回归验证。

## v0.12.69（Knowledge 候选状态保留）

- Host 评审认为证据不足或无法晋升时，保留 Claim 原有候选状态；仅明确驳回才标记为争议，避免 Worker 把待补证候选误降级为过期。
- 增加状态保留与拒绝分支回归验证。

## v0.12.68（Codebase 项目数据与检索评测）

- 仓库快照、语义图分片、分析缓存和检索评测报告写入项目 `.craft_data/codebase/`；必要时只修改该仓库私有 `.git/info/exclude`，避免把生成数据提交到 Git。
- 改进中英文任务描述的符号检索排序，并修正 Go 接口实现关系的范围识别。
- 增加评测报告持久化、项目数据 Git 排除、缓存重建和关系图覆盖回归。
- 修复跨平台适配器构建步骤。

## v0.12.67（Knowledge Ticket 项目根目录解析）

- Knowledge 分类 Ticket 列表依据 Claim 的可信 Source 定位场景目录；同一项目存在多个工作树别名且旧 Claim 指向全局 Markdown 时，仍能列出有效 Ticket。
- Source 项目根推导逻辑收敛为 Knowledge 共享辅助函数，供摄取与 Ticket 场景校验复用。
- 增加多路径别名和旧全局内容引用回归。

## v0.12.66（Knowledge Source 项目路径修复）

- 项目 README Source 重摄取时，按已登记的 Source 根目录绑定项目 Knowledge 内容与场景目录，避免同一项目的多个工作树路径别名造成路径歧义。
- 旧 Claim 引用全局 Markdown 路径且没有场景键时，不再因无效目录更新阻断 Source 重摄取。
- 增加旧全局内容路径、多项目路径别名和自定义 Source 的回归验证。

## v0.12.63（Knowledge Worker 项目根目录恢复）

- 后台 Knowledge 分类 Worker 从项目 Claim 的精确 `.craft_data/knowledge/md` 内容路径推导项目根目录，继续使用项目隔离的场景目录和模型票据；全局 Claim 不推导项目根目录。
- MCP 场景目录查询与模型票据工具公开可选 `project_root` 参数，避免 Worker 传参被工具契约丢弃。
- 增加路径有效性、错误路径、工具 Schema 和真实 MCP 调用回归验证。

## v0.12.64（Knowledge 项目票据校验闭环）

- Knowledge 分类 Ticket 校验沿用 Worker 提供的已登记项目根目录；未登记根目录仍拒绝，确保场景目录隔离。
- 项目 Claim 带有无法映射到项目根目录的旧内容引用时，Worker 将其作为受控跳过记录，继续处理其余 Claim。
- 增加 Ticket 项目范围校验、旧引用跳过和分类分支覆盖回归。

## v0.12.65（Knowledge 全局目录隔离）

- 项目 Claim 若引用的是全局 `$CRAFT_DATA_DIR/knowledge/md` 内容，Worker 不再把用户主目录误识别为项目根；该 Claim 会受控跳过，其他可定位项目继续分类。
- 增加全局内容路径隔离回归，Knowledge 分类覆盖率保持行、分支、函数 100%。

## v0.12.60（项目级 Knowledge 隔离）

- 项目 Knowledge 正文改为写入各自项目的 `.craft_data/knowledge/md`；场景目录也归属该项目的 `.craft_data/knowledge`，不再落入全局数据目录。
- Knowledge 内容读取校验 Claim 范围；未登记项目路径时拒绝写入，防止不同项目串用全局目录。
- 自动审核工具要求调用方提供明确范围；缺少范围或范围外 Claim 不会进入审核。同步更新 Context 工具说明与隔离、回归测试。

## v0.12.59（Knowledge 评测工具发现）

- Context 的 Knowledge 工具发现新增固定评测用例保存、列表、执行与结果读取接口，允许 Agent 从统一入口建立和运行 Knowledge 检索评测。
- 增加对工具名与输入参数结构的回归验证。

## v0.12.58（Knowledge 候选摄取幂等）

- 相同来源片段合并到候选 Claim 时，仅在新增 Evidence 引用时保存新版本；重复摄取不再反复递增 Claim 版本，避免 Worker 对未变化内容空转重审。
- 增加跨重复文件、重复轮次摄取的回归验证，确保 Evidence 集合保持唯一且版本稳定。

## v0.12.57（Knowledge Host 结构化输出）

- Knowledge 分类与 Evidence 审核向 Codex Host 传递严格 JSON Schema，CLI 使用 `--output-schema` 限定响应；不同响应契约使用独立 schema。
- Schema 只在系统临时目录以私有权限短暂写入，并在成功或失败后删除；模型回复仍不持久化。
- 分类输入摘要升级契约版本，使旧失败记录不会阻止新输出约束下的受控重试；增加 Host 参数、schema 校验、清理和分类请求覆盖。

## v0.12.56（Knowledge 失败票据抑制）

- Knowledge 模型完成后若分类或审核失败，只保存票据、输入摘要、失败阶段、受控错误码和时间；相同输入不再每轮重复发送，状态保存在 `~/.craft_data/knowledge/classifi…34798 tokens truncated…he failure *and* its fix — and `requires_review` no
  longer gates a user-requested working pattern, which is already vouched for by
  the person who asked.

### Harness/session decoupling

- Whether the harness can be replaced without losing the session was previously
  *claimed*; it is now *demonstrated*.
  `tests/harness-session-decoupling.test.ts` boots three independent store
  instances with no in-memory object shared between them, and shows that a fresh
  harness recovers and continues a session, that a paused session survives a
  close/reopen and is resumable by a different harness, and that replaying the
  log reproduces identical history with the trace as an independent witness.
- `scripts/audit-v01234-layering.mjs` checks the declared layer direction. Only
  seven kernels import upward, all composition roots or compatibility shims.

### Seven surfaces added

`craft_context_project`, `craft_context_restore`, `craft_bm25_search`,
`craft_retrieval_fuse`, `craft_experience_capture_decide` and
`craft_experience_capture_build` are registered on the service facade and reachable
through MCP, with end-to-end tests through the real server rather than direct calls.

### Tests

- `tests/ideal-state-gaps.test.ts` — 20 tests at 100% line, branch and
  function coverage, plus end-to-end MCP calls.
- `tests/harness-session-decoupling.test.ts` — 3 behavioural tests.

## v0.12.33

Version unification, the distribution chain, and the first-run path. The theme is
that the runtime was already capable; what was missing was the last mile between
those capabilities and a user being able to succeed.

### Versioning

- `craft` and `craft-marketplace` now agree on `0.12.33`. Before this release the
  marketplace manifests said `0.12.32`, its README said `0.12.31`, and craft said
  `0.12.30` — three-way drift with nothing to detect it.
- `scripts/check-version.ts` now also verifies the sibling `craft-marketplace`
  checkout (release manifest, plugin manifests, README) when it is present, so the
  drift cannot recur. It validates craft alone when that checkout is absent.
- `release.json` records the exact craft `source_commit` the marketplace was cut
  from, refreshed at bump time rather than left stale.

### Distribution

- `.github/workflows/desktop-release.yml` builds the Windows ZIP on a Windows
  runner and the macOS DMG on a macOS runner, then attaches both to the GitHub
  Release. Previously no workflow built a desktop package and no release carried
  an asset, so a user had no download entry point at all.
- `package.json` `files` narrowed from `dist` to `dist/src` and `dist/plugin`. A
  bare `dist` would have published the 35MB Windows ZIP and the macOS `.app`
  bundle to npm — 1172 desktop artifacts.
- `publish.yml` runs the version check explicitly before publishing.

### First run

- `scripts/windows-launcher.cs` reads `%LOCALAPPDATA%\Craft\credentials.env` and
  injects each pair into the child environment, using the same mechanism that
  already injected `CRAFT_DATA_DIR`. A pasted key now reaches `env[apiKeyEnv]`
  without the user editing a system environment variable.
- `src/distribution-and-first-run.ts` adds credential resolution with an explicit overlay
  order, `readCredentialFile`, and `firstRunReadiness`, which answers "can a user
  run this right now" and names the exact variable that unblocks them.
- Six MCP tools expose this surface: `craft_first_run_readiness`,
  `craft_credential_resolve`, `craft_mcp_protocol_negotiate`,
  `craft_mcp_migration_assess`, `craft_isolation_capability_get`,
  `craft_distribution_plan_get`.

### Protocol

- MCP protocol negotiation is now explicit: a requested version that is not
  supported is recorded as a downgrade with a reason instead of silently falling
  back. The 2026-07-28 revision is tracked as `assessed_deferred`, with
  `assessMcpMigration` naming what blocks adoption (MRTR support, and mapping the
  durable task model to `io.modelcontextprotocol/tasks`).

### Honesty fixes

- `a2a-v1-adapter.ts` no longer writes `verified_transport: true`. The digest was
  the card hashing itself with no trusted key, so the record now states
  `transport_observed: true`, `signature_verified: false`, `signature_scheme: null`
  and `card_trust: "self_asserted"`. The old field claimed a signed-Agent-Card
  guarantee this adapter never provided.
- `isolationCapability` reports Windows as `enforced: false`. The `job_object`
  boundary is declared, not executed, so generated-code writes on Windows still
  require approval; the previous wording implied parity with macOS and Linux.
- README corrected in both directions: it understated a shipped HTTP transport
  (line 92) and disclaimed desktop packages that now exist (line 156).

### Studio approval surface

- Studio now has a **「待我批准」** view, the first persistent place to approve
  work. The runtime's headline guarantee is an approval gate, yet Studio had no
  pending-approval entry point at all — the most visible self-inconsistency
  between the backend and the product surface.
- It consumes the existing `/api/inbox/refresh` and `/api/inbox/decide`, which
  were already a persistent SQLite projection, so this required **no kernel
  change**. Decisions survive a page reload; previously an approval existed only
  for the life of the session.
- The view matches the real `attention_item` contract from `src/attention.ts`
  (`reason` / `action` / `priority` / `audience` / `details`), not an assumed
  shape, and offers only the two decisions the kernel accepts (`acknowledge`,
  `defer`), with a future `deferred_until` for deferral.
- `tests/studio-server.test.ts` asserts the served bundle actually wires the
  view, and that assertion was verified to fail when the nav entry is
  disconnected. Studio's reachable endpoints rise from 19 to 23.

### Tests

- `tests/first-run-readiness.test.ts` covers the new surface at 100% line,
  branch and function coverage, wired into the aggregate `test` chain.
