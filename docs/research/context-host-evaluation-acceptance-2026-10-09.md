# Host 与 Context 效果链路验收

版本不变，仍为 0.12.39。本实现复用 TaskRun、HostSession、Context Pack、Evidence、Procedure Invocation Outcome、Experience Graph authoring 与 Campaign Runner，不创建第二个执行器。`core/context-host-evaluation.ts` 是可直接调用的 SDK module；模型收益不会由登记、观测或评分自动变成 proven。

## 公开 interface 与接入合同

公开 MCP 保持工具数不变：`craft_knowledge_evaluation_run(mode=citation_support)`；`craft_experience_graph_inspect(action=evaluate_applicability)` 实际执行原 Graph matcher；`craft_experience_graph_edit(action=improvement_propose|improvement_save|improvement_submit)` 委托治理建议与既有 Graph 编辑。

`new ContextHostEvaluation(store)` 提供：

- `registerHost` / `matrix`：codex、claude、skill_mcp、dsh、external 的已登记合同；未提供的 Host 能力是 unknown。`full_mcp` 初始集合必须覆盖完整 definitions（工具ID单独允许4096项，材料引用仍上限1000）；`native_deferred` 保留完整 definitions、初始集合为子集，并要求 confirmed/program conformance Evidence 绑定 Host fingerprint、Schema digest 与发现模式。登记仍为 declared，不冒充真实会话验收。
- `recordEmission`：从 TaskRun.launch_identity、WorkLaunch、TaskControl 合同和 Task 交叉派生真实 task/Host/workspace；忽略手工顶层 task_id/scope，并拒绝缺链或漂移。绑定 HostSession、模型/Schema 与 Context Pack；pack 的 Working Set 必须属于相同 task_id/session_id，项目 scope 必须与 Task.project_id 一致，task scope 必须属于该 Task；available refs 必须等于 pack asset refs 的 `member:id@version`，emitted refs 只能是其子集。正文只保留 emission digest，不保存完整 prompt。实际 injected/schema/history tokens、latency 与可选 cost 为 `host_reported`；未知成本为 null，不写零。emission digest 仍只是 Host 自报摘要，`actual_model_use=unknown`，不构成模型看见或使用正文的独立证明。
- `evaluateKnowledge`：期望相关引用与实际 emitted 引用计算 recall/precision；结论支持另用 confirmed program/human Evidence，metadata 精确绑定 emission、claim digest、reference、supported，human 必须标明 reviewer。校准 judge/人工标注由调用端负责；结果明确 judge_calibration=unknown、support_truth_proven=false；格式正确的 Evidence 不是最终事实真实性证明。支持评测不修改 Claim。
- `proposeGraphImprovement`：只从对应 scope 的真实非成功 Invocation Outcome 与相同 invocation Receipt 定位 node_path/failure_stage，保留公开 output refs 和 Evidence；结果是 pending_review。这里证明失败位置，不宣称根因。
- `submitGraphImprovement`：reviewer、proposal digest 和既有 Graph CAS 后保存 draft；显式 action=submit 及 expected_draft_digest、当前磁盘 draft 的 title/procedure_kind/definition/Workflow scenario 与 proposal 精确匹配后，才通过原 Graph authoring提交 Candidate；不能将已漂移的另一份草稿归因为本建议。正常晋级仍走原门禁，不直接改正式发布指针。
- `evaluateApplicability`：按 scenario/Host/model 汇总适用判断与场景外错误激活；公开 Graph 入口通过 evaluateGraphApplicability 调用原 matcher 而非相信调用方自报实际适用性。标签/路由观测不替代终态任务效果；报告 provenance 与 task_outcome_proven=false。

## 接入既有真实消融脚本

沿用原有 manifest 与执行器：

```sh
node scripts/eval/run-component-ablation.ts DATA_DIR manifest.json
```

manifest 可增加 `context_host_contract`（字段遵循 registerHost）与 `host_adapter.observe_context:true`。Adapter 在现有 execute 返回 TaskRun 后接受 `{"action":"observe_context","task_run_id":"..."}`，返回 recordEmission 的输入字段，contract_id/task_run_id 由 Runner 强制设置。观测中断或引用不匹配时保留 pending 记录；下一次执行停止于 reconciliation_required，不重复发送已绑定的动作。修复观测后直接调用 recordEmission 会完成该 pending 记录，再恢复 Campaign。

没有配置 Context 观测时旧 Adapter 保持兼容。缺实际交付保持 awaiting_actual_outcomes；真实终态评分仍调用原 Campaign grader。

## 本地验收

```sh
node --test --test-isolation=none --test-concurrency=1 tests/context-host-evaluation.test.ts tests/component-ablation-execution.test.ts
node node_modules/c8/bin/c8.js --include=core/context-host-evaluation.ts --include=scripts/eval/run-component-ablation.ts --reporter=text node --test --test-isolation=none --test-concurrency=1 tests/context-host-evaluation.test.ts tests/component-ablation-execution.test.ts
```

已覆盖误绑定、遗漏 Schema、假 deferred 声明、引用漂移、未知成本、非法数值、citation不支持、缺少支持证据、正式Graph不自动发布、场景外误用与Campaign观测绑定。观测 fixture 经公开 TaskOpen→TaskControlSave→TaskRunPrepare→HostSessionOpen→ContextOpen 生成真实关联记录，400 Campaign slots 的观测接线通过；这仍是合成任务与停用Host启动，不代表本机真实 Codex/Claude/dsh 会话、模型 judge 校准、实际费用或收益。
