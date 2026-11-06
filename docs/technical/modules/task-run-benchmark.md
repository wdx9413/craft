# Task Run、平台 Conformance 与 Benchmark

> 状态：v0.11.55 已实现机制；v0.11.56 在其上增加 Host-bound Campaign Slot；内置样例只证明控制链路，不代表业务质量已提升。

## 三个模块

```text
Task Control Contract + Work Launch
        ↓
Task Run Manifest → Host receipt → Delivery / Acceptance
        ↓
Task Benchmark Pair → held-out aggregate → draft candidate → Signoff → Canary
```

### Task Run

`TaskRunKernel` 是一条已准备 Work Launch 的持久运行记录，不是新的 Agent 规划器。

- 固定 Contract、Launch 的稳定身份、Dispatch 请求摘要、能力/预算引用、验收计划，以及环境/预算摘要；不保存 Prompt、凭据或业务正文。Host 运行态更新不会伪造 Dispatch 配置漂移。
- `refresh` 只基于当前 Host Receipt 和 Delivery Loop 给出有限状态：运行、审批、验收、交付、恢复、交接、暂停、取消或 `needs_replan`。
- 环境、预算、工作目录、Task 或 Prompt 摘要漂移时停止在 `needs_replan`；不会自动重试或扩大权限。
- 取消只会取消当前进程拥有的活动 Host；不可接管的旧进程仍须走原有确认停止后的恢复协议。

完整 MCP 可以 prepare/pause/resume/cancel/handoff；默认核心面只能 refresh/get。读任务仍由既有 Host 自动启动；写任务继续要求既有一次性人工授权。

### Platform Conformance

`platform_execution_conformance` 记录来自独立 verifier 的五项边界证据：禁网、工作区包含、无凭据、取消清理和资源上限。绑定了该记录的 Profile 会在 preflight 和执行前再次复核精确版本。

它不执行 Probe，也不把普通健康探测或旧 Profile 自动升级为 Conformance。未绑定 Conformance 的兼容 Profile 保持既有行为，但不得被文档描述为已完成的系统级安全证明。

### Task Benchmark 与候选

Benchmark 只配对已经产生 `WorkDelivery` 的两个 Task Run，不会为了评测悄悄启动模型或 Host。它要求相同环境与预算摘要；缺少一侧交付则等待，发生漂移则 `inconclusive`。

多个可比的 held-out Pair 可以复用既有 Delivery Evaluation 聚合。只有 `eligible_for_signoff` 的聚合才能产生仅保存摘要 digest、且最多两个 Harness 设计轴的 draft candidate；candidate 仍必须引用既有 passed Signoff 才能进入 Canary。Canary 固定评测时的环境与预算摘要，只接受脱敏聚合质量；一旦低于基线减阈值，返回精确 `rollback_to` 基线引用。v0.11.55 要求可用于路由的 Sample 带 Evidence，且由 reviewer 明确确认后才成为 `routing_eligible`；选择器无匹配时固定回到调用方给出的最小 Harness。v0.11.56 的 `CampaignRunner` 再固定每次 Host 交接的 Case、Harness、Trial、环境和预算，仍不直接发布、改 Prompt、写 Skill 或执行生成脚本。

## 非目标

- 不默认多 Agent，不把 Expert/Sub-agent 当作收益保证。
- 不运行模型生成的任意代码，也不将外部 API/数据库写入承诺为可回滚。
- 不因单元覆盖率、一次成功或 fixture 成功宣称真实研发、视频或业务任务已提升。
