# ADR-0024：能力供应链与执行权分离

状态：Accepted（v0.12.35）

Skill、MCP、Workflow、Adapter 和 Evaluator 统一经历 discovered → scanned → conformance_passed → approved → active，并可 degraded/revoked/retired。来源、摘要、发布者、依赖、effect、权限和 Host 兼容性必须可追溯。可发现、可安装和扫描通过都不直接等于可信或可路由。

