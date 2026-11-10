# Supply-chain Governance：可信能力的持续治理

## 目的

能力通过认证不是“一次可信、永久可信”。Hub 来源可能停用，目录条目可能撤回或换摘要，安全团队也可能在安装后发现高危问题。持续治理把这些变化传播到本地资产、激活方案和恢复队列，避免旧的 `verified` 标签继续误导规划器。

## 失效传播

`craft_supply_chain_reconcile` 对同一 Source 下已晋级的 Certification 重新核对：Source 是否 active；Catalog Entry 是否 active 且摘要仍匹配；是否存在命中 Entry 或 Asset 的 active high/critical Advisory；当前 Asset 是否仍由原 Certification 拥有且保持 verified。

命中任一条件时，Craft 在同一事务中将当前 Asset 标为 `health=stale`、`governance_status=blocked`，将 Materialization 标为 `recertification_required`，将 Certification 标为 `invalidated`，并使引用该认证产物精确版本的 Activation Profile 失效。规划器只选择 healthy Asset，因此新任务失败关闭。

Recovery Queue 会从 invalidated Certification 确定性投影 `recertify_capability` 工作项。该投影可重复刷新、可租赁和留回执，但不会自行下载、删除、执行、回滚或重新认证能力。

## 安全公告

公告必须精确绑定一个可信 Source，并且只命中一个 Catalog Entry 或 Capability Asset。公告保存严重度、摘要和既有 Evidence 引用，不保存凭据或原始包内容。low/medium 只保留观察记录；high/critical 才阻断认证产物。解决公告需要新的 Evidence，并保留完整版本历史。

## 当前边界

当前实现是本地持久化控制面和 MCP 接口，不主动轮询 Hub，也不自动生成漏洞结论。Hub Transport、漏洞扫描器或管理员可以提交证据化公告并触发 reconcile。重新启用来源或解决公告不会自动恢复旧认证；能力必须重新走完整认证流程。
