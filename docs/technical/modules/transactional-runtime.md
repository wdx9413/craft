# Transactional Runtime 与 Trajectory Compiler

## 事务协调器

`TransactionCoordinator` 是 Workspace 之上的小协调模块：

```text
prepared baseline checkpoint → committed checkpoint
                       └────→ approved rollback to baseline
```

它只覆盖 `local_write` 的已声明 Workspace 路径。Begin 会先创建不可变基线 Checkpoint；Commit 必须引用同一 Workspace 的精确 Checkpoint；Rollback 必须由调用者明确批准，并复用 Workspace 的受限 Restore。它不把第三方 API、数据库或网络写入伪装成可回滚事务——这些仍需要专用 Adapter 与补偿契约。

## 轨迹编译器

`TrajectoryCompiler` 从同一 Task 的 passed Trial 提取出处，生成固定模板的 TypeScript Proposal。它不接收模型提交的任意源码，也不执行生成代码。

- 当前白名单只包含版本锁定的 `workflow` 和可标注的 `checkpoint` 操作。
- 生成文件没有 import、动态执行或外部副作用；保存源码摘要、来源 Trial 和静态检查结果。
- Proposal 初始为 `draft`。只有 held-out Evaluation 的精确 passed Signoff 指向同一 Proposal 版本后，才能变为 `verified`。

下一版的 Runner 只应消费 `verified` Proposal，并在 Workspace Transaction、Effect Policy 和 Host Adapter 边界内解释其 IR；不得直接 `eval` 生成的 TypeScript。
