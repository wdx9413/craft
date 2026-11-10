# v0.12.12 Verified Autonomous Work

v0.12.12 将已有 Kernel 收敛为一条可验证的自主工作主路径：

```text
Context Manifest
  → Verified Work Prepare
  → Action Authorization
  → Tool/Host Receipt
  → State Re-observation
  → Independent Acceptance
  → Delivery Gate
  → Outcome / Handoff / Resume
```

新增的 `VerifiedAutonomousWorkKernel` 不替代 Codex、Claude 或其他 Host，而是把它们的动作统一成可授权、可幂等、可重新观察的事实。写入动作必须绑定批准和已验证平台边界；漂移会进入 `needs_replan`，不会继续使用旧计划。

`SandboxConformanceKernel` 只接受带验证者、隔离状态、网络状态和能力声明的 Conformance 记录。它不能伪造操作系统沙箱；真实 Windows/macOS/Linux 后端仍需部署 Adapter 提交真实探针回执。

`TraceExplorerKernel` 只返回事件元数据和摘要，不返回 Prompt、业务正文或敏感工具输出，供 Workbench 进行任务、Host、状态和失败步骤筛选。

该版本仍坚持：模型自述、进程退出码和 Host completed 都不能单独形成 Outcome；必须有独立 Acceptance、Artifact 和 Evidence。
