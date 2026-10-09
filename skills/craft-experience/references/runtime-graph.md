# 场景 Graph 与版本恢复

当用户需要同一场景的不同任务路径、运行中分支或返工时读取本页。

场景资产统一叫 Experience Graph，Workflow 是其中的受限流程形式；执行图允许有界回路。层级是「场景 → 子场景 → 入口/合法路径/目标出口 → Invocation」。互联网产研是场景，需求研发、Bug 修复、Bug 诊断、CR 是子场景。多个子场景可以共用入口，按目标出口和允许的路径区分。

## 配置与版本

新场景使用见名知义的小写英文 graph_id，例如 `product-development`、`code-review`、`bug-diagnosis`，目录直接采用此名字，不追加摘要。graph_id 是稳定身份；修改显示标题不改目录。旧摘要目录继续可读，不安全或旧非英文 ID 保留兼容路径。

1. 用 `craft_experience_graph_inspect(action: list, scope, scenario_id)` 发现已有场景资产及工作稿，`action: read` 读取定义和记录版本。新建时用 `action: template, template_id: internet-product-engineering` 获取 Runtime 只读模板及配置 Schema。Skill 不保存用户场景 JSON。
2. 确认目标、输入、验收、权限、预算和人类决策点。用 `craft_experience_graph_edit(action: save, graph_id, scope, configuration)` 创建工作稿，也可传 `template_id`。已有资产须带当前 `expected_version`，已有工作稿须带 `expected_draft_digest`。`draft.json` 位于选定数据根的 `experience/graph/<graph-id>/`，可在本地编辑，尚无执行权。同目录维护 `graph.yml`，仅含 `current_version` 和 `test_version`，返回 `manifest_path` 及状态。这两个字段是 JSON 内容版本，未提交的工作稿没有版本。文件按运行时账本重建，不能手改启用候选；已有手工 README 保留。
3. 修改后用 `craft_experience_graph_inspect(action: draft, graph_id, scope)` 取得当前工作稿及摘要。`action: validate` 校验 `configuration` 或 `json` 字符串；`action: diff, graph_id, scope` 预览工作稿变化、受影响子场景和待重验门禁。用 `craft_experience_graph_edit(action: submit, graph_id, scope, expected_draft_digest)` 提交精确工作稿为新候选。旧摘要或并发资产更新会拒绝，重读后比较再提交。用户编写配置不需要伪造观察；由经验归纳候选仍要求至少两个独立观察。
4. 不需要文件编辑时，既有 `craft_procedure_configuration_save` 继续接受 `procedure_id`、明确 `scope`、`title`、`procedure_kind` 和 `definition`，更新带 `expected_version`。两条路径共用同一候选及晋级合同。内容版本统一保存于 `experience/graph/<graph-id>/versions/`；旧 `procedures/workflows/` 和 `procedures/graphs/` 引用仍可读。用 `craft_experience_graph_edit(action: migrate, graph_id, scope, expected_version)` 分页复制已检查的历史版本，保留旧文件、摘要和运行引用。有 `has_more` 时带 `next_before_version` 继续；活动运行不换版本。
5. `graph_control` 定义场景及命名 entries/exits/subscenarios，nodes/edges 是执行结构。子场景选择 entry_id/exit_id、allowed_nodes/allowed_edges、allowed_effects、max_transitions/max_visits。每条执行边有 max_traversals，恢复不能清零预算。可选 `relations` 记录 `depends_on/supports/contradicts`，每项带 id、from/to（当前定义的节点 ID）及 evidence_ids；它们是经验关系，不派发动作或改变执行边。
6. 内容变化产生独立的新 JSON 候选，旧正式版保持运行；新候选需重新晋级。记录 version 包括状态变化，content_version/definition_digest 标识内容。完成四道门禁后才能召回/绑定，每道证据覆盖所有声明子场景及入口、出口和精确摘要。当前保守重验全部门禁，差异预览不授予增量验收许可。首次候选的 current_version 为 null；已有正式版时 current_version 保留旧内容版本，test_version 指向新候选。候选失败不替换正式版；晋级后 current_version 指向新内容版本，test_version 为 null。运行绑定仍使用接口返回的记录版本，不能把 YAML 内容版本直接当作 Invocation 的 procedure_version。manifest_status 为 unavailable 时如实报告视图不可用，重读可修复。
7. Graph 子调用支持固定版本的 Workflow Procedure（含独立只读并行组），不递归嵌套 Graph，也不提供任意并行写入或第二套执行器。更深控制图可展平，共享有界步骤使用子 Workflow。

## 执行与返工

- `craft_procedure_plan` 和 `craft_procedure_invocation_bind` 选择精确 `subscenario_id`、entry_id/exit_id。执行继续使用已有 Verified Work Loop、Task Contract、DurableActionLoop、Host 与 AcceptanceGate。
- 每轮 `dispatch → Host 执行 → terminal observation + Evidence → report`。Graph 保留出口占位，普通节点完成不等于整体交付。
- 调用 `craft_procedure_invocation_transition` 选择一条当前节点、当前子场景允许的边。必需参数：invocation_id、scope、expected_version、transition_id、edge_id、receipt_id、snapshot_id、evidence_id。
- 转换 Evidence 必须 confirmed，source_type 为 program（human_resume 为 human）；metadata 精确绑定 scope、invocation_id、当前节点最近 receipt_id、`graph_state_digest`、snapshot_digest、workspace_state_revision、有效 expires_at、`matched_edge_ids: [所选边]` 和 `result: true`。条件/人工恢复边还绑定 predicate_ref。Host 必须完成判定后写证据，不得为推进流程编造 result。未知或多个匹配停止并澄清。
- retry 或 `rework: true` 回路还要求 `safe_to_retry: true` 的当前目标状态证明。回退会保留旧账本并将目标及依赖产物标为 superseded，下一轮重新产生、测试和审查；旧轮次成功回执不能验证新产物。
- 有在途动作时先核对并收齐回执；不重发已派发动作。普通 resume 不能替代 Graph 转换。预算耗尽停止；外部补偿明确交接给有授权的 Host，Craft 不自动撤销已发布或已发送动作。
- 选定业务出口后仍需本轮产物的独立出口验收。delivery 表示交付就绪，不表示部署。blocked/failed/cancelled/inconclusive 保持独立状态。
- `craft_procedure_invocation_get` 可读取实际路径、轮次、失效关系与转换证据。新候选不会使旧正式运行失效；正式版晋级、撤销或固定内容漂移后须检查并重建计划，不能静默将活动任务换到新配置。

## 历史与恢复

`craft_experience_asset_inspect` 的 action 为 history/read/diff/explain，始终传 asset_id、scope_kind、scope_id。read 用 version；diff 用 version、target_version，可用 target_asset_id 比较同范围另一个候选。history 用 before_version 翻页。explain 包含定义、门禁、近期运行和回执；召回与实际遵循、成功结果分开解释。

用户要求恢复时，先比较差异，再调用 `craft_experience_asset_restore`：version 为历史记录版，expected_version 为当前记录版，request_id 稳定，reason 明确。恢复生成新的候选，需要重新审核和晋级；不回写旧版本，不修改已发生的外部动作。

## 选择与隔离测试

用 `craft_experience_graph_inspect(action: match, graph_id, scope, query, input_keys)` 获取有名字的入口、子场景、出口及缺失输入。这是建议，实际规划仍检查前置证据、路径和预算。`action: diff` 返回受影响子场景及须重验门禁。

`craft_procedure_plan` / `craft_procedure_invocation_bind` 默认选择正式版；`release_channel: test` 固定测试候选的记录版本。只读测试直接沿用现有 Work Loop；写入测试必须传 `test_workspace_id` 和 `baseline_workspace_id`，两个工作区要已建立检查点、真实目录相互分离，测试工作区须与测试 Work Loop 一致。测试结果仍经终态观察和验收，不自动晋级。

需要单独撤销当前正式版时，使用 `craft_procedure_gate(release_channel: current, stage: canary, passed: false, expected_version, evidence_ids)`，其中 expected_version 为正式版记录版本。这保留不同内容的新候选；日常 Context 不召回候选。
