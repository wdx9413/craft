# 执行与恢复一个组合 Procedure

适用：已选定 Entry/Exit，需要跨步骤、子流程和会话跟踪执行。仅查看资产时使用 `craft_procedure_plan`；它的 `acceptance_status` 不代表实际完成。

## 前提与接入

执行 Host 先通过现有 Craft Runtime 准备好同一 Task、有效 Task Control Contract、Task Run、Verified Work Loop 和真实 State Snapshot。Experience 与 Runtime 必须指向同一 `CRAFT_DATA_DIR`。完整 Runtime 可通过 `craft-mcp-full` 接入；Experience daily 不扩大为完整 Runtime 工具面。Skill + MCP 即可工作，Hook 可选。

已有任务直接复用 `work_loop_id`；创建任务遵循 Runtime 的 launch/policy/approval 规则。不同 Host 的文件修改、命令执行和许可仍由各自适配器负责。`dispatch` 返回 `host_execution_authority: false`，不会代替 Host 执行动作。

## 最短路径

1. 调用 `craft_procedure_invocation_bind`，传入稳定且唯一的 `invocation_id`、`work_loop_id`、Procedure 版本、scope、entry_id、exit_id、input_refs、allowed_effects，以及 `host_id`、`model_fingerprint`、`budget_fingerprint`、`max_dispatches`、`ttl_ms`。`input_refs` 使用不可变材料引用；后续输入变更需新建调用。只支持 read_only/local_write，且必须在 Task Contract 内。
2. `craft_procedure_invocation_get` 返回调用、持久工作项、派发和回执。选择依赖项全部 verified 的 pending 工作项，将当前 `expected_version`、真实 `snapshot_id` 与 `item_key` 传给 `craft_procedure_invocation_dispatch`。重复派发请求看到 await_receipt 时，先核对原派发结果。
3. 第一次进入每个子调用时，提供 `precondition_evidence: { "root/review": { "approved": "evidence-id" } }`。键是完整调用路径；同名条件不会跨子调用复用。每份 confirmed Evidence 的 metadata 必须包括 scope、invocation_id、call_path、task_id、condition_ref、input_digest、snapshot_digest、workspace_state_revision、expires_at。输入摘要由实际子输入引用计算。父步骤新生成的材料要等已验收后再为子入口取证。
4. Host 执行 `work_item` 后，在 Runtime 记录 Host Session 与终态事件。Session 固定相同 task_id/host_id/model_fingerprint/budget_fingerprint，并把 capability_fingerprint 设为返回的 dispatch_digest。随后重新观察工作区，由另一个 observer_id 的 program 验证器记录 Outcome Observation；其 trace_id、environment_fingerprint 和 state_snapshot_ref 与本次 Session/快照一致。
5. `craft_procedure_invocation_report` 接收 dispatch_id、host_session_id、observation_id、snapshot_id、output_refs、acceptance_evidence_ids 和当前 expected_version。program/confirmed Evidence 必须列在 Observation 中，metadata 包括 dispatch_digest、acceptance_digest、output_digest、state_after_digest、status。可附 `metrics: { cost_units, latency_ms, retry_count }`，三者均需真实测量；缺失保留 unavailable。多个测量证据必须一致。
6. 每个 `$exit` 是独立工作项，按其 acceptance_ref 验收已经生成的输出。子出口通过后，父流程才能消费映射产物；出口不能替换产物。同一次 report 重试返回原回执，不重复推进。失败保留失败阶段，并阻止父流程继续。
7. 中断后读取调用，再调用 `craft_procedure_invocation_resume`，提供当前快照和版本。`reconcile_dispatch` 表示已有派发等待结果，先读取 dispatches 核对，不能重新执行；`replan` 表示输入/工作区变化，重新准备 Runtime 和调用。撤销、版本变化、过期或预算耗尽时停止派发。

以上 Session/Observation/Evidence 是 Host 上报的证据链，返回的 `verification_provenance: host_attested` 不证明提交方确实独立执行了程序。它不会自动晋级 Procedure；需由可信 CI/验收器实际运行并保留来源，才能声称独立验收。

## 评估

`craft_procedure_invocation_evaluate` 接收相同 scope 下 3–100 对互不重复的 baseline_ids/candidate_ids。每对固定入口、出口、输入摘要、初始快照、Host、模型和预算。只接受终态调用，返回通过率及逐对时长/成本/重试指标；缺测量值不会当作零。嵌套调用的 Outcome 单独保留 Procedure 定义摘要、版本、入口、出口、输入摘要及失败阶段。评估始终 `promotion_eligible: false`。

## 补证恢复与并行

回执分别保留 passed、failed、blocked、inconclusive、cancelled。blocked/inconclusive 等待补证；failed 仅在定义的 `failure_disposition: "retry"` 下可重试；cancelled 保持终态。补证后 `resume` 传 `recovery_evidence_id`：program/confirmed Evidence 的 metadata 必须绑定 invocation_id、receipt_id、当前 snapshot_digest、workspace_state_revision、safe_to_retry: true 与未来 expires_at。恢复会重验 Policy、版本、TTL 和预算。每工作项最多重试三次，派发总数仍受 max_dispatches 约束。

Route 可声明 `parallel_groups: [["review", "test"]]`，每组 2–8 个连续、独立的 read_only 指令步骤。组内不得消费彼此的输出，也不能包含 procedure_call。从 get 返回的 ready 工作项逐个取得派发，Host 可并发执行；report 仍使用最新 expected_version 顺序提交。所有分支验收后才能汇合。local_write 保持串行。运行时条件分支、回环和补偿需单独的 Graph 合同，不能由这项并行声明推断。
