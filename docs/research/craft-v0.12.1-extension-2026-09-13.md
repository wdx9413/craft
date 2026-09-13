# Craft v0.12.1 增量方案：理想态收敛 — 把 P0 缺口全收进 v0.12.1

> as_of: 2026-09-13
> 上一方案：`craft-v0.12.1-plan-2026-09-13.md`（W0/W1/W2/W3/W4/W5/W6 已实施）
> 理想态调研：`agent-native-runtime-ideal-state-2026-09-09.md`（P0/P1/P2 优先级）
> 差距调研：`agent-harness-capability-gap-2026-09-08.md`（v0.9.5 基线，承接 v0.11.x 实施）
> 本方案目的：在 v0.12.1 单一版本内把"老板问的'理想态还差什么'"的 P0 缺口全部收敛

---

## 结论（一段话）

**v0.12.1 上半版（W0/W1/W2/W4/W5/W6 + W3 指标聚合）已经把结构、接入面、独立腿、资产、知识、分发都改对。下半版要补的不是"再加能力"，而是把"P0 缺口"——hook 真实挂载、store 迁移机制、src 六层分层、A0–A3 串接、Effect Policy-as-code、Eval Runner、Experience Miner——**一次性闭合**。**

理由：

1. **理想态（`agent-native-runtime-ideal-state-2026-09-09.md` P0）三条**——Durable Runtime Driver、Effect Policy、自动 Eval Runner——都是"已有对象的强制点"，不是"新对象"。补它们不需要重写，只需要在已有 dispatch / effect / trial 路径上挂门。
2. **老板原话**："看看距离理想态还差哪些，都做在 v0.12.1 里吧"。所以本方案把已识别的硬缺口全部纳入 v0.12.1，**不再推迟到 v0.12.2**。
3. **风险**：上半版刚做 W3+W5，已把指标聚合与 TTL 串到 MCP。**下半版最大风险是 hook 硬化改变默认行为**——因此给关闭开关 + 迁移说明，并把"是否默认开启 audit-log/token-meter/receipt-check"作为产线配置，而非内置不可关。

---

## 缺口盘点（v0.12.1 上半版之后）

| # | 缺口 | 严重度 | 来源 | 处置（v0.12.1 内） |
| --- | --- | --- | --- | --- |
| **G3** | Hook 未挂真实执行路径：`service.ts:2436` 仅 `craft_hook_run` 调用，verified-work-loop / internal-host-driver 的 dispatch 前后无 hook | **高** | v0.12.1 方案 §W3 | W8 |
| **G4** | Store 无迁移机制：`SCHEMA_VERSION=3` 但无 migration 脚本；store.ts 全文 `migration`/`migrate` 出现 0 次（仅 tool-plane 提到 2 次） | **高** | v0.12.1 方案 §W0 | W7 |
| **G9** | src 扁平、`service.ts` 3382 行、485 工具单文件 `mcp.ts` | 中 | v0.12.1 方案 §W0 | W9（骨架，不搬逻辑） |
| **P0-RT** | Runtime Driver 未真正统一：Operation 不可变绑定 Route + 幂等键 + 审批 + 过期；RunState 的 pending_approval / 超时 / 重试 / 崩溃恢复未贯通 | **高** | 理想态 §P0-1 | W8（hook 挂载时一并修） |
| **P0-Eff** | Effect Policy-as-code 缺失：read/write/execute/network/publish 五类 Effect、命令/路径/域名 allowlist、短期凭据、幂等键、补偿标记、脱敏尚未贯通 | **高** | 理想态 §P0-2 + 差距 §2 | W11 |
| **P0-Eval** | Eval Runner 缺失：`eval-campaign.ts` 48L、capability-canary.ts 70L，皆无 Runner 概念；无法固定 Suite×Subject×Case×N trials 并锁定版本 | **高** | 理想态 §P0-3 + 差距 §3 | W12 |
| **P1-Mine** | Experience Miner 缺失：candidate 生成 + shadow eval + Signoff + 精确回滚版本号；只有 capability-canary.ts 一处提及 `candidate` | 中 | 理想态 §P1-4 + 差距 §4 | W13 |
| **A0–A3** | 自主阶梯未串接：`autonomy-ladder.ts` 49L 已存 AutonomyLadderKernel，但 route / asset router / dispatch 不知此 level，影响 A2/A3 的 Effect 准入 | 中 | 差距 §2 + 理想态 §执行面 | W10 |

---

## 明确不在这版（已确认留白）

- ❌ 默认多 Agent / 复杂多 Agent 拓扑（前置未满足）
- ❌ Craft 自己的对话 UI / 桌面 Canvas（老板明确 UI 不急）
- ❌ 远程 Hub / A2A 商店 / 市场审核提交
- ❌ 自动自进化：candidate 经 shadow eval 后**只升 candidate→eval→verified**，绝不自动改默认路由或默认 Workflow
- ❌ 强隔离宣称：PlatformProfile 仅"可证明边界"，不宣称 sandbox
- ❌ macOS/Linux 真机 Conformance（本机无；CI windows-only 单平台仍延续；不在文档宣称已支持）

---

## 七个新增工作流（W7–W13）

按"修改而非新增"原则：能挂到现有对象的，绝不新建表 / 新建模块 / 新建文件类型。

### W7 Store 迁移机制（v3→v4）

**目标**：大版本新增表 / 改字段时，可声明、有序、可回滚。

**交付**

1. `src/store-migrations.ts`：迁移注册表 `migrations: Array<{from, to, up: tx => void, down: tx => void}>` + `applyMigrations(db)` 按版本号有序执行 + `BEGIN IMMEDIATE` 事务 + 失败自动 `ROLLBACK`。
2. `src/store.ts` 改为 `applyMigrations()` 替代"直接 CREATE TABLE IF NOT EXISTS"。
3. 升级 `SCHEMA_VERSION` 到 4；v3→v4 迁移示例：`records.payload_json` 增加索引候选 / `meta` 表增加 `applied_at` 列。
4. 备份回滚：`store:apply` 前把 `craft.db` 备份到 `craft.db.bak.<ts>`，失败时回退。
5. `scripts/migrate.ts` 提供 `--dry-run` / `--backup` / `--rollback <N>` 三个开关。
7. 测试：迁移正/反向各一条，独立小 DB。

**验收**：`store:apply` 与 `store:apply --rollback 1` 各跑一次，对比 payload 与版本号；测试断言回滚后 schema 仍是 v3。

**不做**：不改业务表语义；不引入 ORM。

### W8 Hook 真实挂载 dispatch 路径 + Runtime Driver 强化

**目标**：hook 不是"可用"，是"在执行路径上强制"。

**交付**

1. `src/verified-work-loop.ts` 与 `src/internal-host-driver.ts`：在 `dispatch(effect)` 前后调 `runHooks([{point:'before_effect',...},{point:'after_receipt',...}])`；`on_failure` 在 catch 中触发。
2. `src/runtime-driver.ts`（新）：把 Operation 绑定 `idempotency_key` + `route_id` + `policy_hash` + `expires_at` + `effect_scope`；RunState 增 `pending_approval` / `timed_out` / `retry_count` / `crash_recovered` 四种状态。
3. 入口开关：`config.runtime.strictHooks: boolean`（默认 true）；关闭时仅记录事件不阻断。
4. 真实 receipt：每次 hook 触发都写 `events` 表一条 `{kind:'hook', hook_id, point, status, fail_policy}`；MCP 入口 `craft_hook_audit` 列出最近 N 条。
5. 治理链不变：audit-log / token-meter / receipt-check 内置；`fail_closed` 默认阻断。

**验收**：跑一个真实小任务（含成功 + 失败两条），断言 `events` 表至少有 4 条 hook 触发（before_effect + after_receipt ×2）；关闭 `strictHooks` 后事件仍有记录但不再 fail_closed 阻断。

**不做**：不把 hook 改成可热加载脚本；不引入第三方 hook 协议。

### W9 src 六层分层骨架

**目标**：增长风险降到"每新增能力有明确归宿"，不强制搬迁。

**交付**

1. 建六层目录与 barrel：
   - `src/surface/`（入口适配：mcp / cli / workbench / adapters）
   - `src/application/`（按域的用例编排）
   - `src/kernel/`（纯逻辑：policy / budget / hook / registry / router）
   - `src/store/`（sqlite + 迁移 + 索引）
   - `src/host/`（driver 协议 + codex / claude / internal 三实现）
   - `src/assets/`（capability / knowledge / workflow 三类资产的统一信封）
2. 新文件直接进对应层（kernel/mcp.ts / surface/cli.ts 等不强制迁）；旧文件保留原路径，**仅通过 barrel `src/index.ts` 重新导出**，不引入 `import './xxx/yyy.ts'` 链。
3. `tsconfig.build.json` 调整 include：六层目录优先，旧 `src/*.ts` 仍兼容。
4. 测试：用 `grep -l "from './" src/**/*.ts` 检视 import 拓扑是否有循环。

**验收**：`grep -E "^import.*\\.\\.\\./\\.\\./" src/surface/mcp.ts` 等返回空（或仅合法）；`tsc --noEmit` 与 100% 覆盖率不降；新模块可写 `import { X } from "../kernel/policy.ts"`。

**不做**：一次性把 95 个 ts 搬完；不改 service.ts 行数。

### W10 A0–A3 自主阶梯串接

**目标**：阶梯不是"装饰"，是"决策约束"。

**交付**

1. `src/autonomy-ladder.ts` 扩展：
   - `LadderPolicy`：`{level: 'A0'|'A1'|'A2'|'A3', effect_allowlist: EffectClass[], require_approval_for: EffectClass[], allow_network: boolean}`。
   - `decideAction(plan, ladder): Decision`：根据当前 level 与 plan 的 Effect 类型，给出 approve / pause_for_human / reject。
2. `src/asset-router.ts`（已存）route 决策中读取 `ladder.level`，过滤掉不允许的 Effect；A2 写入要求 `require_approval_for` 含此 EffectClass 时进入 pending_approval。
3. `src/runtime-driver.ts`（W8）的 RunState 接受 `pending_approval`，恢复时二次校验 ladder 是否仍允许（防止审批后 ladder 收紧）。
4. 测试：5 个用例各跑一个 plan，分别得到 approve / pause / reject；任一恢复后 ladder 收紧，自动 reject。

**验收**：自动测试覆盖 A0–A3 四等级 × 5 类 Effect 的 20 组合；恢复二次校验有 2 条断言。

**不做**：不引入"自动升级 ladder"的逻辑。

### W11 Effect Policy-as-code

**目标**：工具安全落在每次副作用调用，不只靠总路线提示。

**交付**

1. `src/effect-policy.ts`（新）：
   - `EffectClass` 枚举：`read | write | execute | network | publish`。
   - `PolicySpec`：`{read_paths?:string[], write_paths?:string[], exec_allowlist?:RegExp[], network_allowlist?:string[], network_denylist?:string[], publish_targets?:string[]}`。
   - `evaluate(policy, action): {ok: boolean, reason?: string}`：纯函数，可测。
2. 与 `effects.ts` 集成：在 `ExternalEffectKernel.dispatch` 前调 `evaluate`；不通过则直接拒绝并写 events。
3. 幂等键：`Operation.idempotency_key` 必填，缺则拒绝；同 key 二次调用返回首次 receipt。
4. 脱敏：`EffectPolicy.redact(payload): JsonObject`：递归擦除 `api_key|secret|token|cookie` 等敏感字段，再写入 events / Receipt。
5. `craft_policy_apply` / `craft_policy_eval` 两个 MCP 入口。
6. 测试：5 类 Effect × 4 类 policy 共 20 条断言；幂等键 3 条；脱敏 5 条。

**验收**：`evaluate` 100% 覆盖；网络出口白名单命中 / 未命中各 1 条；脱敏后 `payload_json` 不含敏感字符串。

**不做**：不引入 OS 级沙箱；不强制路径外禁止。

### W12 Eval Runner（P0）

**目标**：固定版本、多次 trial、确定性 Grader、与 baseline 配对比较。

**交付**

1. `src/eval-runner.ts`（新）：
   - `EvalSubject`：`{kind:'workflow'|'skill'|'route', id, model?, host?, tools_fingerprint, env_fingerprint}`。
   - `EvalTrial`：`{subject, case_id, grader: GraderSpec, inputs, outputs, observation, score, latency_ms, cost, verdict}`。
   - `runTrials(spec)`：按 `Suite × Subject × Case × N trials` 顺序跑，**锁定 model/host/tool/env 指纹**，输出 trial 表。
   - 与 baseline 配对：t 检验 + bootstrap CI；不可比时输出 `inconclusive`（**绝不强制 verdict**）。
2. `src/graders.ts`：内置三类 Grader：
   - `DeterministicStateGrader`（断言返回值 / 文件存在 / 命令 exit=0）
   - `ReceiptGrader`（断言每次 Effect 都有 receipt + idempotency_key 命中）
   - `RubricGrader`（LLM Judge；只在 calibration 后参与 Gate，否则只出 `diagnostic`）
3. MCP 入口：`craft_eval_run` 接受 `{suite, subject, trials, baseline?}`，返回 trial 表与 verdict；`craft_eval_report` 聚合。
4. 测试：5 个 case × 2 个 subject × 3 trials = 30 trials；baseline 配对 1 条；不可比时 verdict=inconclusive 1 条。

**验收**：trial 数 ≥ 30；verdict 在配对差异显著时输出 `passed` / `regressed` / `inconclusive`；不输出"通过"给模型自信。

**不做**：不做自动 Signoff；不做自动改默认。

### W13 Experience Miner 基础版（P1）

**目标**：Trace 聚类生成 candidate，shadow eval 验证，Signoff 后只升 candidate→eval→verified，**绝不自动改默认**。

**交付**

1. `src/experience-miner.ts`（新）：
   - `clusterTraces(traces, similarity: 'prefix'|'effect'|'route')`: 把 N 条同 route_id / 同 effect_scope 的 trace 聚类。
   - `proposeCandidate(cluster): Candidate`：`{kind:'skill'|'workflow'|'route', base_revision, change_axis, diff, applicable_conditions, evidence[]}`。
   - `shadowRun(candidate, baseline, cases)`：在 shadow 区跑 candidate，不写主存储；输出 `shadow_report`。
   - `signoff(candidate, shadow_report, reviewer)`：人工签发，不自动；签发后 candidate → verified，不改默认路由。
2. 落数据管道：trace → episodic → candidate → eval → verified，沿用现有 Trial/Outcome 链。
3. 淘汰机制：`stale(revision, days, eval_regression)` 标记 candidate 为 `deprecated`，**不自动删**。
4. MCP 入口：`craft_mine_propose`、`craft_mine_shadow`、`craft_mine_signoff`、`craft_mine_list`。
5. 测试：聚类 3 条；candidate 生成 1 条；shadow 跑 2 个 case × 2 trials；signoff 后状态变 verified。

**验收**：candidate 全部带 `change_axis`（限制只改 4 个轴：capability_profile / context_template / verifier_steps / 启用 Expert）；shadow 与主路径**严格隔离**（独立 db 或 schema）；signoff 路径强制人工 reviewer 字段。

**不做**：不做"自动把 candidate 设为默认"；不做"一次成功就改 Prompt"。

---

## 阶段顺序与依赖

```text
W7 (store migrate) ──┬──► W8 (hook 真实挂 + Runtime Driver) ──┬──► W10 (A0-A3)
                    │                                          │
                    ├──► W9 (六层骨架) ───────────────────────► │
                    │                                          │
                    └──► W11 (Effect Policy) ──────────────────►│
                                                               │
                                              ┌────────────────┤
                                              ▼                ▼
                                          W12 (Eval Runner)  W13 (Experience Miner)
                                              │                │
                                              └─────► W14 (门禁 + 打包) ◄─────┘
```

依赖：

- W7 是 W11 / W13 的前置（store 要可迁移才能加 effect-policy 表 / miner 表）
- W8 是 W10 / W11 的前置（hook 路径确定后才能决定 Effect 准入的 hook 点）
- W12 是 W13 的前置（Eval Runner 跑通后 Experience Miner 才能跑 shadow eval）

---

## 验收总表

| 项 | 标准 |
| --- | --- |
| 测试 | 475 → **≥ 540**（+65）；0 fail |
| 覆盖率 | 行 / 函数 / 分支 **100 / 100 / 100**（不降，不加 ignore） |
| 类型 | `tsc --noEmit` exit 0 |
| 版本 | `version:check` 绿 + 无散落字面量 |
| Hook 真实挂载 | 跑通 1 个真实小任务，`events` 表 hook 行 ≥ 4 |
| Store 迁移 | `apply` + `--rollback 1` + `--backup` + `--dry-run` 各自独立测 |
| src 分层 | `surface/` / `application/` / `kernel/` / `store/` / `host/` / `assets/` 存在并 barrel 化 |
| 自主阶梯 | A0–A3 × 5 Effect 20 组合断言全过 |
| Effect Policy | 20 条 evaluate 断言 + 3 条幂等 + 5 条脱敏 |
| Eval Runner | ≥ 30 trials；不可比 → inconclusive；baseline 配对 1 条 |
| Experience Miner | candidate 必带 change_axis；shadow 与主路径隔离；signoff 强制 reviewer |
| 分发 | `craft-workbuddy-expert-v0.12.1.zip` + `craft-workbuddy-connector-v0.12.1.zip` 解包可启 |

---

## 风险与诚实边界

1. **W8 hook 真实挂载会改变默认行为**：默认 `strictHooks=true`；提供 `strictHooks=false` 关闭开关；老的 `craft_hook_run` 仍可用作手动入口。失败关闭策略附 migration note。
2. **W11 Effect Policy 可能误杀**：默认 policy = 当前 Kernel 默认 allowlist；不主动收紧任何业务路径。**policy 收紧必须经过 Signoff，不在 v0.12.1 自动做。**
3. **W12 Eval Runner 的 LLM Judge 校准**：RubricGrader 首次只作 diagnostic，不参与 Gate；calibration 用三组人标 + 模型 Judge 配对。
4. **W13 Experience Miner 绝不会自动改默认**：Signoff 必须 reviewer 字段；candidate→verified 不改路由表。
5. **W9 六层骨架不强制搬迁**：旧 `src/*.ts` 仍可用，barrel `src/index.ts` 兼容；分批迁，不一次性大改 import。
6. **三平台 Conformance 仍是 windows-only**：本机无 macOS/Linux 真机；CI 也仅 windows-latest。**新接口不依赖平台特定分支**，但不宣称已支持。

---

## 推进节奏

每批独立验收：

| 批 | 工作流 | 验证 | 期望测试增 |
| --- | --- | --- | --- |
| 批 1 | W7 + W8 + W9（基础） | 475 → 510 | +35 |
| 批 2 | W10 + W11 | 510 → 535 | +25 |
| 批 3 | W12 + W13 | 535 → 550 | +15 |
| 批 4 | W14（门禁 + 打包 + 文档同步） | 550 测试绿、版本号一致、zip 重建 | — |

每批结束需向用户回报测试增量与覆盖率，再继续下一批。