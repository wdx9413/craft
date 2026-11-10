# v0.12.11 连续工作运行时

v0.12.11 把 Project Brain、Work Session、Trace、长任务和宿主适配之间缺失的连接收敛成一组可复核的运行时对象：

```text
Project Brain
  → Context Manifest
  → Work Session / Host
  → Trace / Evidence / Outcome
  → Replay / Resume / Handoff
  → Project Bundle / Feedback / Cost
```

新增对象包括：

- `Context Manifest`：固定知识、能力、Workflow、模型、Host、验收引用和排除项，并提供漂移审计。
- `Replay Runner`：只接受终态 Trace、工作区摘要和人工审批；Trace 变化时失败关闭。未挂载执行器时只产生 dry-run 收据，不冒充真实重放。
- `Local Runtime Service`：持久化服务状态和 bounded tick，可由托盘、cron 或系统服务调用。
- `Project Bundle`：导出项目级摘要引用和摘要校验，可用于备份、迁移和跨宿主交接。
- `Feedback Signal`：记录接受、拒绝、修订和作用域，候选经验仍需评测和人工发布。
- `Domain Evaluator`：登记用户定义的指标门槛；业务评分器和真实领域质量仍由外部适配器提供。
- `Handoff Manifest`：跨 Host 传递 Task、Context、权限、Artifact、Evidence 和 Outcome 的可验证引用。
- `Cost Ledger`：保存 Provider/Model 价格快照并按项目和任务归因实际 Token 成本。

兼容性：现有 Store 记录不覆盖，新增对象使用通用 `records` 表；旧 `craft.trace.v1` 继续可读。真实 OS 级隔离、系统调度器、通知、远程对象存储和领域质量模型仍然是部署 Adapter 的责任。
