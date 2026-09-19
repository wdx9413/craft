# Trace & Evolution Kernel

> v0.12.32 新增 Trace Review：它读取不可变 Trace 与事件，输出首错、根因、版本指纹和保守 verdict。Review 是诊断证据，不是发布 Gate；只有真实 Outcome、评测和 Signoff 才能改变路由。

> 状态：v0.12.33 已实现统一的 Trace 事件账本、反馈信号、Digest-only Replay Bundle、Trace→Case 编译，以及可替换的冷热归档。它是跨入口的事实层，不是自动发布或模型训练器。

## 事件信封

每条 canonical Event 至少绑定：

```text
event_id / trace_id / span_id / parent_span_id / sequence
task_id / run_id / trial_id / attempt_id / operation_id
actor / source / trust / event_kind
action_contract / state_before / state_after
capability_revision / policy_revision
model_fingerprint / environment_fingerprint
workspace_before / workspace_after
usage / cost_usd / duration_ms / error_class
input_refs / output_refs / evidence_refs
```

原始 Prompt、凭据和业务正文不进入 canonical payload；调用方应提交 Artifact、Evidence、Snapshot 或内容 Digest 引用。

## 生命周期

```text
start → append / observe / feedback → finalize
                 ↓
          Replay Bundle / Case Compiler
```

事件序列必须连续，重复 `event_id` 必须内容一致，终态 Trace 拒绝追加。`observe` 标记外部状态观察，不等于模型声称完成。`feedback` 记录接受、拒绝、纠正、重试、停止、交接和评分，作为经验挖掘的归因信号。

## 与旧接口的关系

旧 Trial stream 保留，兼容入口 `craft_trial_trace_append` 不变；Craft 会把它投影到 `trace:trial:<id>`。Outcome 也会追加 `outcome.recorded`，并按 `passed/failed/blocked/cancelled` 自动收口对应 Trial Trace，所以既有评测链无需迁移即可获得统一 Trace。

MCP 宿主调用也有统一的关联层。除只读 introspection 和显式 `craft_trace_*` 管理接口外，每次 `tools/call` 会创建脱敏的 `component.call.started`、`component.call.completed` 或 `component.call.failed` 事件，并在响应中返回 `trace_correlation`。调用方可以传入 `trace_id`/`correlation_trace_id` 和 `task_id` 加入父 Trace；未传入时 Craft 为这次调用建立独立的终态 Trace。输入和输出只保存 Digest，不保存参数正文。

## 进化安全

Trace 必须先经过脱敏、可信度分类和 Case 分区，才能进入 Evaluation。development 与 held-out 分离；held-out 需要独立批准。任何 Candidate 仍需既有 Evaluation、Signoff、Canary 和 rollback 证据，Trace 本身不能授予发布权限。

## 接入层原则

GUI、CLI、Codex、Claude、Trae、WorkBuddy 和 Skill/MCP 只负责产生或展示事件；Trace Schema、关联关系、幂等、回放可行性和 Case 编译全部由 Craft Core 负责，避免各宿主形成不同的进化数据格式。

## 存储与保留

Trace 的逻辑事实不等于某一种物理存储。活动 Run 的索引、状态与短期事件仍保留在 SQLite，便于事务关联、权限过滤和低延迟查询；到期的终态 Trace 会由 `retentionSweep` 写为按日期分区、私有权限的 gzip JSONL 段，然后仅在 SQLite 留下版本化 Archive Pointer。

默认 `LocalTraceArchiveStore` 写入 `logs/trace-archive/YYYY/MM/DD/`，单个归档段包含 manifest、Trace、Event 和 Feedback，并以内容摘要校验。默认热保留期是 **7 天**；`craft_trace_retention_plan` 保存的 `default` Policy 会被后台 Maintenance 自动读取。若要调整已有 Policy，必须明确传入 `replace: true`，避免因同名配置的误调用改变保留期。

`TraceArchiveStorageKernel` 是数据存储插件的配置与运行时 seam。用户可用 Full MCP 登记 `storage_id`、`backend_id`、`credential_ref` 与 `configuration_ref`，再显式激活；Craft 只保存引用，不保存密钥，也不会从配置动态加载任意代码。部署方把已审查的 `TraceArchiveStore` Backend 注入 Craft 进程后，登记项才会显示为 available 并允许激活。`ObjectTraceArchiveStore` 是其中一个对象存储实现 seam；可对接 S3、OSS、MinIO 或企业存储，但具体 SDK、网络和凭据生命周期由部署插件负责。

`craft_trace_get` 与 `craft_trace_query` 始终经 Craft Core 读取热数据或 Archive Pointer；调用方不应直接读取 SQLite 或归档目录。这样服务端可以在同一查询路径施加项目范围、授权、脱敏和未来的远程对象存储访问控制。损坏、越界 Locator、摘要不符或格式不符的归档均失败关闭。

归档只迁移已经终态且满足保留策略的记录；它不自动清空活动 Trace，也不对既有数据库做强制迁移。归档后的 Trace 仍可通过相同的读接口获取，事件会标记为 archived。选中的外部 Backend 不可用或写入失败时，归档 Sweep 失败关闭：热 Trace 与事件不会删除，Maintenance 会记录失败并按既有退避策略重试。
