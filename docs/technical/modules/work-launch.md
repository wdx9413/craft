# Work Launch：从目标到受控运行

v0.11.7 引入 Work Launch，连接用户目标、Host Dispatch、权限与实际运行。v0.11.8 将它的真实终态接入 Experience/Eval Kernel。它是一次工作尝试的稳定标识，不保存 Prompt 正文。

每个 Launch 在运行前创建固定 Subject 版本的 Trial。Host 终态会生成脱敏回执 Artifact、程序 Evidence、Trace 和 Outcome；Outcome 可区分 passed、failed、cancelled 与因 Runner 丢失而 blocked，并记录耗时及回执中明确提供的 Usage/Cost。这只是执行层证据，不宣称业务结果正确。领域验收需要在同一 Task 上追加独立 Grader、Evidence 或人工 Signoff。

写入型 Launch 会持续投影为人类待办，即使关闭页面也不会丢失审批状态；重新打开 Workbench 后，用户需要再次提供与准备阶段摘要一致的 Prompt 才能批准。失败、取消或中断后的重试继承原 Dispatch 的模型、超时、输出上限及 Host 专属预算参数，除非调用方显式覆盖。

只读 Launch 在 Dispatch 完成摘要绑定后立即启动。`workspace-write` Launch 先进入 `awaiting_approval`；批准请求必须重新提交相同 Prompt，Craft 校验摘要后创建只覆盖本 Task、Workspace、Request Digest 的一次性授权，Driver 消费授权后才能执行。

Launch 查询会把关联 Host Run 的真实状态作为 `effective_status`，但不会覆盖历史 Launch。只有 `failed`、`cancelled` 或 `interrupted` 可以 Retry；Retry 必须重新提供 Prompt，产生新的 Launch、Dispatch 和 Run，并用 `retry_of` 保留因果关系。Craft 不持久化 Prompt，因此崩溃恢复不会静默重放指令或重复外部动作。
