# Workbench Home（工作台首页投影）

v0.10.9 提供面向人类工作入口的只读组合视图：活动任务、工作空间、统一 Attention Inbox、运行、预算、最近成果和本地维护健康。CLI 使用 `craft home`，MCP 使用 `craft_home_view`，未来本地 Web/桌面端复用同一接口。

Home 只选择 UI 需要的字段，不返回任意记录 Payload，也不读取凭据。它不是新的事实源：任务状态仍归 Task，预算归 Budget Account，审批归 Autonomy Request，待处理卡片归 Attention 投影。当前版本没有团队视图、分页游标、领域组件 Schema 和实时推送。
