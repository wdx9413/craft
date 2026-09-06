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

`agent_reported`、`model_judged`、`program_verified`、`human_approved` 等标签描述证据来源，不代表相同的可信等级。不得把模型自述当成程序证明。
