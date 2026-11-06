# MCP Tasks

Craft 提供 owner-scoped 的持久 MCP Task 投影：`create → get/update → completed|failed|cancelled`，并支持 TTL 过期。Task 创建记录会先落 SQLite，随后 Host 才能开始异步工作；请求体和结果体只以 digest 表示，不能通过 Task 接口枚举其他 owner 的任务。

`working`、`input_required`、`completed`、`failed`、`cancelled`、`expired` 是状态机；终态不可改写，重复提交使用 `request_id`/`task_id` 幂等。MCP Task 只解决生命周期，不替代 Craft 自己的 Policy、Receipt、Trace、Acceptance 或安全证明。
