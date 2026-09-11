# Craft

> 当前发布版本：v0.11.51。新增 Verified Work Loop 将任务契约、状态再观察、验收、恢复和评测 Campaign 收束为一条受控主链；Serena 项目记忆只按需、只读接入。

[中文](README.md) | [English](README.en.md)

## 简版产品介绍

Craft 的产品目标是一个人和 AI 共同工作的数字工作台：理解目标、组织能力、执行任务、维护成果，并从经过验证的工作中积累经验。

产品面向视频、销售、教育、内容创作、研发等各行业工作者。你可以提出目标、组织资料与工具、一起完成和修改成果，并把有效方法留作下次使用；专业对象和界面由领域扩展提供，不要求所有用户采用编程工作方式。

产品路线分两步：**短期做跨宿主治理插件层**——以 MCP/插件形式接入 Codex CLI、Claude Code、DeepSeek Harness 等宿主，提供统一的能力发现、授权门禁、证据链与评测门禁，执行仍发生在宿主内，Craft 只治理不越权；**长期做自主 Agent 平台**——由 Craft 直接承载对话循环、调度宿主并依靠评测门禁自我改进。两个阶段共用同一套内核。

当前版本提供的是 TypeScript/Node.js CLI、插件内核、本地维护 Worker、回环 Workbench 和本地 Supervisor。能力目录可以作为多个 Source Mount 保留；相同内容的镜像只形成一个逻辑能力供检索选择，同时保留所有来源、实际选中的实例和优先级。同一声明身份而内容不同的能力会形成显式冲突，绝不静默覆盖。Activation Plan 与 Resolution 会固定、复核并有界加载只读能力内容；新的跨宿主 Dispatch 可把这份内容精确绑定给 Codex CLI、Claude Code 或 DeepSeek Harness，并在执行前再次检查上下文摘要，变化即失败关闭。它不会自动执行本地 Skill，也不会增加工具或写入权限。验证驱动迭代控制器把独立验收结果分类为通过、有限重试、环境/配置阻塞或人工交接；它不把 Agent 自述当作验收，也不自动扩大写入权限。任务图可按依赖组织探索、制作、验证、复核和交付节点，但不替代现有 Runtime 自动派发 Agent。

Sandbox 能力采用“声明、诊断、黑盒一致性验证、精确版本票据、观察回执”协议，可由本地进程、容器或远程执行平台实现。当前仓库提供有限本地适配和首个 Docker CLI 驱动：普通 Probe 不授予可信状态；只有禁网、只读根、Workspace 可写、环境无常见 Secret、超时取消和无残留容器全部通过，Profile 才能成为 `verified`。是否安装 Docker、Daemon 安全配置与各平台内核隔离仍由部署方验收，不能把一致性测试解释为完整安全认证。

| 产品支柱 | 核心能力（目标） |
| --- | --- |
| 工作与协作 | 理解目标、共享工作空间、可编辑成果、能力与上下文 |
| 执行与保障 | 规划调度、工具连接、沙箱与权限、暂停恢复、验证与观察 |
| 学习与改进 | **评测与实验**、记忆与知识、学习适应、编译与复用 |

完整范围与实施状态见 [产品架构](docs/product/architecture.zh-CN.md) 和 [路线](docs/product/roadmap.zh-CN.md)。

## 核心理念

- 发现而不是全量注入：只索引用户选择的能力目录，先用元数据和文本检索返回少量候选，需要时再读取完整内容。即使能力库很大，也不会把全部 Skill 塞进模型上下文。
- 长任务可以恢复：目标、进度、待办、决策、反馈、产物和证据保存在用户目录，换 Agent 或换会话仍能继续。
- 验证方式显式化：程序、模型、人工和业务结果使用不同 Grader；Signoff Policy 决定一个精确版本是否达到复用标准。
- Workflow 来自真实使用：用户可把成功路径保存为版本化模板，再经过回放和评测逐步提升，而不是依赖平台预置全部行业流程。
- 数据属于用户：默认写入 `~/.craft_data`，不污染业务项目。API Key 只保存环境变量名，不保存密钥值。
- 可修改、可掌控：目标体验包括局部编辑、版本对比与执行控制；沙箱按实际后端能力提供保证，文件恢复与外部操作补偿分别处理。

## 当前版本已经实现

- 多能力目录管理、真实路径解析、目录引用/符号链接处理和增量扫描。
- Skill frontmatter 解析、SQLite 关键词候选检索和按需读取；搜索结果不携带完整正文。当前 Node 无 FTS5 时使用持久化内容的关键词排序降级。
- 可选 OpenAI-compatible Embeddings 混合检索：未配置时零网络请求；已配置时只索引 Skill 名称、描述和别名，并在调用成功后与关键词结果融合。超时、鉴权、响应格式或维度异常会自动降级为关键词结果。
- 持久化任务、Checkpoint、显式反馈、Artifact 与 Evidence。
- 版本化 Workflow、输入替换、路径边界、敏感信息脱敏和副作用授权。
- 确定性命令、文件/JSON 断言、覆盖率门禁，以及结构化执行回执。
- 版本化评测集与 Agent Profile 基础数据模型。
- 六维 Harness Configuration、不可变 Trial/Outcome、只追加 Trace、Workflow 自动取证闭环，以及 held-out Eval 驱动的晋级与回滚。
- Orchestration Trial 自动归档：锁定 Agent Profile 精确版本，记录 Dispatch、重路由、节点结果、成本和证据，并在终态自动生成 Outcome。
- 版本化 Grader、多来源 Grade 和 Signoff Policy；模型判断不会被记录成程序证明。
- 同评测集版本对比：在 Suite 精确版本、分区、Subject 类型和 Case 集合一致时，聚合比较 Workflow、Agent Profile 或 Harness Configuration 的质量、成本、耗时与失败类型。
- 经验模式与 Skill 候选：从多个 Trial、Outcome 与 Evidence 引用提炼适用条件、成功策略和失败模式；候选复用现有 held-out Eval/Signoff Gate，只有已验证版本才可在显式授权、摘要校验和本地备份保护下写入既有 `SKILL.md`，且可安全回滚。
- 默认编排入口：复杂目标自动优先选择相关的 `verified` Workflow；无匹配时创建可续接的安全 Host 路线。项目可启用 Policy，将每阶段的 Git 基线、测试、覆盖率和 Review 回执变成服务端门禁；Host Adapter 只领取声明支持的下一安全动作。
- 安全增量研发 Kit：固定“Git 基线与原逻辑测试 → 最小改动 → 测试/覆盖率 → Diff 审查”的顺序，要求每个结论附带命令或产物证据。
- 可恢复基础编排：Lease 有 TTL 和续租；显式幂等键可安全重试提交；声明的预算耗尽后会阻断未开始节点，同时保留已发生的成本。
- 持久恢复队列：有界扫描到期等待、未知 Effect/补偿和失败 Saga，生成稳定的优先级工作项；跨平台 Worker 按能力短租领取，过期自动回收，完成回执必须通过来源状态和 Evidence 校验。
- 授权主动触发：签名 Webhook Subscription 提供 HMAC 验签、重放防御、确定性过滤、节流、白名单字段投影和资源预算预留；原始请求体不落库，投影数据没有执行权限。
- 受控投机准备：授权事件可以生成固定输入摘要、预算和 TTL 的索引、总结、草稿或元数据候选；Worker 使用短 Lease，成果必须带 Artifact 与 Evidence。候选全程自动记录 Trial、Trace、实际成本和 Outcome，人工修改沉淀为偏好信号，但不会冒充程序证明、直接晋级或自动执行外部写操作。
- 对象级成果血缘：用精确版本连接 Source、Output、Workflow/Capability 转换器和 Evidence，支持段落、单元格、镜头等 Locator、上下游影响追溯、环检测及新版本陈旧提示，不复制业务正文。
- 长任务冻结与恢复：把 Task、Workspace 修订、Wait、Runtime 指纹、预算和恢复项固定为不含原始对话及凭据的最小 Snapshot；恢复前区分继续等待、直接续接或重新规划，并用短 Lease 和 Evidence 防止并发或虚假恢复。
- 分级自主权：按动作配置自动、仅通知、单人审批或多人联签；授权绑定精确任务、目标、请求摘要和有效期，并且只能消费一次。
- 统一 Host 门禁：External Effect、Runtime Adapter 与 Computer Use Operation 在派发时原子消费授权；子任务也携带自己的稳定动作身份。
- 动态契约推导：用多次脱敏观测形成 API、MCP 或 GUI Contract 候选，经过人工修订、沙箱证明和证据 Trial 后才成为 verified；版本 Diff 识别 breaking change，独立批准后才能发布 Capability Adapter，并可按精确版本安全撤回。
- 能力灰度：对新旧 Capability 做稳定双臂分流，达到最小样本后比较失败、成本、时延和人工修正，退化时停止候选流量并给出回滚建议。
- 能力共享：把已验证 Capability 变成可人工审查和脱敏的版本化能力包，供个人、团队或组织精确订阅，并支持发布方统一撤销。
- Hub 增量目录：通过固定 Ed25519 公钥验证分页目录，以单调游标和前页摘要阻止丢页及分叉；查询只走本地元数据索引，不扫描一万个远程 Skill。
- 按需能力落地：只在选中候选后按目录摘要接收有限文件，写入 `~/.craft_data/cache` 隔离区；路径、体积、原生二进制、疑似凭据和 lifecycle scripts 经过门禁及人工审查，最终只登记成待评测 candidate。
- 候选能力认证：精确绑定 held-out Evaluation、每个 Trial 的 Sandbox Receipt、Evidence、program Grade 与 Signoff；只有无漂移且由独立角色批准的版本才能原子晋级 verified，认证本身不授予执行权。
- 持续供应链治理：来源停用、条目撤回、摘要漂移或高危安全公告会原子阻断认证资产、使精确 Activation Profile 失效，并投影可恢复的再认证工作。
- 本地维护 Worker：以单实例前台进程或一次性 Tick 回收过期 Lease、清理过期候选、复核 Hub 供应链并刷新 Recovery Queue；只维护控制面，不擅自执行用户任务。
- MCP 服务，以及 Codex、Claude Code、DeepSeek Harness 和通用 MCP Host 接入。
- Delivery Control Loop：Host/验收事实自动投影为 deliver、collect acceptance、retry-or-handoff 或 human-handoff；批量比较仅建议进入 Signoff，绝不自动发布或执行。
- Task Control：将任务、工作目录、允许 effect、验收要求和可选能力/预算版本固定为不可变 Contract；一个兼容 Launch 的所有实际事实被收敛成一个下一安全动作，可生成不含 Prompt 的恢复交接。
- Task Run / Benchmark：Task Run 固定一次 Host 工作的版本和摘要，在漂移时停止重规划；Benchmark 只比较已观察交付，同环境/预算的 held-out 结果才能生成不可自动发布的候选。
- Verified Work Loop / State Workspace / Eval Campaign：Host 自述完成不等于交付；文件状态、人工修改、环境与预算漂移均形成可追溯事实并要求重规划。Campaign 以真实 Outcome 比较最小 Harness 与有限候选，不默认增加多 Agent。Serena 仅作为受信任项目的按需只读上下文，Craft 只提出更新建议、绝不自动改写其记忆。
- Windows、macOS、Linux 共用 TypeScript/Node.js 运行时；不依赖 Python。

v0.9.10–v0.10.2 还提供声明范围内的文件快照、本地事务记录、受限 TypeScript 脚本候选和 Host 执行交接。v0.10.0 新增共享结构化工作对象；v0.10.1 用字段级 ChangeSet 阻止同字段覆盖；v0.10.2 新增持久等待、幂等资源结算、Fallback Contract 与 Effect/Saga Kernel。外部写入预声明请求、幂等键、审批和可选补偿；未知结果可先通过预授权只读 GET 对账，未映射状态仍需人工消歧。补偿 Adapter 只执行精确授权且预先冻结解释契约，网络模糊保持未知，补偿失败不会伪装成回滚成功。候选操作尚不是自动从原始轨迹提炼程序；平台与安全缺口见 [执行策略](docs/technical/modules/execution-policy.md)。

向量检索不是必需依赖。短期本地库优先使用零配置检索；需要时可显式配置兼容 OpenAI Embeddings 协议的服务，并与关键词结果融合。

## 安装

要求 Node.js 23 或更高版本。用户不需要安装 Python。

从 GitHub 安装 CLI：

```bash
npm install -g github:wdx9413/craft
craft init
craft semantic configure --provider-name local --base-url https://embedding.example/v1 --model text-embedding --api-key-env EMBEDDING_API_KEY
```

开发者使用 pnpm：

```bash
git clone https://github.com/wdx9413/craft.git
cd craft
pnpm install --frozen-lockfile
pnpm test
```

## 三种使用方式

1. Provider（当前主线，跨宿主治理插件层）：Craft 通过 MCP/插件接入 Codex CLI、Claude Code、DeepSeek Harness 等宿主，提供能力发现、任务延续、Workflow、证据、授权与评测门禁；执行仍发生在宿主内，Craft 只治理、不越权。
2. Supervisor（规划形态）：未来由 Craft 调度 Codex、Claude Code 或其他 Host；当前版本已有可并发领取、依赖阻断和失败换路的编排状态机与 Host Run 生命周期，但还没有自动通用 Host Driver。
3. Agent（规划形态）：未来由 Craft 直接承载对话和模型工具循环；当前版本只提供配置与持久化底座，尚不能替代 Codex 或 Claude Code。

三者共用同一内核，Provider 阶段积累的授权、证据与评测数据是后续自主化的基础。

首次运行 `craft init` 目前仍会选择模式。规划中的普通用户入口将从目标和资料开始，把技术模式移到高级设置，此引导尚未改造。配置、SQLite 数据库、索引、日志和备份都位于 `~/.craft_data`；也可用 `CRAFT_DATA_DIR` 指定另一目录。

## 接入 Codex

在 Codex 插件市场添加 Git 来源：

- 仓库：`https://github.com/wdx9413/craft`
- 分支/Tag：建议固定发布 Tag；开发时可用 `main`
- 稀疏路径：`.`（插件清单位于仓库根目录）

插件会读取根目录的 `.codex-plugin/plugin.json` 和 `.mcp.json`。也可以只把 `skills/craft` 作为普通 Skill 安装，但这样不会自动获得 MCP 数据层。

从 v0.2.1 起，插件 MCP 使用仓库内随版本发布的单文件 bundle；Codex 把插件复制到缓存目录后无需再执行 `npm install`，也不会依赖源码仓库的 `node_modules`。升级旧版本后请重新安装插件，并在新会话中验证 `craft_info`。

## 接入 Claude Code

仓库根目录包含 `.claude-plugin/plugin.json`。把该 Git 仓库作为插件源安装；如果宿主只支持 MCP，则使用下方通用配置。

## 通用 MCP

全局安装后，MCP Host 的配置为：

```json
{
  "mcpServers": {
    "craft": { "command": "craft-mcp", "args": [] }
  }
}
```

当前工具使用 `craft_` 前缀，例如 `craft_source_add`、`craft_capability_search`、`craft_task_checkpoint`、`craft_workflow_trial_run`、`craft_evaluation_run_aggregate` 和 `craft_evaluation_compare`，避免与宿主或其他 MCP 冲突。

v0.9.9 的默认 `craft-mcp` 是精简核心面：路由、能力检索、Task/Evidence、Activation Profile、已签发调用和状态查询，避免把全部工具同时塞进模型上下文。历史集成可显式改用 `craft-mcp-full`，它保留全部旧 `craft_*` 工具。Craft 只生成 Activation Profile 与 profile-bound、会过期的 `call_id`；Host 决定是否实际启停 MCP Server，不能通过通用入口绕过 Policy。

执行按风险分级：普通读取和规划可由 Host 执行；策略要求部分本地生成代码写入使用隔离适配；外部写入需审批，缺少补偿或受信任凭据条件的相关请求被阻断。策略决定不等于后端已经安全隔离：当前文件访问限制、环境凭据清洗、资源/进程控制和 Windows 等价后端仍待补齐，详见 [沙箱边界](docs/technical/modules/execution-policy.md)。

日常由 Craft Skill 自动走高层入口：对复杂目标先调用 `craft_default_route`，无需用户重复“优先已验证 Workflow”等编排话术。它会创建 Task、优先选中匹配的已验证 Workflow，并返回少量候选能力；只有返回 `next_action.kind=execute_verified_workflow` 时，才使用 `craft_default_route_execute` 运行该精确版本并自动归档 Trial/Trace/Outcome。无匹配时默认返回安全增量研发计划；严格项目先用 `craft_project_policy_save` 固化回执要求，Host 在每阶段通过 `craft_route_receipt_record` 写入真实命令结果后，才能用 `craft_default_route_update` 推进。`craft_host_adapter_dispatch` 只把下一安全动作交给已声明支持它的 Adapter。跨会话可直接说“继续上次的 X”：`craft_default_route_find` 只恢复唯一活动路线，并列时绝不猜测；已知 `task_id` 才使用 `craft_default_route_resume`。同一策略只有积累两条不同 Task 的通过路线、且 Evidence 至少为 confirmed/bounded 后，才可生成一个带溯源的 `draft` Workflow，仍必须通过既有评测门禁。短问答和一次性读取不创建 Craft 路线。

## 数据目录

```text
~/.craft_data/
├─ config/config.json       # 模式、Host 与模型端点配置
├─ db/craft.db              # 任务、Workflow、证据、评测等版本化数据
├─ index/                   # 可重建的能力索引
├─ logs/                    # 脱敏日志
├─ backups/                 # 备份
├─ cache/                   # 可删除缓存
└─ runtime/                 # 临时运行状态
```

Craft 只索引能力来源，不移动或修改来源文件。删除 Source 只删除本地索引记录。

## 验证

```bash
pnpm run typecheck
pnpm test
```

测试命令同时强制行、函数和分支覆盖率为 100%。覆盖率是测试工具确定性计算的结果，不由模型自报。

用 `craft semantic status` 查看当前状态；`craft semantic disable` 会立即回到纯关键词检索。配置只保存端点、模型和环境变量名，不保存 API Key。MCP 也提供只读的 `craft_semantic_status`；`craft_capability_search` 和默认路由会在语义服务就绪时自动使用混合检索。

产品定义、路线和模块化技术方案见 [Craft 文档中心](docs/README.md)；当前实现边界见 [中文架构说明](docs/architecture.zh-CN.md)。
