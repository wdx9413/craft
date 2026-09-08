# Agent IR

## 目标

Agent IR 是与模型和宿主无关的任务中间表示，避免从自然语言需求直接跳到宿主专用工具调用。

最小对象计划包含 Goal、Constraint、Input、Artifact、Operation、Dependency、Route、Validator、Policy 和 Budget。高层 IR 保存用户意图和成功条件，低层 IR 逐步补充 Capability、模型、Host 与具体执行参数。

## 0.9.6 编译与 Lowering

```text
Intent IR → Domain IR → Execution IR → Host Plan
```

`craft_harness_select` 先按风险、预算和外部副作用选择最小 Harness：低风险为单 Agent，普通任务为增量路线，高风险或外部任务为 Planner / Executor / Evaluator。`craft_agent_ir_compile` 将目标、Harness 精确版本和 Operation DAG 固化为版本化 IR；`craft_agent_ir_lower` 再将它 Lower 到绑定 Runtime Policy 与环境摘要的 Operation Run。依赖在 Lowering 后仍保持为可检查的 DAG。

这不是通用模型规划器：Craft 只保存可审计的中间表示，具体 Agent/Grader 仍由兼容 Host 执行。每次编译保存输入版本、输出版本和诊断信息；Validator 可以在每一级拒绝不完整或违反约束的 IR。

## 依赖

IR 从 Capability Kit 获得可用操作，通过 Runtime/Workflow/Orchestration 执行，并把实际执行登记到 Trial/Trace。Kit Registry、跨 Host Capability Card 与自动模型规划仍是后续边界。

关联：[Capability Kit](capability-kit.md) · [Workflow/Signoff](workflow-signoff.md) · [Runtime 接入](runtime-integration.md)
