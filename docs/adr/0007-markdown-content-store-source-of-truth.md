# ADR 0007：知识与记忆正文使用可迁移 Markdown 存储

## 决策

Craft 将 `knowledge_claim`、`wiki_page` 的正文写入 `~/.craft_data/knowledge/md/`，将 `memory_ledger`、历史 `episodic_memory`/`semantic_memory` 写入 `~/.craft_data/memory/md/`。`knowledge/knowledge.db` 与 `memory/memory.db` 是可重建域索引，主 `craft.db` 继续保存跨域事务。文件目录扁平，文件名为 `<record-id>.v<record-version>.md`，正文前置 `craft.content.v1` frontmatter 和 SHA-256 digest。SQLite 不再承担大段正文。

## 原因

- Markdown 可检查、可迁移、可由用户备份；SQLite WAL 继续提供事务、索引和 OpenAPI/MCP 查询。
- 版本文件避免人工编辑或并发更新覆盖历史；引用读取会校验路径、元数据和 digest，漂移即失败关闭。
- 文件和数据库职责清晰，未来可接入外部 ContentStore，而不改变知识/记忆领域契约。

## 迁移与生命周期

`ContentMigrationKernel` 提供 dry-run、数据库备份、幂等迁移和状态/校验查询。迁移发现旧内联正文或旧 Wiki 文件后，先验证全部正文，再写版本 Markdown，最后在一次数据库事务中替换引用；任何漂移、敏感内容或缺失正文都会拒绝迁移。逻辑过期、撤销和冲突保留在 SQLite 历史中；物理清理和历史合并必须另行显式执行。

## 非目标

本决策不强制向量数据库、不把 Markdown 直接当执行指令，也不自动删除或合并用户内容。向量检索和外部存储只能作为经过评测的适配器。
