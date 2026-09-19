# Evaluation Model Profile 与 Workflow Evolution（v0.12.24）

本模块补的是“模型如何受控参与评测”与“真实执行记录如何变成待验证 Workflow”，不是第二套模型网关、评测 Gate 或 Workflow 引擎。

```text
脱敏执行记录 / Trial / Outcome
  → Workflow Evolution Observation（只保存来源摘要、结果、Evidence）
  → 至少两条独立来源 + 最多两个设计轴
  → Workflow Evolution Request
  → Evaluation Model Ticket（可选）
  → Host / 模型产出 Draft Workflow
  → Shadow / held-out Eval → Signoff → Canary
  → verified Workflow → Capability Discovery / Activation Profile
```

## Evaluation Model Profile

`EvaluationModelProfile` 固定 provider、精确 model、温度、输出预算、尝试上限、用途和**环境变量名**；它不保存 API Key。默认 `network_execution_enabled=false`。即使显式启用，也必须在运行时检测到环境变量，才会将 Ticket 标成 `ready_for_adapter`。

Ticket 本身只有输入引用、输出契约引用、Profile 精确版本和目标（Campaign slot 或 Workflow Evolution Request）。它不含 Prompt、客户对话或密钥，也不会自动发网络请求。后续配置真实模型时，只需由兼容 Host/Adapter 消费这个精确 Ticket，并将真实 Task Run/Receipt 绑定回既有 Campaign。

## Workflow Evolution

`craft-experience` 保留为兼容草案辅助器，并不构成独立发布闭环。输入必须是 `sanitized=true` 且 `content_stored=false` 的观察，每条都引用 `confirmed` 或 `bounded` Evidence。业务场景可把“会话/执行记录”的外部 ID 与 digest 作为 Source Reference 传入；原始文本仍留在业务系统。

请求至少要有两条独立 Source；Candidate 最多改变 `context/tools/generation/orchestration/memory/output` 中两个设计轴。模型或 Host 只能提交新的 `draft` Workflow，可引用旧模板作为 `replaces_workflow`，但不会覆盖旧的 `verified` 版本。

## 何时真正可用

`draft` 不是能力，也不能被默认路由。只有通过 `craft-quality` 进行同环境、同预算、重复对照的 shadow/held-out Eval 证明收益，并通过精确 Signoff 与 Canary 后，Workflow 才能成为 `verified`。Capability Discovery 只在这一时刻将该精确版本作为可激活候选；发现、激活、授权、调用继续是四个不同状态。
