# 自进化 Mod（cognitive overlay）

## 目的

Mod 是一段结构化的认知约束（Markdown/YAML 规则），只改变 Worker/Reviewer 的**提示与行为边界**，不改变 Craft 的代码执行逻辑。它是"智力药水/工作手册"层，与"电动螺丝刀"层的 Plugin 正交。诚实边界：Mod 能约束 agent 如何思考与判断，不能单凭一段文本获得修改运行时代码的能力。

## 生命周期

`draft → pending → (shadow test) → active → revoked`，另有 git 风格 `rollback`（回滚写成新版本，留 `rolled_back_from/to`）。

- 人工 Mod：`craft_mod_create` 建草稿，`craft_mod_approve` 由具名操作者审批后生效。
- 自进化 Mod：`craft_mod_propose_from_attribution` 把一条**已归因**失败（`failure_class` + `remedy`）蒸馏为 pending 候选；`unattributed` 失败被拒绝，绝不猜测原因。
- 只有 `evaluateShadowTest`（MCP：`craft_mod_shadow_test_run`）能授予 pass。它运行确定性的、零模型调用的回归集：pending 期间不生效、正文非空、插件绑定不泄漏、影子运行不污染真实上下文、三条固定不变量（不忽略安全、不绕过审批、不外泄密钥）、候选正文确实可观测。
- `craft_mod_shadow_test_record` 只能记录失败或外部 verdict，**永远不能授予 pass**。

## 门禁不变量

1. 自进化 Mod 未通过影子回归不得 approve。
2. 影子 pass 绑定候选正文的 body digest；通过后改写正文会让 pass 失效，必须重跑。
3. `active` 的 Mod 不可原地编辑；只能 revoke 后重建。
4. 插件绑定的 Mod 只在插件启用时注入 overlay。

## 与 Continual Harness 的关系

`ContinualHarnessKernel.refine` 支持 `changes[].kind = "mod"` 轴：

- `create`：从 `failure_class`/`remedy` 提出自进化 Mod 候选；
- `update`：编辑现有非 active Mod 正文；
- `delete`：被拒绝（撤销走 `craft_mod_revoke`）。

带 Mod 轴的 refinement 永远是 `governed`（不是 session-local）。`submit` 复用与 `ModRegistry.approve` 相同的门禁：每个关联 Mod 必须有绑定当前正文 digest 的影子 pass，否则拒绝进入 `evaluation_required`。这保证"从失败归因到行为规则"的自进化闭环无法绕过那道唯一有效的影子门。

## MCP 工具面

`craft_mod_create/update/list/approve/enable/disable/revoke/rollback/rollback_previous/propose_from_attribution/shadow_test_run/shadow_test_record`。全部经 `action-handlers` 绑定到 `CraftService` 的同名方法；`tool-catalog.ts` 是声明的唯一来源。
