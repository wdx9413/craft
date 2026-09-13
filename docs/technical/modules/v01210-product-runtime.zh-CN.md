# v0.12.10 产品运行时垂直切片

v0.12.10 把 Project Brain、Work Session、Runtime Truth、Workbench 投影和持久等待收敛成一条可以被 CLI、MCP 和宿主适配器共同调用的产品路径：

```text
目标 → 项目 Brain → Session（知识/能力/Workflow/模型/Host 引用）
     → bounded Internal Host / 外部 Host Dispatch
     → Trace / Evidence / Artifact → Acceptance → Outcome → Experience candidate
```

本版新增或收口的入口：

- `craft run --project <id>` 创建或恢复项目任务，并在启动前固定 Session 与 dispatch 绑定；
- Internal Host 默认只向模型暴露五个低 Token、无任意命令能力的 syscall：能力检索、知识检索、checkpoint、evidence、artifact；
- Workbench 提供 `/api/project-brain`、`/api/workbench-experience`、`/api/traces` 和 `/api/long-task-checkpoints` 只读投影；
- MCP Registry 可从 HTTPS 源拉取有限条目并按摘要/版本写入本地登记；它不会自动安装、启用或认证远程 Server；
- A2A Transport 支持任务查询和取消的摘要化 HTTPS 适配，默认不授予远程执行权；
- 长任务 Worker 的 bounded tick 处理过期等待和 wake 请求，恢复前仍必须重新验证 Session，并以 fresh Host 继续；
- Work Session 可绑定 Dispatch，记录 session version 与 context digest，防止把旧上下文静默交给 Host。

兼容性：旧 `craft.trace.v1` 仍可读取；现有 Store 记录不覆盖迁移，新增字段采用可选值。Skill、插件、WorkBuddy Expert/Connector 和 DeepSeek Harness 的版本统一为 v0.12.10，默认接入仍是 route-first 与低 Token syscall 面。

边界必须保持诚实：本版没有把本地协议包装成 OS 级沙箱、官方 Registry 审核服务、远程 A2A 身份系统、组织云同步、系统级调度器或原生签名桌面安装器。上述能力通过 Adapter 接口接入并在部署环境中提供证据后才可标记为生产可用。

