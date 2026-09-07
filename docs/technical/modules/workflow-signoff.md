# Workflow / Verification / Signoff

## 职责

Workflow 描述可复用执行路径；Verification 判断是否符合明确规则；Validation 判断是否在目标环境满足用户目的；Signoff 决定某个精确版本能否进入可复用状态。

## 生命周期

```text
draft → candidate → verified → deprecated
```

新保存的 Workflow 始终回到 `draft`。`candidate → verified` 必须通过 held-out Evaluation Run。Rollback 只能恢复曾经 `verified` 的版本，并生成新的最新版本保存回滚来源和理由。

## 验证来源

- Program：退出码、文件、JSON、覆盖率和其他确定性检查。
- Model：带 Rubric 的判断，不能伪装成程序证明。
- Human：明确审批或领域专家评分。
- Operational：发布后业务指标或延迟结果。

当前版本实现程序门禁、Workflow 生命周期，以及 `craft_workflow_trial_run` 的自动取证闭环；完整多来源 Grader 与 Signoff Policy 正在建设。

关联：[Experience/Eval](experience-eval.md) · [Agent IR](agent-ir.md) · [Runtime 接入](runtime-integration.md)
