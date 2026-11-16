# 议题跟踪：本地 Markdown

议题和规格以 Markdown 文件形式保存在本仓库 `.scratch/` 目录中。

## 约定

- 每个功能一个目录：`.scratch/<feature-slug>/`
- 规格文件：`.scratch/<feature-slug>/spec.md`
- 实现议题每个一个文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，编号从 `01` 开始，不用合并文件
- 分流状态写在每个议题文件顶部附近的一行 `Status:`（标签见 `triage-labels.md`）
- 评论和对话历史追加到文件底部 `## Comments` 标题下

## 当技能要求"发布到议题跟踪系统"时

在 `.scratch/<feature-slug>/` 下创建新文件（自动创建目录）。

## 当技能要求"读取相关议题"时

读取被引用路径的文件。用户通常会直接传路径或议题编号。

## Wayfinder 操作

`/wayfinder` 使用。**Map** 是一个文件，每个议题对应一个 **child** 文件。

- **Map**: `.scratch/<effort>/map.md`（Notes / Decisions-so-far / Fog 正文）
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`，编号从 `01` 开始，问题写在正文中。`Type:` 行记录类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`
- **Blocking**: 顶部写 `Blocked by: NN, NN`。当列出的每个文件都是 `resolved` 时该议题解除阻塞
- **Frontier**: 扫描 `.scratch/<effort>/issues/` 中开放、未阻塞、未认领的文件；编号最小的优先
- **Claim**: 设 `Status: claimed` 并保存后才开始工作
- **Resolve**: 在 `## Answer` 标题下追加答案，设 `Status: resolved`，然后在 map 的 Decisions-so-far 中追加上下文指针（摘要 + 链接）
