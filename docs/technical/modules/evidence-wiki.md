# Evidence Wiki：带证据的项目知识层

v0.11.29 在原始 Evidence 与可执行 Capability 之间增加本地 Wiki 层。它不是通用 RAG，也不是自动运行的 Skill 市场。

## Markdown 优先，数据库作控制面

每个 Wiki 修订都是实际的 `~/.craft_data/knowledge/md/<page-id>.v<version>.md`。知识域索引位于 `~/.craft_data/knowledge/knowledge.db`，记忆域索引位于 `~/.craft_data/memory/memory.db`；主 `craft.db` 仍保存跨域事务和生命周期控制。目录保持扁平，文件名由记录 ID 和版本组成，避免覆盖历史正文。Markdown 以 `craft.content.v1` frontmatter 描述记录类型、范围、状态、敏感级别、来源、版本和 SHA-256 正文摘要；人可以用任意编辑器阅读和修改，显式刷新后把人工修改登记为新版本。Craft 不把正文藏进 SQLite：数据库只保存页面位置、内容摘要、版本、Claim 引用和审计状态，用来检索、发现冲突和重建历史。

旧版 `wiki/` 文件和 SQLite 内联正文通过显式 `craft_content_migrate` 迁移。迁移先做数据库备份，支持 dry-run、幂等和漂移即失败；失败不会静默覆盖正文。`craft_content_status`/`craft_content_verify` 可检查引用是否完整、缺失或被篡改。

## 对象与边界

- `knowledge_claim`：事实、规则、决策、术语或失败模式；创建时必须引用已有 Evidence，初始状态始终为 `candidate`。
- `wiki_page`：可由人或 Agent 修订的解释页面；页面引用 Claim，但页面文本本身不提升事实可信度。
- `knowledge_relation`：Claim 间的支持、矛盾、替代、适用或依赖关系。
- 显式 Review 才能把 Candidate 标记为 `reviewed`；争议、过期和替代保留版本历史，不删除旧事实。

所有入库文本先经敏感赋值检测；记录不授予网络、文件写入或工具调用权限。后续上下文编译、能力候选和知识评测只消费适用状态的 Claim，不能把 Wiki 正文直接当作指令。
