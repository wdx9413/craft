# Experience / Eval Kernel

## 已实现对象

- Harness Configuration：版本化的 context、tools、generation、orchestration、memory、output 六维配置。
- Trial：不可变，绑定 Task、Case、Subject 精确版本和可选 Harness 精确版本。
- Trace：按 Trial 单调追加事件。
- Outcome：每个 Trial 只能记录一次，保存 verdict、scores、costs、Evidence 和来源。
- Evaluation Run：聚合同一 Suite 分区、同一 Subject 版本的已完成 Trial。

## 关键门禁

Evaluation Suite 的 Case 显式属于 `search`、`development` 或 `held_out`。Workflow 从 `candidate` 晋级 `verified` 时，必须引用该 Workflow 精确版本且全部通过的 held-out Evaluation Run。

## 下一步

自动把 Workflow/Orchestration 执行转换为 Trial；加入多类 Grader、版本对比、置信区间和等预算基线；最后才建设 Case 经验与全局模式的双层检索和受控 Harness 搜索。

关联：[Workflow/Signoff](workflow-signoff.md) · [Agent IR](agent-ir.md) · [Capability Kit](capability-kit.md)
