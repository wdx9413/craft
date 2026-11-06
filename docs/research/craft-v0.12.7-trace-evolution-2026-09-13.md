# Craft v0.12.7：Trace & Evolution Kernel

v0.12.7 将分散在 Trial、Host Run、Autonomous Runtime、Workspace、Outcome 和反馈对象中的运行事实收敛为统一的 `craft.trace.v1` 事件账本。Trace 仍然不保存 Prompt 或业务正文；它保存可关联的引用、摘要、Digest、状态转移、权限/能力/模型/环境指纹和 Evidence 引用。

## 已实现

- `TraceKernel`：统一 `trace_id`、`span_id`、父子关系、连续序列、来源可信度、动作契约、状态前后引用、能力/Policy/模型/环境指纹、Usage、Cost、Latency、错误类别和 Evidence/Artifact 引用。
- `craft_trace_start` / `append` / `observe` / `feedback` / `finalize`：所有入口可写入同一事实格式；事件不能跳号、终态不能继续追加，重复请求按 Digest 幂等。
- Trial 投影：既有 `craft_trial_trace_append` 和 Outcome 会自动生成对应的 canonical Trace，不破坏旧的 Trial stream。
- Replay Bundle：只导出 Digest 和引用，不导出原始 Prompt；只有指纹和动作契约完整时才标记为可重放。
- Trace Case Compiler：终态 Trace 可编译成脱敏 development Case；held-out Case 必须有独立批准者，不能自动进入发布链。
- Feedback Signal：保留接受、拒绝、纠正、重试、停止、交接和评分等可用于失败归因的信号。
- Retention Policy：记录保留期限、事件上限和摘要模式；实际删除仍需人工复核。
- Core MCP 只暴露 Trace 读取和回放查询；写入、反馈、Case 编译和策略变更属于显式管理面。

## 进化数据边界

Trace 不是训练语料，也不能直接变成 Skill。正确路径是：

```text
Task Contract
  → canonical Trace
  → redaction / trust classification
  → development or held-out Case
  → Trial / Outcome / Evaluation
  → Candidate / Signoff / Canary
```

`model` 自述、网页或工具返回的未验证正文只能标记为 `untrusted`；状态快照、程序检查、Host Receipt、人工决定和 Evidence 必须分开表达。这样模型变化、工具变化、环境漂移和人工修正才可以被单独归因。

## 仍然不是本版承诺

- 标准 OTel Collector、云端 Trace Lake、多人租户同步和跨设备冲突解决；本版提供稳定的导出边界。
- 自动从 Trace 生成并发布 Skill/Workflow；Candidate 仍需脱敏、评测、Signoff 和 Canary。
- 任意 Host 的真实动作回放；回放包只在依赖、指纹、状态引用和动作契约齐全时报告可重放。
