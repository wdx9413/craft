# Durable Action Loop 与 Experience Ledger

> 该模块在当前 `v0.12.30` 工作树中开发，不另行提升发布版本。它补的是长任务“持续推进”和经验演进的事实链，不新建第二套 Host、评测或资产发布系统。

## 两个边界清晰的深模块

```text
VerifiedWorkLoop / State Snapshot
        │
        └─ DurableActionLoop
             Work item → proposed action → Host Receipt → re-observation
                                               │
                                      passed Acceptance Gate
                                               │
                                         proven progress

Trace / Outcome / Acceptance / correction
        │
        └─ ExperienceLedger
             observation → diagnostic pattern → intervention
                    └────────────────────────────────────┐
                                                         existing Eval → Signoff → Canary
```

### Durable Action Loop

它不是另一条公开任务主链，也不会替代 `VerifiedWorkLoop`。它只将一个已经准备好的 Work Loop 分成显式、带依赖的 Work Item，并为每次行动固定：

- 目标 Work Item 与验收摘要；
- 行动类型、effect、动作摘要及预期 Snapshot；
- Host 交接摘要、Receipt 引用、再观察 Snapshot；
- 只有 `verify + passed Acceptance Gate` 才可将 Work Item 标为 `verified`。

因此，Host 的“已完成”、一次成功的命令退出或没有正文的 action report 都不算任务进度。恢复时必须提供当前 Snapshot；工作区漂移转为 `needs_replan`，不会沿用旧行动。读、等待、澄清是合法状态，不会被误判为“必须马上调用工具”。

Craft 不执行 `propose` 或 `dispatch` 的 Host 动作；它只保留可复现的 Contract 与 Receipt。真正的 Codex、Claude、CLI 或远程 Host 接入仍须通过既有 Host/Runtime Adapter。

每个 Durable Action Loop 同时创建一条只追加的 canonical `Trace`：`durable.loop.created`、`durable.action.proposed`、`durable.action.dispatched`、`durable.action.observed`、`durable.loop.needs_replan`、`durable.loop.completed`，以及终态 `trace.finalized`。事件只写摘要、引用和状态差异，不写原始 Prompt、文件正文或凭据。Trace 是 SQLite 中的审计事实，不是后台 Worker：没有 Host 的真实 Receipt 与重新观察，循环会停在待回执/待重规划状态，而不会被伪造为完成。

### Experience Ledger

该模块采用“原始观察 / 诊断知识 / 当前执行规则”分层：

- `experience_observation`：成功、失败或纠正的无正文观察，必须引用 confirmed/bounded Evidence；
- `experience_pattern`：至少两份独立观察编译出的成功策略或失败模式，含适用范围和反例；仅供维护/评测使用；
- `experience_intervention`：至多两个设计轴的局部干预草案，带 subject 精确版本、差异摘要、评测和决策历史。

执行 Host 不直接读取 diagnostic pattern；它只接收已经由既有 Capability/Workflow/Context 生命周期验证并激活的资产。被拒绝的干预不会被删除：保留拒绝原因与重试条件，避免在相同模型、Case 和证据下反复提出同一方案。接受干预也不会直接修改 Skill、Workflow、Prompt、Profile 或默认路由；仍需走已有的 Candidate、shadow、Signoff、Canary 和精确回滚。

## MCP 投影与非目标

`craft-mcp-full` 增加 `craft_durable_action_loop_*` 与 `craft_experience_ledger_*`。它们分别归入执行/质量领域面；默认精简核心面不因诊断工具膨胀。组件插件仍通过同一个 MCP 数据面投影，不复制状态数据库。

本模块不宣称已经完成：真实 Codex App 自动事件接入、后台持续 Worker、跨设备恢复、真实业务 Case 的效果提升、跨平台写入隔离，或自动改写用户本地 `SKILL.md`。这些都需要实际 Host/环境和独立评测证据。
