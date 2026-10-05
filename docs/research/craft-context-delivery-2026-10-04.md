# Craft Context 与五产品接入交付

日期：2026-10-04。范围：在既有四子能力及 Workflow/Graph 实现上，完成默认聚合入口、仓库自动索引和各产品的四种接入。当前是本地 0.12.37 工作树及分发产物，没有发布新版本或替换用户已安装缓存。

## 已实现

| 验收条件 | 实现与验证 |
| --- | --- |
| 默认包含四能力，仍可独立使用 | ReleaseCatalog 新增 craft-context；聚合工具面按名称去重，四个独立产品保留；独立安装器默认选择 context |
| 不要求逐仓库激活 | craft_context_open / craft_codebase_repository_ensure 从当前目录识别 Git 根目录并自动建立或复用索引；真实 Git 仓库、子目录、worktree 测试通过 |
| 更新和复用有一致性 | 基础分析按文件 digest 持久复用；修改和删除产生新 checkpoint；不同 worktree 隔离、同目录跨宿主复用；两个真实 MCP 进程共享空数据目录的冷启动通过 |
| 按需提供代码结构 | 默认基础文件/声明索引；semantic 请求复用 TS/JS checker；现有 Python/LSP 导入通路保留；不把基础声明推断成调用关系 |
| 聚合有预算和来源 | K/M/E 共用排名、去重和条数/字符预算，代码引用使用剩余预算；pack_receipt 固定来源 receipt、checkpoint 和 index；单组件失败明确降级 |
| 五产品各有四套接入 | Codex、Claude、独立 Skill + MCP、dsh 原生目录与 ZIP 都已生成；共 20 种产品/接入组合进行了真实本地 MCP 握手与调用 |
| 不依赖 Hook | Context 与独立安装器路径没有 Hook 依赖；子能力既有 Hook 保留为可选；DSH 自带 MCP bundle、协议协商与 Skill，离线调用不下载临时 npm 包 |
| 远程只交付可部署配置 | HTTPS 模板支持五产品，认证和租户路由验收通过；包含仓库读取的 Context/Codebase 强制每部署一个共同信任租户，不用数据库分目录冒充文件系统隔离 |

新接口与配置详见 [Craft Context 使用说明](../technical/modules/craft-context.md)，远程部署要求见 [部署说明](../../deploy/components/README.md)。

分发入口：源码仓库 `plugins/craft-*/`；同级 `craft-marketplace` 同步市场产物；同级 `craft-common-use` 提供独立安装器。DSH 可安装产品目录下的 `dsh/`，也可使用 `dist/craft-*-dsh-v0.12.37.zip`。通用安装器支持的更多宿主继续复用标准 Skill + MCP。

## 验证证据

- 70 项相关运行时回归通过；随后对新增 DSH 超时分支单独补验并合并覆盖率。
- 108 项共享上下文解析相关回归通过，context-resolution 全文件行、分支和函数覆盖率均为 100%。
- 6 个新增运行时模块的行、分支和函数覆盖率均为 100%；按本轮前快照计算的 16 个核心运行时文件增量语句 279/279、分支 227/227。这个数字不代表整个仓库或分发脚本的覆盖率。
- 5 产品 × 4 接入形式的本地产物矩阵通过；四子能力额外完成 74 次 stdio 业务调用，绑定最终 bundle SHA-256。
- 6 项 HTTPS/认证/租户隔离回归通过，含远程 craft_context_open。部署模板行和分支覆盖率 100%，整文件函数覆盖率 90.91%：必经 principal 路由使原有兜底拒绝 handler 不可达，因此未声称整模板函数门禁通过。
- TypeScript 类型检查、构建输出、架构分层、工具面、产品目录、包完整性和版本一致性检查通过。
- 市场五产品已与源码产物同步并校验；独立安装器五产品摘要校验及 7 项 portability 回归通过。三个仓库源码 diff 检查通过；生成 bundle 中保留了 TypeScript 许可证的空白行，完整生成物 diff 检查会报告这些行末空格。

机器可读证据见 [验收记录](evidence/craft-context-delivery-2026-10-04.json)。各测试组存在交叉，不将这些数量累加成唯一测试总数。

## 使用与验收边界

自动索引由宿主遵循 Skill、在进入仓库任务时调用入口触发；MCP 协议本身不能强制每轮回调。没有每个项目的人工激活步骤，也不会扫描用户所有项目目录。基础自动索引有文件数、体积和节点预算，超额明确标为部分覆盖；大仓库可通过高级 Workspace 接口缩小范围，完整大仓分片与编译器依赖增量仍不在本轮实现范围内。

DSH 产物验收仅替换宿主的工具注册函数，实际 MCP 初始化、工具发现和业务调用使用真实内置运行时。这不等于真实 DSH 模型会话验收，Codex/Claude 也未用本轮新包完成宿主模型会话重验。

共享本地数据使用 Runtime 默认目录或显式 CRAFT_DATA_DIR。旧 portable 包的 PLUGIN_DATA 数据不自动迁移；通过既有 export/verify/import_plan/import_apply 流程迁移，避免静默覆盖。

远程尚未上线，真实 IdP、容器构建及目标宿主认证需部署环境验收。没有运行全仓全量测试，没有 commit/push，也没有把测试 fixture 结果自动写成用户知识、记忆或可推广 Experience。
