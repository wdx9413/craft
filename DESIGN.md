# Craft 核心设计边界

Workbench 页面、Tauri 桌面壳与原界面设计稿已于 2026-10-08 拆到同级 `craft-workbench/`。

核心包含 Runtime、Skill/MCP 接口、四个子能力与受鉴权保护的本地 HTTP API。`craft serve` 默认不提供页面；可选展示适配器通过显式目录挂载页面，核心不得依赖同级 UI 项目完成构建、测试或发布。

原页面设计稿保存在 `craft-workbench/DESIGN.md`；迁移和启动约定见 [展示层拆分说明](docs/technical/modules/presentation-separation.md)。
