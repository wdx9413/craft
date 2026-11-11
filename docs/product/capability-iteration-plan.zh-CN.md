# Craft capability 迭代计划：治理式学习闭环与最小充分 Context

## 范围与判断

本计划面向 Codex 上的 `craft-context` 0.20.3 现状：机制层已有 Knowledge、Memory、Experience、Codebase、Quality、Evolution 与最小 syscall 面，不应继续堆工具名或新增第五个 Context 成员。真正缺口在运行态证据链：项目身份迁移阻塞、Experience/Knowledge 的部分错误被泛化成 `INTERNAL_ERROR`、Hook/Skill 收尾漂移、`emissions=0`、feedback 全部 `unrated`、CLI Doctor 不显示学习闭环状态，以及 discover 一次返回过宽 schema。

本轮按共享理解只修改 `craft/` 与工作区 `.agents/skills`。不修改 Codex 全局 `config.toml`、插件缓存、`~/.craft_data` live 数据、GitHub Issues、Marketplace 清单；不执行 `apply_registry_migration`、`apply_data_migration`；不自动发布、升级默认版本或物理删除旧 scope。

## 规范术语

- `Governed Learning Loop（治理式学习闭环）`：观察 → 候选 → 独立证据 → 任务效果 → Signoff → Canary → 可回滚。不是自动自改或自动发布。
- `Minimal Sufficient Context（最小充分 Context）`：引用、版本、digest、约束与遗漏原因优先，正文按需展开；用 coverage 与 used outcome 证明而不是扩大 `max_chars`。
- `Readiness Doctor（闭环 Doctor）`：只读状态投影，区分配置存在、Hook 执行、worker 锁/游标、Context 注入、反馈归因与学习资产存量。

## P0：机制可跑与可诊断

| 验收条件 | 本轮实现 | 证据 |
| --- | --- | --- |
| 未分类错误不再吞成 `INTERNAL_ERROR` | `safeFailure` 使用 `operationErrorCode` 分类并附带原始错误文本；保留 `CraftOperationError` 的 code/stage/safeDetails | `tests/context-readiness-doctor.test.ts` 断言窄面错误有稳定码和可读信息 |
| Readiness Doctor 是共用只读投影 | 新增 `craft_context_doctor` 与 `contextReadinessDoctor`，CLI `craft doctor` 复用；输出 surface、data space、身份/迁移状态、activation、worker、learning state、组件计数、Context stats/feedback/token | `tests/context-readiness-doctor.test.ts` 验证无正文、无执行权、配置不等于执行证明 |
| 项目身份迁移保持 fail-closed | 不修改 `PROJECT_IDENTITY_MIGRATION_REQUIRED`；Doctor 显示迁移记录但不得读取或自动合并旧 scope | `core/scope-identity.ts`、`docs/technical/modules/project-registry-migration.md` 保持原契约 |
| 最小充分工具发现 | `discoverContextTools` 默认兼容旧完整集合；显式 `limit` 按 1–5 分片，优先 `craft_context_open`、`craft_context_tools_discover`、`craft_info`，并返回 `total_candidates`/`omitted_count` | `tests/context-readiness-doctor.test.ts`、`tests/context-remediation.test.ts` |
| correction 状态契约明确 | `craft_context_correction_list.status` 加入合法枚举与说明；非法 `pending` 返回稳定 `INVALID_INPUT` 而不是 `INTERNAL_ERROR` | `tests/context-readiness-doctor.test.ts` |
| Skill 收尾对齐 | 工作区 `craft-context` Skill 改为共享 recall + 任务结束学习闭环；相关兼容 Skill 增加「勿重复召回 / 单域薄入口」说明 | 见 `.agents/skills/` 下本次改动 |

## P1：有证据的学习闭环（控制面已实现，不宣称业务晋级）

- 新增只读计划器 `craft_capability_iteration_plan`：验证脱敏任务账本 schema、统计独立 session、verifier outcome、baseline/candidate 配对、Knowledge/Memory/Experience 存量，并输出迁移 dry-run、最小充分 Context、Activation Profile 与 Quality/Canary 编排计划；不写任何 live 资产。
- 只读治理报告：22 个 Knowledge candidate、78 个 stale、`evaluation_cases=0`、Memory ledger 为空、Experience dispatch 为空只说明需要证据，不说明能力失败；计划器输出 `inconclusive`，不把统计值改写成 `reviewed` 或 `eligible`。
- 脱敏任务账本需要至少 20–30 个真实 Codex 任务、≥2 个独立 session，并固定 goal、changed paths、verifier digest、injected/used refs、用户更正、终态 outcome。
- 只有完成等预算 baseline/candidate 配对后，才可将 `model_effect_proven` 从 `false` 改为有证据状态；单测、MCP 握手和一次成功不可代替。
- 本轮不批准/退休/刷新 live claim，不采集真实会话，不置 `business_eligible` 或 `routeable`。

验收：`evaluation_cases > 0`、至少一个 fine scenario 有两次独立已验证 session、Knowledge task-effect 产生 `eligible/rejected`、Memory 有 ledger 与 verified helpful feedback；缺证据则保持 `inconclusive`。

## P2：最小充分 Context 与治理式晋级（控制面已实现，默认版本仍受证据门约束）

- 保持已有 `prefer_codebase`、typed `required_refs`、`usage_stage`、token measurement、`max_tokens`，不重复实现。
- 两阶段披露：第一阶段仅 bounded receipt + 精确 ref + 版本/digest + omission reason；第二阶段用 `symbol_read`、`claim_get`、procedure read 展开。
- 大输出走 `craft_context_output_capture`、`craft_context_ephemeral_search`、`craft_context_compute`、`craft_context_resume_resolve`。
- `craft_capability_iteration_plan` 输出最小 Activation Profile：最多 5 个候选资产，显式返回 `omitted_count`，要求 health/trust/effect/cost/compatibility 门禁；发现、激活、授权、执行继续分离。
- Workflow draft → 冻结 Subject/Case/环境/预算/Grader → 重复 Trial → Signoff → Canary → `routeable` + 回滚目标；`Automatic experience publication` 保持 `not automatic`。

验收：编码任务不再因可选记忆占满而缺少代码依据；required ref 缺失显式失败；feedback 不再全部 `unrated`；配对评测中成功率、token、延迟无回归；默认版本变化可回滚。

## 代码闭环与效果门的区分

本轮已经把「可以离线实现并验证」的 P0–P2 控制面全部落地：错误诊断、Doctor、工具分片、状态契约、Skill 收尾、脱敏账本 schema、迁移/治理 dry-run、最小充分 Context 计划、Activation Profile、Quality/Canary 编排计划、测试与增量覆盖。仍未完成且不能由代码声明完成的是「真实 Host 任务效果」：需要 20–30 个脱敏任务、≥2 个独立 session、等预算 baseline/candidate 配对、独立 Outcome 与人工 Signoff。计划器会把这些缺失如实输出为 `inconclusive`，不会把 `model_effect_proven`、`business_eligible` 或 `routeable` 置真。

## 缺口审计与缺失子能力判断

新增只读 `craft_capability_iteration_gaps`：把剩余问题分成 `resolved`、`runtime_pending`、`evidence_pending`、`authorization_pending`，并输出 `missing_subcapabilities`。当前判断是不缺第五个 Context 成员、向量库、reranker、自动发布器或自改 Agent；继续增加这些会扩大受治理边界且没有等预算效果证据。

剩余真实缺口只有：

- 运行态：Codex 插件缓存/宿主进程仍是旧包，需要安装新 marketplace 包并重启会话。
- 授权态：项目身份与业务数据迁移仍需离线备份、可审查 `record_refs` 清单和明确授权。
- 证据态：Context 注入/反馈、Hook 执行证明、脱敏任务账本、独立 session 与 baseline/candidate 配对。
- 发布态：Signoff、Canary、回滚目标和默认版本变更仍需真实效果证据与人工/宿主批准。

## 授权边界与后续动作

| 动作 | 当前状态 | 后续要求 |
| --- | --- | --- |
| `apply_registry_migration` / `apply_data_migration` | 未执行 | 离线备份、维护窗口、可审查 record_refs 清单、用户明确说「执行迁移」 |
| Codex 完整 `craft` 与 `craft-context` 二选一 | 未改全局配置 | 单独 C 授权批次；避免同时挂两套 Hook/MCP |
| live Knowledge/Memory/Experience 变更 | 未触碰 | 单独 D 授权批次；先有独立 session 与 baseline/candidate 证据 |
| GitHub Issues / Marketplace / ADR | 未创建 | `gh` 可用且用户授权后再做；本轮按 Q4 不改变自动发布边界，不新建 ADR |

## 验证顺序

1. `pnpm run typecheck`。
2. `node --experimental-strip-types --test --test-concurrency=1` 运行直接相关测试：`context-readiness-doctor`、`context-remediation`、`context-extensions`、`context-directory`、`mcp`、`component-plugins`、`component-standalone-readiness`、`context-distribution`。
3. `pnpm run lint`、`pnpm run audit:docs`、`pnpm run audit:surfaces`、`pnpm run audit:coverage-inventory --check`。
4. 改动相关 coverage group：`context-remediation`、`component-readiness`、`context-extensions`、`component-plugins`、`repository-context-products`；新增 `context-readiness-doctor` 组要求行/函数/分支 100%。
5. `pnpm run build:plugin`、`pnpm run pack:plugin`、`pnpm run test:smoke`、`pnpm run test:plugin`。
6. 不运行全量 `pnpm test` 与全量 232 组 coverage；仅当公共基础能力影响范围无法可靠判断时扩大。
