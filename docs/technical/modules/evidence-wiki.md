# Evidence Wiki：带证据的项目知识层

v0.11.29 在原始 Evidence 与可执行 Capability 之间增加本地 Wiki 层。它不是通用 RAG，也不是自动运行的 Skill 市场。

## Markdown 优先，数据库作控制面

每个 Wiki 修订都是实际的 `~/.craft_data/wiki/<page-id>.v<version>.md`。人可以用任意编辑器直接阅读和修改最新文件；读取会返回磁盘正文，显式刷新后把人工修改登记为一个新版本。Craft 不把正文藏进 SQLite：数据库只保存页面位置、内容摘要、版本、Claim 引用和审计状态，用来检索、发现冲突和可重建历史。

## 对象与边界

- `knowledge_claim`：事实、规则、决策、术语或失败模式；创建时必须引用已有 Evidence，初始状态始终为 `candidate`。
- `wiki_page`：可由人或 Agent 修订的解释页面；页面引用 Claim，但页面文本本身不提升事实可信度。
- `knowledge_relation`：Claim 间的支持、矛盾、替代、适用或依赖关系。
- 显式 Review 才能把 Candidate 标记为 `reviewed`；争议、过期和替代保留版本历史，不删除旧事实。

所有入库文本先经敏感赋值检测；记录不授予网络、文件写入或工具调用权限。后续上下文编译、能力候选和知识评测只消费适用状态的 Claim，不能把 Wiki 正文直接当作指令。
