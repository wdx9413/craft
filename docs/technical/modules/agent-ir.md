# Agent IR

## 目标

Agent IR 是与模型和宿主无关的任务中间表示，避免从自然语言需求直接跳到宿主专用工具调用。

最小对象计划包含 Goal、Constraint、Input、Artifact、Operation、Dependency、Route、Validator、Policy 和 Budget。高层 IR 保存用户意图和成功条件，低层 IR 逐步补充 Capability、模型、Host 与具体执行参数。

## 渐进式编译

```text
Intent IR → Domain IR → Execution IR → Host Plan
```

每次 Lowering 保存输入版本、输出版本、所用规则和诊断信息。Validator 可以在每一级拒绝不完整或违反约束的 IR。

## 依赖

IR 从 Capability Kit 获得可用操作，通过 Workflow/Orchestration 执行，并把实际执行登记到 Trial/Trace。当前版本尚未实现 IR Compiler，本页定义后续边界。

关联：[Capability Kit](capability-kit.md) · [Workflow/Signoff](workflow-signoff.md) · [Runtime 接入](runtime-integration.md)
