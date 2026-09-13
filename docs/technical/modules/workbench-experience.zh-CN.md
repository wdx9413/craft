# Workbench Experience Projection（v0.12.9）

`WorkbenchExperienceKernel` 是只读体验层，不取代任何事实账本。它按项目、任务或 Session 聚合 Work Launch、Trace 时间线、Outcome、Artifact 和下一安全动作，并提供需要重新验证的 Replay Plan。

页面可以因此稳定显示“目标—资料—决策—工作—成果—证据—下一步”。Replay Plan 只返回动作摘要和引用摘要，绝不执行外部动作；执行仍需经过原有 Host、权限、预算与验收门禁。
