# 场景 Graph 与版本恢复

当用户需要同一场景的不同任务路径、运行中分支或返工时读取本页。

业务上仍是 Workflow；执行定义为有向 Graph，允许有界回路。层级是「场景 → 子场景 → 入口/合法路径/目标出口 → Invocation」。互联网产研是场景，需求研发、Bug 修复、Bug 诊断、CR 是子场景。多个子场景可以共用入口，按目标出口和允许的路径区分。

## 配置与版本

1. 读取 [互联网产研配置](internet-product-engineering.json) 作为候选模板。确认目标、输入、验收、权限、预算以及需要保留的人类决策点；配置中的验收引用必须由本次 Host 提供实际证据。
2. 调用 `craft_procedure_configuration_save`，传 `procedure_id`、明确 `scope`、`title`、`procedure_kind: graph` 和 `definition`（模板 JSON）。更新必须传当前 `expected_version`。用户编写配置可以直接存成候选，不需要伪造执行观察。由执行经验归纳候选仍要求至少两个独立观察。
3. `graph_control` 定义场景、命名 entries/exits/subscenarios；nodes/edges 为共享图。子场景选择 entry_id/exit_id、allowed_nodes/allowed_edges、allowed_effects、max_transitions/max_visits。每条边还有 max_traversals；预算不能由恢复操作清零。
4. 内容变化产生新的 JSON 内容修订，撤销旧晋级结果。记录 version 包括状态变化，content_version/definition_digest 标识内容。完成四道既有门禁才能被召回/绑定，每道门禁证据必须覆盖所有声明的子场景及其入口、出口和精确内容摘要。
5. Graph 的子调用当前支持版本固定的 Workflow Procedure（含独立只读并行组），不递归嵌套 Graph，也不提供任意并行写入或第二套执行器。需要更深控制图时展平到场景图；共享有界步骤使用子 Workflow。

## 执行与返工

- `craft_procedure_plan` 和 `craft_procedure_invocation_bind` 选择精确 `subscenario_id`、entry_id/exit_id。执行继续使用已有 Verified Work Loop、Task Contract、DurableActionLoop、Host 与 AcceptanceGate。
- 每轮 `dispatch → Host 执行 → terminal observation + Evidence → report`。Graph 保留出口占位，普通节点完成不等于整体交付。
- 调用 `craft_procedure_invocation_transition` 选择一条当前节点、当前子场景允许的边。必需参数：invocation_id、scope、expected_version、transition_id、edge_id、receipt_id、snapshot_id、evidence_id。
- 转换 Evidence 必须 confirmed，source_type 为 program（human_resume 为 human）；metadata 精确绑定 scope、invocation_id、当前节点最近 receipt_id、`graph_state_digest`、snapshot_digest、workspace_state_revision、有效 expires_at、`matched_edge_ids: [所选边]` 和 `result: true`。条件/人工恢复边还绑定 predicate_ref。Host 必须完成判定后写证据，不得为推进流程编造 result。未知或多个匹配停止并澄清。
- retry 或 `rework: true` 回路还要求 `safe_to_retry: true` 的当前目标状态证明。回退会保留旧账本并将目标及依赖产物标为 superseded，下一轮重新产生、测试和审查；旧轮次成功回执不能验证新产物。
- 有在途动作时先核对并收齐回执；不重发已派发动作。普通 resume 不能替代 Graph 转换。预算耗尽停止；外部补偿明确交接给有授权的 Host，Craft 不自动撤销已发布或已发送动作。
- 选定业务出口后仍需本轮产物的独立出口验收。delivery 表示交付就绪，不表示部署。blocked/failed/cancelled/inconclusive 保持独立状态。
- `craft_procedure_invocation_get` 可读取实际路径、轮次、失效关系与转换证据。配置变更/撤销会阻止旧运行继续；检查变更并重建计划，不能静默将活动任务换到新配置。

## 历史与恢复

`craft_experience_asset_inspect` 的 action 为 history/read/diff/explain，始终传 asset_id、scope_kind、scope_id。read 用 version；diff 用 version、target_version，可用 target_asset_id 比较同范围另一个候选。history 用 before_version 翻页。explain 包含定义、门禁、近期运行和回执；召回与实际遵循、成功结果分开解释。

用户要求恢复时，先比较差异，再调用 `craft_experience_asset_restore`：version 为历史记录版，expected_version 为当前记录版，request_id 稳定，reason 明确。恢复生成新的候选，需要重新审核和晋级；不回写旧版本，不修改已发生的外部动作。
