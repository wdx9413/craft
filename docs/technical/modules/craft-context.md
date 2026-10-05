# Craft Context 与跨宿主接入

`craft-context` 是默认聚合产品，组合 Knowledge、Memory、Experience 和 Codebase，复用同一个 Runtime。四个子能力仍可单独安装。Context 提供材料、来源与回执，实际动作仍由宿主执行；积累知识、修改记忆和启用流程沿用原有证据与状态规则。

## 默认任务入口

安装 Skill 与 MCP 后，Agent 在仓库任务开始时调用：

```json
{"project_root":"/path/to/current/repository-or-subdirectory","query":"review alpha changes","max_items":12,"max_chars":12000}
```

工具是 `craft_context_open`。它识别 Git 根目录、解析项目作用域、召回三类积累上下文，并自动建立或复用当前 worktree 的 Codebase 基础索引。没有用户逐项目激活步骤。多根任务对涉及的仓库各调用一次；不搜索用户其他项目。纯知识或规划任务可传 `include_codebase:false`，跳过索引准备和代码引用。

Codebase 单独安装时调用 `craft_codebase_repository_ensure`，只需 `project_root`。返回 `workspace_id`、`checkpoint_id`、`index_id`，可直接用于符号查询。再次进入仓库、修改文件或切换分支后重调该入口；未变化文件复用持久分析缓存，新增、修改和删除反映在新 checkpoint。不同 worktree 有不同本地索引身份；同一真实路径在不同宿主中复用索引。

基础层提取文件与常见声明，标记 `partial`，不制造调用关系。需要调用方或影响分析时，以 `index_depth: "semantic"` 请求现有 TS/JS checker。其他语言精确关系使用既有 Python/LSP 导入通路。语义分析在代码变化时可能需要重建跨文件关系，不宣称已经实现完整的编译器增量依赖分析。

Git ignore、默认生成目录排除、符号链接检查在读取源码之前执行；已跟踪文件也通过 `git check-ignore --no-index` 检查。新规则影响后续快照，不物理删除已存历史。基础入口每次最多选择 500 个源文件、单文件 512 KiB、总计 8 MiB；每文件最多 15 个声明，超额数量进入诊断，较大结果还有 1.5M 字符分析预算。索引可用状态不代表仓库分析完整。大仓库可以用高级 Workspace 接口指定分析范围。

自动入口同时校验 checkpoint、索引策略版本和索引实际 `ready` 状态；恢复旧 checkpoint 后创建绑定当前工作区修订的新索引，不能复活旧 `stale` 索引。基础解析缓存还校验 analyzer 版本，升级后不会只因正文摘要相同而沿用旧解析结果。

项目 `.craft-codebase.json` 支持：

```json
{"enabled":true,"exclude_paths":["generated","private"]}
```

`enabled:false` 或环境变量 `CRAFT_CODEBASE_AUTO_INDEX=0` 关闭自动索引。高级 `craft_codebase_deactivate` 的关闭状态也会被自动入口保留；恢复时对返回的 workspace 使用 `craft_codebase_activate` 和 `actor: "repository-auto"`。非 Git 目录返回 `skipped/not_repository`，仍可召回其项目上下文；需要分析非 Git 目录时使用显式 Workspace 接口。

## 聚合与回执

Knowledge、Memory 和 routeable Experience 共用排名、去重和条数/字符预算。Codebase 引用使用剩余预算；源码正文不注入上下文。返回的 `pack_receipt` 记录积累上下文 receipt、代码 checkpoint/index、选中引用和总预算。正文按完全相同内容去重，检索 tags 不参与去重键；保留必选 Memory。内层 receipt 的 `deduplicated_refs` 最多保存 100 组被省略/保留条目的来源引用与 digest，超额由 `deduplicated_refs_omitted_count` 显式记录。历史记忆版本仍能分别查看，不做近似语义合并。

聚合入口透传 `source_ids`、必选 `memory_ids`、已评估的 `retrieval_adapter_id`、`cognitive_purpose`、显式身份/作用域扩展、restricted/working-notes 控制和 `now`。远程身份由认证层绑定。Knowledge、Memory 派生材料同时受当前 Source 受众与租户约束；Memory 精确读取、列表、历史及维护也执行当前访问策略。必选材料不可用或放不下时仍失败，不能因允许部分结果而静默丢失。

候选先按作用域和访问策略筛选，再执行 10,000 条上限，其他项目的新数据不会挤掉本项目的旧候选。独立严格接口超过候选预算明确报错；聚合的可选成员失败可降级为 `partial`。当前 Store predicate 仍读取全表再过滤，这是正确性修复，不是 SQL 分页或大数据性能保证。

顶层和 `pack_receipt` 的 `partial`/`partial_reasons` 汇总成员失败、Codebase 不可用、基础分析不完整、遗漏文件、预算不足和符号查询截断。`codebase.budget_omitted_count` 与 `query_omitted_count` 区分引用被预算省略和查询本身截断；不同查询词的遗漏计数可能重叠，不代表精确的全仓漏检总数。条数/字符预算约束选中的材料，不是整个 MCP JSON 的精确 token 预算。

回执描述生成时的选择结果，不能替代当前授权。来源撤销、记忆更正、Procedure 门禁改变或代码变化后，应重新调用入口；本版未提供统一的只读回执重检 API。

同装聚合与单组件时，Skill 优先选择 `craft-context`，复用其本任务回执，组件 Skill 负责专题操作。每个 MCP 服务内工具名去重；宿主以服务/插件名区分不同服务。不会删除用户已安装的组件，也不通过工具名猜测它们共享数据库。

## 分发矩阵

下列五个产品各自提供四种接入：`craft-context`、`craft-knowledge`、`craft-memory`、`craft-experience`、`craft-codebase`。

| 方式 | 本地生成位置 | 调用方式 |
| --- | --- | --- |
| Codex 插件 | `plugins/<product>/.codex-plugin/plugin.json` | Skill + 本地 MCP；子能力既有 Hooks 为可选增强 |
| Claude 插件 | `plugins/<product>/.claude-plugin/plugin.json` | Skill + 本地 MCP；市场清单从产品目录生成 |
| 独立 Skill + MCP | `plugins/<product>/plugin.json` 与 `mcp.json`；同级 `craft-common-use` 安装器 | 默认 `--product context`，也可选各子能力，不安装 Hook |
| dsh 原生插件 | `plugins/<product>/dsh/`；`dist/<product>-dsh-v<version>.zip` | Cordis 插件，独立发现工具与调用工具，内置 MCP bundle 与 Skill |

DSH 原生插件安装已生成目录，例如 `dsh plugin --profile default add /absolute/path/plugins/craft-context/dsh`。`craft_context_tools` 返回真实工具 schema 和 Skill；`craft_context_call` 执行目标工具。其他产品用自己的 `craft_<member>_tools/call`，可以并装。初始化先完成协议协商，再请求工具；拒绝无效 JSON、协议失败、超时及超额输出。生产包优先使用内置运行时，不依赖临时下载 npm 包。

DSH 也能走通用安装器的 Skill + MCP 路径，通过已有 `dsh-mcp-client` loader 接入，此时直接使用原生 MCP 工具。

所有新配置沿用 Runtime 的默认 `~/.craft_data`（或 settings 的 dataRoot）；显式 `CRAFT_DATA_DIR` 优先。因此同一台机器默认复用数据，远程租户仍隔离。旧包曾设置 `${PLUGIN_DATA}/data` 的数据不会自动迁移；用原有 export/verify/import_plan/import_apply 迁移，避免静默覆盖。纯 MCP 本身无法保证每轮自动调用；无 Hook 行为由宿主加载并遵循 Skill 完成。

远程模板支持聚合与四组件，但仍只交付部署配置和验收脚本。远程 Codebase 的路径是服务器可访问的仓库路径，不会自动读取客户端电脑。包含仓库读取能力的 `context`/`codebase` 强制每个部署只服务一个共同信任的租户；不同租户需用隔离容器和各自的仓库挂载，不能仅靠数据库分目录隔离文件系统。

## 验证范围

`tests/repository-context.test.ts` 覆盖自动接入、缓存、变更/删除、worktree、忽略/退出、预算、去重与降级；`tests/dsh-product-adapter.test.ts` 覆盖协议交互和故障；`tests/context-distribution.test.ts` 从五产品四种产物执行真实本地 MCP 调用。DSH 测试替换的只有宿主注册函数，不把该测试称为真实 DSH 模型会话验收。
