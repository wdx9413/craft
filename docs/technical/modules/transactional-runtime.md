# Transactional Runtime 与 Trajectory Compiler

## 事务协调器

`TransactionCoordinator` 是 Workspace 之上的小协调模块：

```text
prepared baseline checkpoint → committed checkpoint
                       └────→ approved rollback to baseline
```

它只覆盖 `local_write` 的已声明 Workspace 路径。Begin 会先创建不可变基线 Checkpoint；Commit 必须引用同一 Workspace 的精确 Checkpoint；Rollback 必须由调用者明确批准，并复用 Workspace 的受限 Restore。它不把第三方 API、数据库或网络写入伪装成可回滚事务——这些仍需要专用 Adapter 与补偿契约。

## 轨迹编译器

`TrajectoryCompiler` 校验同一 Task 的 passed Trial 作为出处，并接收调用方提供的 `operations`，生成固定模板的 TypeScript Proposal。它尚未从原始 Trace 自动推断这些操作，也不接收任意源码或执行生成代码。

- 当前白名单只包含版本锁定的 `workflow` 和可标注的 `checkpoint` 操作。
- 生成文件没有 import、动态执行或外部副作用；保存源码摘要、来源 Trial 和静态检查结果。
- Proposal 初始为 `draft`。只有 held-out Evaluation 的精确 passed Signoff 指向同一 Proposal 版本后，才能变为 `verified`。

执行交接只消费 `verified` Proposal；真实 Runner 仍需在 Workspace Transaction、Effect Policy 和 Host Adapter 边界内解释其 IR，不得直接 `eval` 生成的 TypeScript。

## 已签发脚本运行

v0.9.12 已实现这个交接边界：`verified` Proposal 只能绑定到同一 Workspace 的 `prepared` Transaction，生成一次性的 `verified_script_run` 与精确 Host 操作单。Host 回执必须逐项匹配，状态才会变为 completed/failed/cancelled。Craft 仍不在本模块执行 TypeScript；真实 Host 执行、隔离和外部 Effect 继续受 Runtime Adapter/Policy 约束。

## Time Travel 与语义恢复（目标）

区分三种操作：读取历史快照不执行副作用；从分支重新运行会产生新的 Run/Trial 并重新授权；补偿实际副作用需要专用契约。重放不能保证模型生成相同输出，也不能回到外部世界的历史时刻。

本地恢复应先检查当前版本与后续用户改动，支持冲突提示、选定范围恢复和可审查差异。当前 `approved=true` 加文件复制不提供数据库或外部系统的恢复保证。

## External Effect 与 Saga Kernel

v0.10.2 已加入外部副作用的控制面状态机，但它不是远端事务管理器：

```text
prepared → executing → succeeded | failed | indeterminate
                         └→ compensating → compensated | compensation_failed | compensation_indeterminate
```

- `external_write` 与 `destructive` 必须在执行前固化目标、请求摘要、稳定幂等键和审批引用；可选补偿也必须预先声明动作与请求摘要。
- Host 只能领取精确 Dispatch，并以不可变 Receipt 报告结果。成功必须有远端操作 ID；网络中断等未知结果记录为 `indeterminate`，禁止自动重放。
- 未知结果只能由 `resolver_type=human` 的显式、带 Evidence 决策消歧；Agent 不能自行猜测成功或失败。
- 若远端提供只读状态端点，Reconciler 可绑定同一 Task 的一次性 Egress Authorization，并在请求前声明互斥的成功/失败 HTTP 状态集合。它只发出 `GET`，只消费 Broker 产生的程序 Evidence；未映射状态和网络异常继续保持 `indeterminate`。当前不解析响应正文，也不会让不可信正文参与状态决策。
- Saga 只把同一 Task 的有序 Effect 组织起来，并从当前状态推导下一安全动作；失败后按已成功且可补偿的 Effect 逆序给出补偿计划。
- 补偿成功、失败和未知是不同终态。对于预先声明且绑定精确 Egress Authorization 的补偿，Broker Adapter 可直接执行；动作、请求摘要、审批及成功/失败 HTTP 状态契约都必须在 Dispatch 前冻结。摘要或授权错误发生在网络发送前时取消本次尝试；发送后的网络异常一律记为 `compensation_indeterminate`。Craft 不声称能撤销不可补偿动作。
- Effect 可关联 Trial，准备、开始、回执、消歧和补偿事件会进入同一 Trace，供 Outcome、复盘和评测使用。

## 自动轨迹编译与 API 组合（目标）

```text
真实 Trace + 用户修正 + Outcome
  → 多案例对齐 / 去除重试与偶然顺序
  → 有依据的数据依赖、参数、分支与前后置条件
  → 类型化 IR：确定步骤 + 必要模型判断 + 验证器
  → TypeScript/Workflow 候选 → 独立评测 → 受控采用
```

- 所谓 API 组合/Polymerization 是组合已有授权动作与数据流，不凭空创造外部 API，也不能越过它们的权限、费用和限流。
- 一次成功路径不足以确定未观察到的分支。无法确定的绑定保留模型判断、询问或拒绝编译；不把相邻调用直接当因果依赖。
- 复用前检查输入、模型/工具/Schema 版本与环境条件；失配返回探索，副作用不能因“已编译”而跳过 Policy。
- 产物可为规则、模板、Workflow、TS 程序或绑定工作对象的小工具。WASM 仅是可选后端方向，Craft 继续使用 TypeScript/npm，不新增 Python 必需依赖。
- 成本比较包括提炼、编译、评测、维护、执行和残余模型调用。工具调用减少不等于端到端提速，更不等于零成本。

关联：[执行策略与沙箱](execution-policy.md) · [评测](experience-eval.md) · [上下文与记忆](context-memory.md)
