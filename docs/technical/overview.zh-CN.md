# Craft 技术方案总览

## 目录

- 分层
- 核心对象关系
- 设计约束
- 模块文档

## 分层

```text
CLI / Desktop / Codex / Claude / DSH / MCP Host
                       │
              Runtime Adapters
                       │
       Agent IR / Planner / Orchestration
                       │
 Capability Catalog ─ Workflow ─ Experience/Eval
                       │
     Artifact / Evidence / Lineage / Signoff
                       │
              SQLite + ~/.craft_data
```

上层宿主负责模型调用、原生工具与交互；Craft Core 负责稳定对象、状态转换、权限、证据和验证。所有宿主共享同一数据目录和协议。

## 核心对象关系

```text
Capability Kit ──contains──> Capability / Validator / Policy / Eval Suite
Task ──compiled to──> Agent IR ──lowered to──> Workflow / Orchestration Plan
Task + Subject Version + Harness Configuration ──creates──> Trial
Runtime Policy + Environment Fingerprint ──controls──> Runtime Run / Operation DAG
Orchestration Plan + pinned Agent Profile Versions ──auto-captures──> Trial / Trace / Outcome
Trial ──appends──> Trace ──produces──> Artifact / Evidence
Trial ──closes with──> Outcome ──aggregated by──> Evaluation Run
Comparable Evaluation Runs ──produce──> Evaluation Comparison
Trial + Grader Version ──produces──> Grade
Evaluation Run + Grades + Signoff Policy ──produces──> Signoff
Signoff ──authorizes──> Workflow or Configuration Promotion
```

## 设计约束

- 版本引用必须精确，不用“当前最新版本”替代历史执行事实。
- Trial、Outcome 和 Evaluation Run 创建后不可覆盖；Trace 只能追加。
- Comparison 只接受相同 Suite 精确版本、分区、Subject 类型和 Case 集合；原始 delta 不冒充统计显著性。
- 程序、模型、人工和业务结果分别记录 provenance。
- Search/Development Case 不得作为 `verified` 晋级证据。
- 副作用、预算和宿主 Sandbox 是不同边界，不能互相替代。
- 自动优化只操作明确声明的设计空间，并保留回滚点。
- 运行中路由使用 Plan 创建时锁定的 Agent Profile 版本，不随“最新版本”漂移。

## 模块文档

- [Capability 与领域 Kit](modules/capability-kit.md)
- [Agent IR](modules/agent-ir.md)
- [Experience / Eval Kernel](modules/experience-eval.md)
- [Workflow / Verification / Signoff](modules/workflow-signoff.md)
- [Runtime 与宿主接入](modules/runtime-integration.md)
- [Closed-loop Runtime](modules/closed-loop-runtime.md)
