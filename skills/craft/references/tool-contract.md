# Craft 工具说明

所有公开 MCP 工具统一使用 `craft_` 前缀。

## Skill 来源与检索

- `craft_info`：查看数据目录和各类记录数量。
- `craft_source_add`：注册用户选择的 Skill 目录，默认立即扫描。
- `craft_source_list`：查看请求路径、解析后的真实路径和刷新状态。
- `craft_source_update`：启用、停用或修改来源名称。
- `craft_source_remove`：删除来源及其索引，不删除原始文件。
- `craft_source_scan`：增量扫描单个来源；不传 ID 时扫描全部启用来源。
- `craft_capability_search`：刷新过期来源后，从本地索引返回少量候选。
- `craft_capability_get`：读取选中能力的完整内容和真实路径。

## 任务与反馈

- `craft_task_open`：传入 `task_id` 接续任务；或使用标题、目标创建任务。
- `craft_task_list`：按状态或项目筛选最近任务。
- `craft_task_checkpoint`：保存进度、待办、决策和 Artifact 引用。
- `craft_feedback_record`：记录用户明确给出的纠正、偏好、事实、例外或流程规则，并保留适用范围。

## Workflow

- `craft_workflow_save`：保存带版本的 Workflow，支持输入、步骤、声明式不变量、Evidence 要求和权限策略。
- `craft_workflow_search`：搜索最新且未废弃的 Workflow。
- `craft_workflow_get`：读取最新版本或指定版本。
- `craft_workflow_plan`：解析输入并预览步骤，不执行命令。
- `craft_workflow_run`：在明确授权范围内执行一次确定性流程，返回 `passed`、`needs_repair`、`failed` 或 `no_progress`。
- `craft_workflow_run_get`：读取 Run 及其全部不可变 Attempt 回执。
- `craft_workflow_start`：启动程序、模型、人工混合流程，推进到外部任务或权限边界。
- `craft_workflow_continue`：提供明确的副作用授权后继续。
- `craft_workflow_submit`：回填当前 Agent、Judge 或 Human 节点的结构化结果。
- `craft_workflow_session_get`：读取当前状态、待执行节点、上下文和带来源的事件历史。
- `craft_workflow_checkpoint_list`：列出程序验证或人工批准形成的可信恢复点。
- `craft_workflow_restore`：从可信 checkpoint 派生新 Session，不覆盖原历史。
- `craft_workflow_execution_reclaim`：把已过期但没有提交回执的执行标记为 `result_unknown`。
- `craft_workflow_execution_reconcile`：根据外部证据确认未知执行成功/失败，或明确批准重试；有副作用的重试需要 `approved_retry=true`。

`agent_reported`、`model_judged`、`program_verified`、`human_approved` 等标签描述证据来源，不代表相同的可信等级。不得把模型自述当成程序证明。

## 评测

- `craft_eval_suite_save`：保存有版本的 Case Suite；Case ID 在版本间应保持稳定。
- `craft_eval_suite_get`：读取最新或指定版本的 Suite。
- `craft_eval_suite_list`：按关键词或 scope 查找可复用 Suite 的最新版本。
- `craft_eval_run_start`：为 Capability、Skill、Workflow、工具、MCP、插件、Agent、模型、系统或组合创建一次评测运行。
- `craft_eval_result_submit`：提交一个不可变 Case 结果，包括 verdict、score、metrics、evidence 和 provenance。
- `craft_eval_run_get`：读取运行进度、逐 Case 结果与确定性聚合指标。
- `craft_eval_run_list`：按 Suite、被测对象或状态查找历史 Eval Run。
- `craft_eval_compare`：比较使用同一 Suite 版本的多个运行，第一个 Run 是基线。

Craft 当前保存和聚合评测事实，不自动调用被测 Agent 或 Grader。执行者必须如实标记结果来源；`blocked` 和 `skipped` 默认不生成分数。

## 多 Agent 编排

- `craft_agent_profile_save`：保存有版本的角色、宿主、供应商、模型、推理强度、能力和权限上限。
- `craft_agent_profile_get`：读取最新或指定 Profile 版本。
- `craft_agent_profile_list`：按角色、宿主或启用状态查找 Profile。
- `craft_orchestration_plan_create`：保存依赖 DAG、每个节点的顺序路由候选和并发上限。
- `craft_orchestration_plan_get`：读取节点、Lease、路由、结果和当前状态。
- `craft_orchestration_plan_list`：按关联 Task 或状态找回 Plan。
- `craft_orchestration_dispatch`：领取当前就绪节点并返回宿主应执行的结构化请求。
- `craft_orchestration_submit`：提交 Lease 结果；失败且仍有候选时自动进入下一路由。
- `craft_orchestration_heartbeat`：由 Lease 所有者续租长时间执行。
- `craft_orchestration_reclaim`：回收超时 Lease；重新派发时保留当前 Profile 路由。
- `craft_orchestration_plan_control`：暂停、恢复或取消 Plan。
- `craft_orchestration_node_retry`：人工重试失败/阻塞节点，可选择从首个 Profile 重新路由。

`dispatch` 只修改 Craft 本地状态，不会直接启动 Codex 或 Claude 子 Agent。宿主必须执行 Lease Request 中明确指定的 Profile，并继续遵守自己的 Sandbox 和审批规则。

## 宿主与存储维护

- `craft_host_adapter_probe`：查看 Codex、Claude Code、DeepSeek Harness 或通用 MCP 的声明能力，以及对应可执行程序是否在本机存在。
- `craft_store_backup`：使用 SQLite backup API 创建一致性备份。
- `craft_store_doctor`：检查数据库完整性、外键、Workflow 执行引用和 FTS 漂移。
- `craft_store_restore`：从已通过 SQLite 检查的备份恢复；必须显式 `confirm=true`，并返回恢复前备份的位置。
