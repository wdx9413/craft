# Verification Plane（v0.12.23）

## 目的

`VerificationPlane` 是 Craft 在开发阶段的验证控制模块。它回答的不是“某个函数是否通过单元测试”，而是：**对于这次变更，哪些独立证据缺一不可，当前是否已经具备继续进入下一治理门的依据。**

它是深模块，公开 Interface 只有四个动作：

```text
plan(change) → Verification Plan
record(plan, check, receipt) → Verification Receipt
assess(plan, qualification?) → eligible | rejected | inconclusive
get(plan) → content-free verification record
```

它不直接执行命令、不启动 Host、不读取原始 Prompt 或业务正文，也不替代现有的 Sandbox、Host、Eval Campaign 或 Release Qualification。实际执行继续经现有 Host / Runtime Seam；本模块只定义需要什么验证、接收什么回执并得出可审计结论。

## 风险到验证集

每个 Plan 固定 `change_ref`、变更类别、effect、环境摘要和可选 Candidate/真实 Host 标记。调用方可以要求更高风险等级，却不能把推导出的等级调低。

| 条件 | 最低检查 |
|---|---|
| 普通代码或读取型变更 | `contract`、`deterministic_e2e`、`state_machine` |
| Policy、Capability、Host、Plugin、本地写入或更高风险 | 追加 `adversarial`、`recovery` |
| Host 变更或声明必须在真实 Host 验证 | 追加 `host_conformance` |
| Harness / Skill / Workflow Candidate | 追加 `eval_campaign`、`release_qualification` |
| 外部写入或 destructive effect | 提升到 `critical`；不能以单测或模型自述替代验证 |

`contract` 验证 Interface、Schema 和不变量；`deterministic_e2e` 验证临时、隔离的真实纵切；`state_machine` 验证暂停、重试、恢复、漂移与幂等性；`adversarial` 验证伪造回执、越权、注入或范围逃逸；`recovery` 验证中断后不会把旧事实当新事实或重复副作用。

## Receipt 与判定

每项检查都必须是 Plan 中预先声明的检查，并绑定同一环境摘要。`passed` 必须引用 `confirmed` 或 `bounded` Evidence；未执行、被阻塞、环境不一致或 Evidence 不足均为 `inconclusive`，不会伪装成通过。任一已记录的失败为 `rejected`。

Candidate 的所有检查通过仍不足以成为 `eligible`：还必须引用同环境、同预算、重复配对后的 `ReleaseQualification`，且该资格结论为 `eligible`。这让“开发验证机制正确”和“候选带来净价值”保持为两种不同事实。

## MCP 与插件暴露

- 默认 Core 面只读暴露 `craft_verification_get`，便于工作控制台查看当前验证事实。
- 完整 MCP 提供 `craft_verification_plan`、`craft_verification_receipt_record`、`craft_verification_assess` 与 `craft_verification_get`。
- `craft-quality` 组件插件包含完整 Verification Plane，因而可单独为 Codex、Claude、IDE 或其他 Agent 提供开发验证能力；安装它不会启用 Verified Work Loop，也不会授予命令或写入权限。`craft-skill-quality` 保留为相同工具面的兼容名称。

## 证据边界

内置测试及脱敏 Fixture 只证明机制与协议。它们不证明某个模型、Host 或真实业务任务的质量提升。真实价值仍需由脱敏 Case、真实环境回执、重复 Trial、已校准 Grader 和必要时的人工金标组成。
