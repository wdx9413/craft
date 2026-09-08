# 风险分级执行

`Execution Decision` 是一个深模块：调用者只给 effect、平台和少量事实，模块返回一个明确的执行层级，不把沙箱细节扩散到每个 Host。

| 条件 | 决策 | 含义 |
|---|---|---|
| `read_only` | `host_read_only` | 普通 Host 可自主执行；Windows 完整支持。 |
| macOS/Linux 的本地生成代码写入 | `isolated_local` | 需要可用本地隔离器、命令/路径白名单和网络拒绝。 |
| 外部写入，或未选择/不可用的本地隔离 | `approval_required` | Craft 保留状态和审批点，不自主落地副作用。 |
| 无补偿的破坏性 effect，或需要未受信任 Broker 的凭据 | `blocked` | 失败关闭，不能降级成裸执行。 |

`LocalIsolatedAdapter` 不是全局要求，也不是容器替代品。当前 macOS 使用 `sandbox-exec`；Linux 仅在受支持隔离器存在时启用；Windows 可照常执行读/规划和审批流，但需要硬隔离的动作必须交给未来 Docker、Windows Sandbox、远程 Adapter 等实现。内置凭据 Broker 始终拒绝。

关联：[Closed-loop Runtime](closed-loop-runtime.md) · [Runtime 与宿主接入](runtime-integration.md)
