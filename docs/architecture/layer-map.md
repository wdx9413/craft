# Craft 分层与目录地图

本文记录当前代码的职责边界，不改变版本号或运行时协议。目录按“入口 → 应用 → 领域 → 基础设施”理解；历史导入路径仍由根目录兼容导出保留。

```text
interfaces/                 外部协议入口
  mcp-server.ts             MCP 工具定义、分发与错误映射
  mcp/tool-schema.ts        工具参数 Schema 与只读标注
  mcp/surface-registry.ts   Domain / Component / Syscall surface 投影
application/                用例与应用门面
  craft-service.ts          CraftService 兼容门面与跨域编排
  use-cases/                按领域安装的用例组（Adapter、Trace、Knowledge、Memory 等）
domains/                    稳定业务内核（按命名空间分组）
  index.ts                  controlPlane / execution / evidence / knowledge / integration
infrastructure/             持久化、路径和运行环境
  index.ts                  CraftStore / CraftPaths 入口
根 src/*.ts                 现有领域内核；逐步迁移时保持兼容导入
```

## 依赖规则

- `interfaces` 只依赖 `application` 和共享类型，不直接拼接数据库或执行外部副作用。
- `application` 负责用例编排、权限和交付门，不承载协议格式细节。
- `domains` 保存可测试的策略和状态转移；同一领域内核不通过 MCP 互相调用。
- `infrastructure` 提供存储、路径、进程和平台适配；领域代码通过明确接口使用它。
- Trace/Evidence 是横切事实链：动作、工具、验收和结果必须带同一关联标识。

## 兼容与拆分策略

`src/service.ts` 与 `src/mcp.ts` 现在是稳定的薄兼容入口，真实实现分别位于 `src/application/craft-service.ts` 和 `src/interfaces/mcp-server.ts`。第三方继续使用旧路径不会失效；后续新增代码应从分层入口或具体领域模块导入，避免再把门面做成新的上帝模块。

这次只做结构收敛，没有删除历史版本测试或改变公开工具名。大型实现文件仍会按领域边界渐进拆分，每次拆分都通过类型检查、完整测试和适配器 smoke test 验证。MCP 的工具 Schema 与 Surface Registry 已从协议服务器中抽出；后续再按领域抽取 Handler，但仍由同一个兼容分发入口承接。

## Memory / Knowledge 的分发决策

Memory 和 Knowledge 的真实能力以 MCP component surface 为协议真相：`component-memory` 与 `component-knowledge` 可以被 Codex、Claude、WorkBuddy、Trae 或独立 CLI 直接接入。插件不是另一套实现，而是宿主分发外壳，负责 Skill、图标、默认提示、权限和安装元数据。

因此保留两种形态，但职责不同：

- 只需要调用能力时，优先使用 MCP，适配成本最低、跨宿主最好。
- 需要宿主内的路由提示、渐进式上下文和可见入口时，再用薄插件包装同一个 MCP surface。
- `craft-memory`、`craft-knowledge` 可以独立安装；完整 `craft` 作为组合插件提供完整 MCP，不复制子插件代码，也不强制所有宿主安装一堆组件。

这避免把每个能力同时实现成多套插件协议。未来新增宿主只需做一个薄包装器，核心能力和安全边界仍由同一份 MCP/Service 实现提供。
