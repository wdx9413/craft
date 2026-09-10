# Wiki Candidate Publication Package

> 状态：v0.11.36 已实现。它是跨宿主治理插件层的可审阅交付边界；不是自动安装器、文件写入器或执行器。

评测通过并得到人工发布授权的 Wiki Skill / Workflow 候选，之前只停在一条授权记录。v0.11.36 增加了可复核的 `wiki_candidate_publication_package`：它把一次**可人工导入**的交付固定为精确候选版本、Claim/Evidence 引用、无泄漏知识评测、held-out Evaluation、Signoff、授权记录和内容摘要。

## 准备条件与失败关闭

`craft_wiki_skill_candidate_publication_package_prepare` 必须引用处于 `publication_authorized` 的候选及其精确授权。每次准备都重新验证：

- 候选的 Claim 版本仍准确、已审核且每条 Evidence 仍存在；
- Knowledge Evaluation 仍为 `eligible` 且 `candidate_leaks = 0`；
- held-out Evaluation Run 与 Signoff 仍指向候选的精确版本并通过；
- 人工授权的 Candidate identity digest、`publication_allowed` 和非执行属性未漂移；
- 目标宿主与候选类型相容。

Skill 候选当前可面向 `codex-cli`、`claude-code`、`deepseek-harness` 或 `generic-mcp` 准备；Workflow 候选只面向 `craft-workflow`。目标名只是受支持的交付语义，不宣称 Craft 已替用户安装到这些宿主。

## 输出与边界

包使用 `craft.portable-skill.v1` 或 `craft.portable-workflow.v1` 格式，包含标题、适用条件、指令、回退条件、Claim 版本引用和 `content_digest`。Workbench 投影包的状态和摘要；`get` 工具返回可供人工审阅与导入的 Markdown 内容。

包始终带有 `manual_import_required: true` 和 `execution_authority: false`：

```text
知识质量 → held-out 行为评测 → Signoff → 人工发布授权
  → 可审阅的跨宿主包 → 人工导入 / 未来受治理发布 Adapter
```

因此，复制、安装、启用、工具授权和执行仍须由人或未来独立 Adapter 完成。后续 Adapter 必须把导入目标、写入摘要、宿主兼容性和安装回执重新绑定到此 Package；不能只因为 Package 存在就假装宿主已安装或安全可执行。
