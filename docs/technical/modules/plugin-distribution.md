# Codex 插件轻量分发

## 目标

源码仓库仍是 Craft 的唯一开发入口；Codex 市场只读取 `plugins/craft/`。该目录是一个受版本检查和 smoke test 保护的最小运行包：manifest、`craft-route` Skill、核心和 Full MCP 单文件 bundle。

这避免市场缓存复制源码、测试、适配器、桌面应用和 source map。`marketplace.json` 与 `.agents/plugins/marketplace.json` 都必须使用 `./plugins/craft`，不得退回根目录。

## 构建与发布

`pnpm run build` 先生成 MCP bundle，再执行 `pnpm run pack:plugin`：它精确复制当前的 route Skill 和两个 bundle。`pnpm run test:plugin` 会验证目录完整性、版本一致性、市场路径、Skill 内容一致性、根 `dist/` 未被 Git 跟踪，并在临时目录启动 MCP 完成握手。

桌面 `.app`、Windows ZIP、二进制、adapter ZIP、一般 CLI 编译产物和 source map 都不属于插件包。当前不构建也不发布这些平台安装资产；待桌面交付重新进入范围时，再建立独立的 GitHub Release 流水线。源码仓库继续忽略根 `dist/`，避免未来发布继续膨胀 Git 历史。

## 兼容边界

Codex 默认读取核心 MCP。`craft-mcp-full.cjs` 被一同带入是为了已批准的兼容入口，未在默认 manifest 中暴露。Claude、TraeWork 与 WorkBuddy 继续使用它们各自的适配元数据和构建产物，不会改变 Codex 市场的最小工具面。

已有 Git 历史中的大文件不会因一次普通提交自动缩小；如需物理移除旧对象，必须另行执行经团队确认的历史重写和强制推送。
