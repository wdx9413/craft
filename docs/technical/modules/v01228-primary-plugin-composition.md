# v0.12.28 完整主插件组合

## 产品边界

`craft` 是默认安装入口，包含 Core、Knowledge、Memory、Capability discovery、Skill Quality 和 Workflow Evolution。它们共用同一份 Craft 数据、策略、证据与评测账本；安装主插件不需要再安装任何 `craft-*` 子插件。

子插件不是主插件的依赖，而是同一运行时的单域投影：当用户只希望给已有 Host 增加知识、记忆、能力发现、Skill 评测或 Workflow 演进之一时，可单独安装相应组件。通常应当与主插件二选一，避免给同一个 Host 安装重复工具面。

## 为什么不是把所有操作直接暴露出来

完整运行时包含数百个底层操作。若主插件为每个操作都注册一个 MCP Tool，模型必须在每一轮同时理解全部 Schema，工具选择准确率、时延和上下文成本都会下降。

因此主插件使用固定的 syscall 词表：

1. `craft_describe` 先返回某个资源/操作的精确参数、effect、风险和审批要求。
2. `craft_list`、`craft_get`、`craft_search` 读取相应资源。
3. `craft_create`、`craft_update`、`craft_run`、`craft_cancel` 在 Policy 允许的前提下调用该资源操作。
4. 路由、任务检查点、证据记录与 `craft_knowledge_bootstrap_install` 保留为少量直接入口，保障普通任务的最短路径。

这让 `memory_ledger.remember`、`knowledge_source.register`、`capability.search`、`evaluation_run.record` 与 `workflow_evolution.observe` 都能由主插件按需访问，同时默认工具数保持为 16。

首次使用 `craft_knowledge_bootstrap_install` 会幂等登记内置 Craft Evidence Wiki 与受限 Serena 描述符。它不扫描外部文件、不导入聊天、更不自动生成长期记忆；写入知识和记忆仍须通过各自的证据、范围与敏感性校验。

## 安全与兼容

- syscall 只重索引现有受治理操作，不复制第二套业务实现。
- 每次调用仍使用原操作的输入校验、Policy、effect、审批与 Receipt 规则。
- 不认识的资源或操作失败关闭；不能借由 syscall 绕过权限。
- `memory_ledger.remember` 和 `memory_ledger.transition` 被纳入正式操作词表，避免退化成不透明资源名。
- `craft-mcp-full` 仍是显式兼容入口，供需要旧有直接工具名的管理场景使用。

## 验证

测试固定验证主 syscall 面能初始化内置知识来源、描述并到达五个内置领域，MCP bundle 启动后仍只暴露 16 个工具，且主插件、各独立组件和 full 面均完成 `initialize` / `tools/list` smoke。
