# Trace & Evolution Kernel

> 状态：v0.12.7 已实现统一的本地 Trace 事件账本、反馈信号、Digest-only Replay Bundle 和 Trace→Case 编译。它是跨入口的事实层，不是自动发布或模型训练器。

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

旧 Trial stream 保留，兼容入口 `craft_trial_trace_append` 不变；Craft 会把它投影到 `trace:trial:<id>`。Outcome 也会追加 `outcome.recorded`，所以既有评测链无需迁移即可获得统一 Trace。

## 进化安全

Trace 必须先经过脱敏、可信度分类和 Case 分区，才能进入 Evaluation。development 与 held-out 分离；held-out 需要独立批准。任何 Candidate 仍需既有 Evaluation、Signoff、Canary 和 rollback 证据，Trace 本身不能授予发布权限。

## 接入层原则

GUI、CLI、Codex、Claude、Trae、WorkBuddy 和 Skill/MCP 只负责产生或展示事件；Trace Schema、关联关系、幂等、回放可行性和 Case 编译全部由 Craft Core 负责，避免各宿主形成不同的进化数据格式。
