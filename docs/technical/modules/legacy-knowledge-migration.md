# 历史知识迁移：只读来源、候选导入与可撤回发布

历史 `kefu_llm_wiki` 不是 Craft 的全局强制入口，也不是运行时 Knowledge Source。它只作为一次性离线命令 `scripts/import-legacy-knowledge.ts` 的输入；导入完成后 Craft、MCP、Host 和 Studio 不再读取该目录。`data/drafts/**`、聊天、旧 MCP、Skill Gate、SQLite/FTS 索引和原始正文均不迁移。

```text
只读发现（路径、frontmatter、摘要、页 digest）
  -> KnowledgeSource（bounded + proposal_only，offline 快照 digest）
  -> Evidence（unverified）+ Knowledge Claim（candidate）
  -> 独立 Claim review
  -> Evidence Wiki revision + bounded Memory Ledger
  -> retract: disputed Claim + revoked Ledger + retraction revision
```

发现记录仅保存来源根、正式页相对路径、前端字段允许集、来源摘要和 digest。正文从不写入 Craft Store；命中凭据模式、个人/会议/汇报类标记、非 confirmed 页、缺少 Evidence/reuse 元数据、异常分类或超限文件都会以 content-free 失败码排除。

命令支持 `--dry-run`、`--source-root`、`--data-root` 和 `--migration-id`。正式运行会先备份 `craft.db`，再显式选择发现清单中的路径，并在写入前重新读取页面、核验 digest 和敏感边界；漂移、删除或重新变敏感都会失败关闭。它对同一迁移/页面 digest 幂等，对相同标题+类型+项目+分类的现有候选记为 `duplicate`，不自动创建第二个 Claim。每个可导入项创建 `unverified` Evidence 与 `candidate` Claim，旧系统的 confirmed 状态不等同于 Craft reviewed/confirmed。旧迁移 MCP 工具已从组件 surface 移除，服务方法仅接受 `offline: true`，防止重新形成运行时依赖。

发布必须先由独立操作者把 Claim 审核为 `reviewed`。发布生成仅含摘要、来源相对路径和 digest 的 Evidence Wiki 页，并创建带 Evidence 的 `bounded` Memory Ledger；不会授予执行权。撤回要求明确理由：Claim 变为 `disputed`，Ledger 变为 `revoked`，Wiki 页产生不含原文的撤回修订。`craft_legacy_knowledge_migration_failure_report` 只返回失败码及摘要，不返回页面内容或敏感片段。
