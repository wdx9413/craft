# Experience / Eval Kernel

## 已实现对象

- Harness Configuration：版本化的 context、tools、generation、orchestration、memory、output 六维配置。
- Trial：不可变，绑定 Task、Case、Subject 精确版本和可选 Harness 精确版本。
- Trace：按 Trial 单调追加事件。
- Outcome：每个 Trial 只能记录一次，保存 verdict、scores、costs、Evidence 和来源。
- Evaluation Run：聚合同一 Suite 分区、同一 Subject 版本的已完成 Trial。
- Evaluation Aggregate：从 Outcome 复算通过率、verdict、数值 score、cost、duration 和 failure type 分布，不依赖模型总结。
- Evaluation Comparison：只比较同一 Suite 精确版本、同一分区、同一 Subject 类型和相同 Case 集合，并保存两侧聚合快照与 delta。
- Workflow Trial Run：一次调用锁定 Workflow 精确版本，并自动登记 Trial、起止 Trace、执行回执 Artifact、程序 Evidence 和唯一 Outcome。确定性检查不通过与运行时崩溃都会形成可追踪的失败结果，崩溃详情默认脱敏。
- Grader / Grade / Signoff：区分程序、模型、人工和业务来源，以显式 Grade 集合和版本化 Policy 生成可复算的晋级决定。

## 关键门禁

Evaluation Suite 的 Case 显式属于 `search`、`development` 或 `held_out`。Workflow 从 `candidate` 晋级 `verified` 时，必须引用该 Workflow 精确版本且全部通过的 held-out Evaluation Run。

Workflow、Agent Profile 和 Harness Configuration 都可以作为被测 Subject，但不同 Subject 类型不能直接比较。质量和 score 越高越好，cost 与 duration 越低越好；指标方向冲突时结果为 `mixed`，而不是强行给出赢家。第一版输出是确定性描述统计，不提供置信区间或显著性结论。

## 下一步

继续把 Orchestration 执行转换为 Trial；加入置信区间、重复采样、等预算基线和 Operational Grade 回填；最后才建设 Case 经验与全局模式的双层检索和受控 Harness 搜索。

关联：[Workflow/Signoff](workflow-signoff.md) · [Agent IR](agent-ir.md) · [Capability Kit](capability-kit.md)
