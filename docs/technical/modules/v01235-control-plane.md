# v0.12.35 控制面收口

## 目标

本版不新增第二套 Agent、Workflow 或 Graph 执行器。`VerifiedWorkLoop` 仍是唯一公共编排入口；新增模块只把运行事实、上下文选择、能力供应链和人机命令收拢到稳定 Seam。

## P0：运行事实、Context、Workbench

- `RuntimeExecutionAttemptKernel` 绑定 `task_id / work_loop_id / run_id / attempt_id / host_id / environment_digest / effect_class / idempotency_key`。
- `effect_unknown` 只能进入 `reconcile_required`，`recover` 返回 `replay_allowed: false`；Receipt 与 Observation 都校验归属。
- `ContextWorkingSetKernel` 复用 `ContextResolutionKernel`。固定成员为 `history / knowledge / memory / experience / state`；只有累积成员通过检索适配器，回执只保存引用、摘要和选择解释。
- `WorkbenchCommandKernel` 对人类命令做版本校验、幂等和脱敏回执；实际状态变化仍由 Craft Service/VerifiedWorkLoop 完成。

## P1：能力与 Graph

- `CapabilityIntakeKernel` 统一登记能力 Manifest、扫描、Conformance、审批、激活、撤销和升级计划。它不下载、启动或执行第三方内容。
- `GraphCompilerKernel` 只做静态校验、依赖/重试/补偿/人工门分析，输出 `executable_by: verified_work_loop` 的 Plan；不会直接调用 Host。

## P2 边界

主动触发、跨 Host 迁移和多 Agent 仍沿用现有受控模块，默认关闭或 opt-in。本版不承诺 OS 级隔离、GUI 全覆盖、自动发布 Experience、无限 Swarm 或外部 API 无损回滚。

## 验收

`tests/v01235-control-plane.test.ts` 覆盖成功、失败、幂等、漂移、未知副作用、权限和 MCP 入口；新增五个模块的增量行、函数、分支覆盖率均为 100%。真实 Codex/Claude 的业务价值仍需由 Reference Pilot 取得 `host_verified` 和 `business_eligible` 证据后才能宣称。

