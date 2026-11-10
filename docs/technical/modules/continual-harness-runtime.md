# Continual Harness 与持久计算协议

> v0.12.20 把“任务后复盘”连接到下一轮可用的 Harness 状态，同时保留 Craft 原有 Eval、Signoff、Canary 与回滚边界。它参考业界持久 Harness 的思想，不依赖或内置任何特定第三方 Agent。

## 模块边界

```text
Trace / Outcome / Acceptance
          ↓
ContinualHarnessView（精确版本、无正文投影）
          ↓
Refinement（来源 + Evidence + 假设 + 最多两个设计轴的 Diff）
          ├─ Session 低风险 Prompt Note / Memory
          │      └─ 隐私检查 + TTL → bounded_active → 可精确撤销
          └─ Skill / Workflow / Sub-agent 等治理变更
                 └─ Shadow Eval → exact Signoff → Canary → active / rollback
```

`ContinualHarnessView` 不是新的事实库。它只固定 Task 实际绑定的 Prompt Note、Memory Ledger、Capability、Workflow、Expert、Topology、Runtime Plan、Context Receipt 与 Activation Profile 的 ID 和版本，不复制正文，也不授予执行权限。

`Refinement` 不是“模型说自己学会了”。每次候选必须引用真实运行对象和 confirmed/bounded Evidence，包含可审查假设与局部 Diff，并最多改变两个 Harness 设计轴。低风险 Session 适配只允许新增或更新 Prompt Note/Memory，最长存活一天且不能发布；项目级或用户级变更必须经过既有可信评测链。

`signals` 只从同一 Task 的失败 Acceptance 和已通过 Outcome 产生复盘提示，不自动修改 Harness。下一轮由 `resolve` 选择与 Session 相符且未过期的临时 Refinement，以及已完成治理的正式 Refinement，并形成不含正文的 `HarnessResolutionReceipt`。因此“产生候选”和“真正进入下一轮上下文”是两个可审计步骤。

更底层的观察、失败模式和干预接受/拒绝理由可由 [Experience Ledger](durable-action-experience.md) 留存。该账本仅服务维护与评测，执行 Host 不能把未验证诊断模式当作临时提示绕过当前 Skill/Workflow 边界。

## Stateful Compute Host

`StatefulComputeKernel` 是 Host 无关的控制协议，不是 REPL 实现或执行器：

```text
Host Descriptor
  → Session（Task / Context Receipt / Workspace Snapshot / Environment / Root Budget）
  → Dispatch（动作摘要 + 输入引用 + 期望 revision）
  → 外部 Host 执行
  → Receipt（单调 revision + State digest + Artifact refs + usage）
```

持久计算可以由 REPL、Notebook、Agent Host 或其他 Adapter 实现。Craft 不保存运行时变量正文；环境指纹变化、旧 revision、重复或模糊回执均失败关闭。生成代码 Host 必须绑定已验证、禁网的 Sandbox Conformance，写入 Session 也必须处于已验证边界；登记本身不等于允许执行。

## Sub-agent-as-Function

函数式委派是 `StatefulComputeSession` 下的只读异步调用。每个父 Session 最多五个调用，子调用继承同一根预算引用，只获得 Context/Artifact 引用与显式分配量，不能继承未声明的正文或权限；父 Session 取消会传播到仍在运行的子调用。结果必须包含假设、反例、confirmed/bounded Evidence、置信边界和下一步；父 Agent 仍负责裁决。

默认 Harness 继续是单 Agent。Sub-agent 只有在同环境、等预算的评测中证明净收益后，才可通过现有 Harness Topology 候选进入路由。

## 明确不做

- 不引入、绑定或识别某个第三方 Agent 实现。
- 不让复盘直接改写全局 Prompt、Skill、Workflow 或默认拓扑。
- 不把持久进程、Kernel 或后台 Worker宣称为安全沙箱。
- 不保存原始私有思维链、凭据、完整业务正文或运行时变量。
- 不因注册 Host、生成 Dispatch 或签发子调用而扩大执行权限。
