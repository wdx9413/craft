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

当前版本实现程序门禁、Workflow 生命周期、`craft_workflow_trial_run` 自动取证，以及第一版多来源 Grader 与 Signoff Policy：

- Grader 定义可版本化，类型固定为 program、model、human 或 operational。
- Grade 创建后不可覆盖，绑定 Trial、Grader 精确版本、verdict、可选归一化 score 和 Evidence。
- Signoff 只读取调用方显式提供的 Grade ID；每项来源要求必须覆盖 Evaluation Run 中的每个 Trial。
- Policy 可要求 held-out 分区和基础 Outcome 全通过；Signoff 保存逐项 checks，失败也可审计。
- Workflow 可使用 passed Signoff 晋级，同时保留旧的 held-out Evaluation Run 兼容入口。咨询型 Policy 可以忽略 held-out 或 Outcome，但其 Signoff 不能用于 Workflow 晋级；晋级仍额外要求底层 Evaluation Run 是 held-out 且全部通过。

下一步是聚合指标、版本对比、人工复核任务和延迟 Operational Grade 的回填协议。

关联：[Experience/Eval](experience-eval.md) · [Agent IR](agent-ir.md) · [Runtime 接入](runtime-integration.md)
