# Evaluation runtime

Craft 的最小评测闭环由三个对象组成：

- `Case Suite`：有版本、不可变的代表性用例集合。
- `Eval Run`：某个 Suite 版本针对一个被测对象的一次运行。
- `Case Result`：不可变的单条结果，记录 verdict、score、metrics、evidence 与 provenance。

被测对象 `subject_kind` 可以是 `capability`、`skill`、`workflow`、`tool`、`mcp`、`plugin`、`agent`、`model`、`system` 或 `combination`。Craft 不假设具体模型供应商，也不会在当前版本中自动执行 Case；Codex、Claude、确定性程序或人工均可执行，然后回填真实结果。

## Case Suite

每个 Case 至少包含稳定的 `id` 和 `name`，可选字段包括 `input`、`expected`、`graders`、`tags` 和正数 `weight`。修改 Suite 会产生新版本，不覆盖旧版本。使用 `craft_eval_suite_list` 找回可复用套件。比较时必须使用完全相同的 Suite 版本，避免因题目变化产生虚假提升。

```json
{
  "name": "Coding regression",
  "cases": [
    {
      "id": "incremental-coverage",
      "name": "Changed executable lines and branches reach 100% coverage",
      "input": {"repository": "demo"},
      "graders": [{"type": "program", "metric": "diff_coverage"}],
      "tags": ["quality"],
      "weight": 2
    }
  ]
}
```

## Result semantics

- `passed` / `failed` 默认分别映射到 `1.0` / `0.0`，也可提交区间 `[0, 1]` 内的连续分数。
- `blocked` / `skipped` 默认没有分数，不应把未执行误算为失败或成功。
- `provenance` 必须是 `agent_reported`、`model_judged`、`program_verified`、`human_approved` 或 `human_rejected` 之一。
- 已提交结果不可覆盖；若执行条件或判断方式发生变化，应创建新的 Eval Run。

聚合结果包含完成率、通过率、各 verdict 数量和按 Case weight 计算的加权得分。通过率只计算 `passed` 与 `failed`；加权得分只计算有 score 的 Case。

使用 `craft_eval_run_list` 按 Suite、被测对象或状态找回历史运行。`craft_eval_compare` 把第一个 Run 作为基线，输出其余 Run 的通过率和加权得分差值。所有 Run 必须引用同一个 Suite 版本。差值是观测结果，不代表统计显著性；需要稳定性结论时，应使用重复运行和足够代表性的 Case。
