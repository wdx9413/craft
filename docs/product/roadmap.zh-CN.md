# Craft 产品路线

## 目录

- [建设原则](#建设原则)
- [下一阶段里程碑](#下一阶段里程碑)
- [当前版本重点](#当前版本重点)
- [真实任务验收](#真实任务验收)
- [当前实现基线](#当前实现基线)
- [版本演进记录](#版本演进记录)
- [后续领域扩展](#后续领域扩展)
- [长期验证](#长期验证)

## 建设原则

以 [产品架构](architecture.zh-CN.md) 的三大支柱为目标：工作与协作、执行与保障、学习与改进。**评测与实验是第三支柱内的核心模块**，不另设第四支柱。以下里程碑是规划；当前实现基线已推进到 v0.11.57。

**两步定位**：短期做**跨宿主治理插件层**——以 MCP/插件形式接入 Codex CLI、Claude Code、DeepSeek Harness 等宿主，统一能力发现、授权门禁、证据链与评测门禁，执行留在宿主内；长期做**自主 Agent 平台**——自有对话循环、宿主调度与评测驱动的自我改进。Provider 是当前主线，Supervisor/Agent 是长期形态；本路线图中 v0.11.x 的能力全部属于两步共用的内核。

**v0.11.20：逻辑能力索引。** Capability Source 是可重复登记的来源 Mount，不要求用户通过禁用目录来去重。相同挂载请求保持幂等；不同来源的同内容 Skill 由内容摘要归并为一个逻辑能力，搜索只返回按显式优先级选定的一个实例，同时保留所有来源。相同 `capability_id`（或名称）而内容不同会形成显式 Conflict，不静默覆盖。`craft_logical_capability_list` 可读取逻辑能力、来源实例、当前选中项与冲突。Workflow scope、Task Context Profile、Activation Profile 与生命周期 Integrity Audit 是下一阶段，当前不能宣称已实现。

**v0.11.21：版本化 Context Profile 与协作 Task Graph。** Profile 固定任务/工作空间范围、记忆类别、对象类型、必选材料和条目/字符预算；装配结果可说明材料来自何处，并在必选材料无效、越权或超预算时失败关闭。Task Graph 用通用的 explore / produce / verify / review / deliver 节点表达依赖与人工/模型共同推进的状态，节点可精确绑定 Profile 版本；它不是 Agent 调度器，不会自行运行模型、工具或外部动作。下一阶段才处理 Capability/Activation Profile 与这些 Profile 的统一、语义级上下文路由和运行时生命周期审计。

**v0.11.22：任务级逻辑能力 Activation Plan。** 搜索结果会被固定为能力内容摘要、优先来源和可选 Context Profile 版本；只允许作为只读上下文激活。审计可明确区分安全的同内容镜像重选、同声明身份的内容变化和完全缺失，避免在能力目录变化后静默沿用旧计划。它不是自动 Skill 执行器，也不会替代既有 Capability Asset 的信任或副作用治理。

**v0.11.23：加载前完整性校验与有界 Resolution。** 在向宿主交付本地 Skill 内容前，Craft 重新读取已选文件并核对 Activation Plan 的摘要；文件未经扫描已变化、计划已过期、内容超出预算或疑似含密钥都会失败关闭。成功 Resolution 返回给宿主的仅是受限只读内容，并留下不含正文的本地回执；这仍不是自动执行或对内容的安全背书。

**v0.11.24：Capability-bound Dispatch。** Codex CLI 与 Claude Code 的受控调度可精确引用 Activation Plan；Craft 在准备和执行前分别复核本地内容，调度上下文变化即失败关闭。该桥接只加入有界只读材料，不增加宿主工具、文件写入或外部动作权限。

**v0.11.25：验证驱动迭代控制器。** 一个已绑定的独立验收结果只能把任务导向通过、预算内重试、环境/验收配置阻塞或人工交接；每次判断留下脱敏反馈摘要和尝试记录。它不运行任意命令、不相信 Agent 自述，也不因为重试而增加任何写权限。

**v0.11.26：Capability-bound Work Launch。** Activation Plan 的内容摘要随 Work Launch 保存；针对 workspace-write，Craft 在人工批准启动前重新加载并比对摘要，文件漂移或上下文被篡改即失败关闭。该上下文仍只提供参考材料，不能改变 Host 权限。

**v0.11.27：证据驱动策略推荐。** 只从同一可比较 held-out Evaluation Comparison 的通过率、评测结论和可选成本指标生成 `recommended` 或 `insufficient` 建议；它不会自动更改路由、发布 Workflow 或启动执行。

**v0.11.28：跨领域验收 Kit。** 内置研发、视频、内容和销售交付 Kit。文件存在、格式和媒体事实可以程序校验；内容质量、事实判断、叙事审美和商业承诺显式保留给独立人工/模型/业务验收，避免把“文件存在”冒充为“业务完成”。

**v0.11.29：Evidence Wiki Kernel。** Wiki 页面以用户可直接阅读和编辑的 Markdown 文件保存；SQLite 仅维护摘要、版本、引用和审计索引。事实、规则、决策、术语和失败模式必须引用既有 Evidence 后才能作为 Candidate 入库；编辑型页面不自动取得可信度。Review、争议、替代和过期均为显式版本状态，关系图不授予能力或执行权限。

**v0.11.30：Context Compiler。** 只将已审核、未过期、范围匹配且可被确定性关键词命中的 Claim 编译到有界上下文；Bundle 记录版本引用、摘要、纳入与排除原因，不复制正文。向量检索仍为未来显式可选的排序增强，不能绕过状态/作用域门禁，也不是知识唯一真相。

**v0.11.31：Wiki 到能力候选。** 至少两条已审核 Claim 才能生成 Skill 或 Workflow 候选，并固定其版本、适用条件、指令草案和回退条件。候选只可进入独立评测；不自动写入 `SKILL.md`、发布、路由或执行。

**v0.11.32：Knowledge Quality Evaluation。** 用户可维护固定的 Query→Expected Claim 案例，计算检索 Recall、Evidence Coverage 和未审核候选泄漏，并以显式阈值得出 `eligible` 或 `insufficient`。结果不自动调整 Context Compiler、路由或发布。

**v0.11.33：Knowledge-bound Work Launch。** 指定精确 Wiki Context Bundle 后，启动与批准前均重验 Claim 版本、审核状态、有效期、scope、Evidence 和 context digest；只读有限知识进入 Host Prompt，Launch/Dispatch/Trial/Outcome 均保留血缘。变化时失败关闭。

**v0.11.34：Knowledge Workbench。** 本机 Workbench 显示 Claim、可编辑 Markdown 页面、Bundle、冲突、评测、候选和知识绑定启动；可人工审核 Claim、刷新页面、预览 Bundle，并在一次 Work Launch 中选择 Bundle。UI 不替代服务端复核，知识漂移仍失败关闭。

**v0.11.35：Wiki Candidate Evaluation Bridge。** Wiki Skill/Workflow 候选须先通过无泄漏的知识检索评测，再绑定其精确版本的 held-out Evaluation Run 与 passed Signoff。之后仍需人工单独授权“可发布”；授权只保存血缘与决定，不写入宿主文件、不自动发布或执行。

**v0.11.36：Governed Candidate Delivery。** 已授权的知识候选可编译为带内容摘要、Claim/Evidence 引用、评测与 Signoff 血缘的便携交付包；Skill 明确面向 Codex、Claude、DeepSeek Harness 或通用 MCP，Workflow 面向 Craft Workflow。所有目标都仍要求人工导入，Package 不写入宿主、不启用工具也不授予执行权。候选评测/发布逻辑从 `CraftService` 门面拆至专用 Kernel，避免这条增长最快的治理链继续膨胀主服务。

**v0.11.37：Guided Work Brief。** 普通用户可从目标、资料引用和必须先回答的决策创建可恢复 Brief；Craft 建立普通 Task，资料只存引用、答案只存脱敏摘要。所有必要决策完成后才能准备普通 Work Launch，仍经过原有 Host 审批、Trial、Evidence 与 Outcome；Brief 不自动规划、不执行，也不授予额外权限。

**v0.11.38：Execution Safety Preflight。** 经 Evidence 验证的 Sandbox Profile、Host、工作目录、读写模式和资源上限可固定并绑定到 Work Launch；写入型启动会在人工批准前重新核验 Profile 摘要与 Dispatch 的 timeout/output（以及 Claude 的 turns/budget）契约。它不把宿主设置宣称为操作系统级隔离。

**v0.11.39：Local Candidate Import。** 已审核的便携交付包可经显式人工确认写入用户指定根目录内的单个 Markdown 文件；路径逃逸、覆盖写入和非人工包均被拒绝。Import Receipt 固定 Package 版本与内容摘要，但导入文件默认不启用、无执行权，宿主启用仍需独立证据。

**v0.11.40：A2A Discovery。** Craft 仅以 HTTPS 读取并固定 A2A Agent Card 的身份、端点、Skill 摘要与内容摘要；所有 Card 都是不可信的只读元数据，漂移失败关闭。它不发任务、不跟随交互端点、不保存认证信息，也不赋予执行权。

**v0.11.41：Workbench 引导工作流程。** 普通用户现在可以在 Workbench 看见并完成“目标—资料引用—必要决策—启动结果”的单一路径。页面只在所有必要决策完成后才允许复用既有受控启动设置；Host 批准、验收和 Outcome 仍由原协议负责。

**v0.11.42：发布质量基线与 MCP 启动可靠性。** TypeScript 测试入口自动发现 `tests/*.test.ts`，避免新测试文件因手工清单遗漏而绕过 100% 行、函数和分支覆盖率门禁。MCP 在存储初始化期间先缓冲 stdin 请求，避免 Node 23 环境中宿主立即发送 initialize 而丢失握手。

**v0.11.43：交付观察闭环。** `WorkDeliveryKernel` 将终态 Host 回执和独立验收状态固定为不可变交付观察，明确区分 Host 失败、待验收、已接受、已拒绝和阻塞；观察对象版本变化时必须新建记录，不能把 Agent 自述当成业务交付。

**v0.11.44：脱敏交付评测桥。** 开发或经独立批准的 held-out Case 可引用两个不可变交付观察，并固定环境与预算指纹后得出 improved / equal / regressed。比较只提供评测证据，绝不自动晋级、发布或改路由。

**v0.11.45：平台执行矩阵。** 只读操作不依赖沙箱，可在 Windows/macOS/Linux 作为便携读取正常运行；任何本地或外部写入都必须精确命中当前平台已验证且默认拒绝网络的边界 Profile，否则失败关闭。该矩阵是启动前决策记录，不会把 Profile 声明误称为真实隔离器，也不会自行执行命令。

**v0.11.46：交付控制闭环包。** 本次合并十项相互依赖的小能力，而不拆成十次版本发布：终态 Host 与独立验收自动形成可版本化的 Delivery Loop，并给出 deliver / collect acceptance / retry-or-handoff / human-handoff 等有限下一动作；Workbench 与 Work Launch 查询显示该投影。脱敏 Delivery Case 可在同环境、同预算下批量聚合比较，只有足量、无回归、全 held-out 样本才建议送 Signoff，永不自动晋级。平台 Probe 仅记录本机健康，Safety Work Launch 可选绑定精确平台预检；写入绑定漂移即失败关闭。详见 [Delivery Control Loop](../technical/modules/delivery-control-loop.md)。

**v0.11.47：任务控制面。** `Task Control` 将 Task、工作目录、允许 effect、可选 Capability/Budget 精确版本和验收要求固定为不可变 Contract，并且只能绑定一个兼容的 Work Launch。它从 Host 回执、独立验收与 Delivery Loop 导出一个有限且可复算的状态/下一动作，形成准备、审批、运行、验收、交付、恢复和交接的单任务闭环。Host/验收变化自动刷新投影，Attention、Home 和 Workbench 显示它；交接记录只保留版本和引用，不保存 Prompt 或业务正文。默认核心 MCP 只能读/刷新状态；完整 MCP 才能显式保存、绑定或交接。它不自动交付、重试、发布或扩大权限。详见 [Task Control](../technical/modules/task-control.md)。

**v0.11.48–v0.11.50：真实任务运行、平台 Conformance 与受控候选演进。** 三个版本合并实现为一个垂直切片：`Task Run` 将既有 Task Control、Work Launch、Host Receipt、验收与 Delivery Loop 固定为一个不存 Prompt 的运行 Manifest，并在环境/预算/关键输入漂移时停止到重新规划；读任务仍走既有自动 Host 启动，写任务仍需审批。平台 Conformance 可记录禁网、目录、凭据、取消清理和资源边界的 verifier 证据并绑定 Profile，不能把健康 Probe 或旧 Profile 冒充安全证明。Task Benchmark 只配对已观察交付，在同环境/预算的 held-out 集上聚合，再生成摘要化 draft candidate；passed Signoff 后才能进入 Canary，永不自动发布或改默认路由。详见 [专项模块](../technical/modules/task-run-benchmark.md)。

**v0.11.51：Verified Work Loop、State Workspace、Eval Campaign 与 Serena 桥接。** 主入口将 Task Contract、初始状态、Launch、Task Run、Receipt、再观察、Acceptance、Outcome 和 Checkpoint 串成一条可恢复路径；Host 完成不能绕过成果验收。文件树与文件 Artifact 的 State Adapter 只保存摘要/版本/差异；人工编辑成为 `HumanStateEvent` 并使旧路径 `needs_replan`。Eval Campaign 计划并绑定 held-out 的 Case × Harness × N Trial，不暗中启动 Host；它复用 Benchmark/Signoff/Canary gate。Project Knowledge Adapter 只按需读取受信任项目的 Serena Memory，并仅可提出带 Evidence 的更新草案。详见 [专项模块](../technical/modules/verified-work-loop.md)。

**v0.11.52：外接 Capability Connector 与 Core WorkLoop。** 用户可显式登记内置能力、GitHub/火山引擎 Skill 来源以及 stdio/HTTPS MCP；Craft 只保存无凭据元数据、用户审批引用、来源摘要与版本，Host 才负责真实发现、安装、启停和调用。已批准的只读 Asset 才能进入 Activation Profile；调用 ticket 同时绑定 Profile、Capability Asset、Connector Asset、来源摘要和过期时间，消费时重新检查状态与版本。Serena MCP 仅允许只读 Asset。默认 `craft-mcp` 现在公开 `VerifiedWorkLoop` 的 `prepare / advance / decide / resume / get` 及已签发 ticket，而 Connector 注册、发现、启停和批准仍在显式 `craft-mcp-full`，避免配置型工具污染默认面。详见 [Capability Connector](../technical/modules/capability-connectors.md)。

**v0.11.54：Verified Execution Fabric。** 将 Task Contract、Activation Profile、Host Dispatch、Verified Work Loop、State Snapshot、Acceptance、Outcome 与 Eval Runner 收敛为同一条可复核执行链。新增无正文 `Host Activation Manifest`：固定 Host、Profile/Asset 版本、effect、来源摘要和 Connector ticket 引用；校验失败即拒绝，且不改 Codex/Claude/MCP 配置、不启动 Connector。新增 `Execution Fabric`：只有重新验证 Manifest、重新观察状态并追加 receipt 后才推进，输入/权限/能力/环境/状态漂移不能复用旧事实。确定性 Workflow Eval Runner 继续实际运行 Case × Subject × N Trial；通用 Host 评测仍必须绑定真实 Host 事实，不能伪造。详见 [Verified Execution Fabric](../technical/modules/verified-execution-fabric.md)。

**v0.11.54：Managed Host Bridge 与最小任务工作区。** Fabric 创建的 Launch 会延后只读 Host 启动，`Host Bridge` 必须先重验 Manifest、核对 Prompt 摘要并消费精确 Receipt，才可调用本地 Codex CLI 或 Claude Code；写入仍需显式审批。Host 终态会自动回流为状态再观察和 Fabric advance，且不会把进程完成冒充交付完成。Workbench 的“开始工作”通过同一 Fabric endpoint 创建任务、观察范围与 Host 调用；知识 Bundle 保留原有独立边界。详见 [Managed Host Bridge](../technical/modules/managed-host-bridge.md)。

**v0.11.55：可验证执行与演进平台。** `workspace-write` Fabric 在启动前建立已声明路径的本地事务基线，成功终态才提交新 Checkpoint，失败停在可人工批准恢复的状态；它不覆盖外部 effect。Eval Campaign 增加从真实 Delivery 汇总的无正文报告，展示配对样本、交付率、改进/回归率而不冒充业务质量。Candidate 只有经过 held-out Evaluation、Signoff、带 Evidence 的 Canary 和 reviewer 结论后才成为 `routing_eligible`；自适应选择器否则返回最小 baseline Harness，不自动执行、发布或默认多 Agent。详见 [可验证执行与演进平台](../technical/modules/evolution-platform.md)。

**v0.11.56：Managed Run 与 Evaluation Lab。** 将已有 Verified Work Loop 的 Task Run、状态快照与 receipt 收敛为引用化的跨会话交接；恢复必须重新观察，漂移转入 `needs_replan`，Shadow 固定只读且不重放外部 effect。Campaign Runner 按固定 `Case × Harness × Trial` 槽位向 Host 签发任务、只绑定同环境同预算的真实 Task Run，再复用已有 held-out、Signoff 与 Canary 门禁。Judge 默认 advisory；只有带人工金标/Evidence 的校准 Judge 与 eligible reliability assessment 组成 Gate 后，才可被依赖它的 Candidate 使用。Core MCP 只暴露这些对象的只读状态，管理动作留在 Full MCP。详见 [Managed Run 与 Evaluation Lab](../technical/modules/managed-run-evaluation-lab.md)。

**v0.11.57：Agent-Native Workspace Runtime。** `Work Coordinator` 将已有 Fabric、Managed Run、Host Run、Receipt、再观察与后续验收收敛为单一的可恢复状态链；它不保存 Prompt 或模型思考，也不拥有隐藏的 Agent Loop。`Workspace Observer` 仅以 Snapshot/Diff 观察显式范围，未归属变化不猜测来源。`Autonomy Ladder` 区分跨平台只读、人工批准的受控本地写、已验证隔离的无人值守写与外部 Gateway，避免把普通本地写冒充为沙箱。`Agent Eval Lab` 将显式启动的 Host Attempt 固定到 Campaign Slot，只有同环境、同预算、终态回执且再观察完成的 Attempt 才能参与评测。详见 [Agent-Native Workspace Runtime](../technical/modules/agent-native-runtime.md)。

- 面向各行业工作者，研发是首批验证场景，视频用于检验跨领域复用；后续扩展销售、教育与内容创作，不同时自建所有专业编辑器。
- 先把真实工作从目标到成果跑通，同时提供可操作的最小界面；不长期只增加协议与配置。
- 自研重点是状态与变更、动作契约、证据和复用的连接；执行后端、模型服务及专业组件优先适配成熟实现。
- Generative/Dual-Mode UI、沙箱、轨迹编译、分层上下文和后台经验整理都保留在目标中，按依赖分阶段实现。
- 首次体验以目标和资料开始，技术模式移到高级设置；当前 `craft init` 的模式选择仍未改造。
- 产品级跨平台验收包含安装、路径、取消恢复和隔离能力；Node 可运行不等于每个平台安全执行能力相同。

## 下一阶段里程碑

| 阶段 | 交付范围 | 通过条件 |
| --- | --- | --- |
| M1：完整工作体验 | 一个真实 Host Driver；最小项目/成果界面；资料访问状态、运行与待决策项；可编辑交付；现有验证/评测接入 | 普通用户完成一次工作，中断后能继续；成果、实际动作与检查可追溯。对应自主动作开放前补齐所需沙箱保证 |
| M2：变化与恢复 | 对象版本、明确依赖、冲突检查与局部续做；范围内快照、模拟与提交前重检；分支比较；第二 Host/等价执行后端验收 | 修改一个要求后保留有效成果，旧输出不覆盖人工修改；如实区分本地恢复、外部补偿及不可撤销动作 |
| M3：经验与可执行复用 | 多案例轨迹提炼、参数/数据依赖/分支、TS/Workflow 候选；适用性检查；预算化后台经验整理试点 | 在新输入和历史任务上对照评测，通过既有晋级门禁；收益包含提炼/评测成本；不适用时安全转回探索 |

M1 的安全前置项见 [沙箱缺口与验收](../technical/modules/execution-policy.md)：默认拒绝的目录/网络边界、环境凭据处理、进程取消与资源上限必须有真实后端证据。现有 helper/profile 不能直接作为完整安全保证。

生成界面先做受控组件装配与稳定导航，再扩展目标驱动的动态视图。上下文先提供来源可见与版本感知，再做自动工作集管理。跨设备同步、团队治理及远程 Hub 逐步接入，不默认上传资料。

## 当前版本重点

**v0.11.17：Contract 与 Domain Action 融合。** Domain Kit Action 可引用精确 Contract Candidate 与已发布 Capability Asset 版本。应用 Kit 时要求 Contract 已通过既有人工评审、verified Sandbox 和 evidence-backed Trial，Publication 仍为 active，Capability 为 verified/healthy 且已被本 Kit 依赖锁固定；Contract、Asset 与 Action 的副作用必须一致。通过后生成不可变 Action Lock，保留输入/输出 Schema、幂等、补偿和凭据句柄要求。`craft_domain_kit_action_prepare` 只产生输入摘要绑定、可幂等重放的动作请求，并明确不授予执行权；有副作用动作仍进入授权门禁。当前未在 Craft 内执行任意 Schema 中的代码，也未把准备请求误当成 API 已调用。

**v0.11.18：Domain Action 类型化授权与结果闭环。** `craft_domain_kit_action_prepare` 接收临时输入，使用 Action Lock 中的有界 JSON Schema 子集失败关闭校验，并从 `read_only / local_write / external_write` 推导精确 Autonomy Action；Task、Target、Policy 版本、请求摘要和调用者身份被绑定到一次性授权。原始输入不写入 Craft 数据库。授权消费后，`craft_domain_kit_action_report` 要求真实 Evidence；成功结果还必须通过锁定的输出 Schema，仅保存输出摘要。失败也作为明确终态留痕。当前 Schema 子集不等同于完整 JSON Schema Draft，Craft 尚未自动选择或调用任意 Host Adapter，准备、授权、执行和报告仍是相互独立的安全阶段。

**v0.11.16：跨领域确定性验收器。** 同一 Acceptance Adapter 内核增加覆盖率报告和媒体探测两类机器验证。前者读取 Istanbul/nyc `coverage-summary.json`，分别比较行、分支、函数和语句阈值；后者读取 ffprobe JSON，验证视频流、时长、宽高、编解码器和音频流。两者均限制工作空间相对路径、普通非链接 JSON 文件和最大输入尺寸，通过独立 Adapter 租约生成结构化 Receipt，再进入统一 Evidence、Check、Assessment 与 Outcome。MCP 可直接准备 Job，Domain Kit 也可声明 `coverage_report` 或 `media_probe` Evaluator。Craft 验证报告而不假装生成报告；ffprobe/测试运行仍由 Host 或领域工具完成，叙事、美学和业务质量不能由这些技术门禁代替。

**v0.11.15：Domain Kit 依赖锁与真实预算闭环。** 应用 Kit 时递归解析 Capability Asset 的精确 `asset@version` 依赖，拒绝浮动版本、循环、失效信任与隐藏越权副作用，并生成不可变依赖锁。含资源上限的 Kit 必须绑定当前任务拥有的 Budget Account，实际预留 Kit 声明额度；完成后通过独立协议按实际消耗幂等结算并释放余量。沙箱在预算预留前先做无 Ticket 的兼容性预检，预留成功后才签发正式 Ticket，避免已知不兼容执行占用配额。当前仍不自动安装依赖、不推断实际消耗，也不承诺任意外部系统的事务回滚。

**v0.11.14：Domain Kit 完整执行契约。** Kit 可固定 Capability Asset 与 Evaluation Suite 的精确版本，声明工作对象 Schema、安全视图组件、动作副作用、资源上限和 Sandbox Requirements。应用时会复验能力健康、可信度和副作用；沙箱要求必须由精确的 verified Profile 满足，并签发绑定 Kit、Launch、字段值、依赖与评测集摘要的 Ticket。不满足的依赖、越权副作用、未验证沙箱、重复 ID 和漂移版本均失败关闭。组件只允许表单、成果预览、检查清单和状态视图等声明，不允许携带任意执行代码。

**v0.11.13：版本化 Domain Kit 与动态领域表单。** Kit 把字段 Schema、验收条件和 Evaluator 绑定保存为宿主无关的精确版本；支持文本、相对路径、整数、布尔和选项字段，拒绝未知字段、缺少必填值、越界路径及同 ID 漂移。Workbench 根据 Kit Schema 生成表单，并把填写结果绑定到现有 Work Launch 和 Acceptance Plan。首批内置“研发交付”与“视频交付”Kit 共用同一内核；视频文件限制扩展名和大小，并保留独立人工质量确认。内置 Kit 身份发生本地冲突时失败关闭，不静默覆盖。

**v0.11.12：文件成果验收进入真实运行链路。** Workbench 支持用 `file:相对路径` 声明确定性成果检查，并在 Host Run 完成后由内置 Worker 自动生成 Evidence、Check、Assessment 与 Outcome；CLI Maintenance Worker 同样持续消费该 Adapter 的持久 Job。高级调用可通过 MCP 固定扩展名、最大字节数和 SHA-256。Job 可以在执行前登记，但只有关联 Host 明确完成后才能领取；轮询重入、单次检查异常、租约过期和重试耗尽均隔离处理。

**v0.11.11：领域 Adapter SDK 与首个真实检查器。** 通用 SDK 可在一次 Tick 中领取匹配 Job、隔离单个 Evaluator 异常并提交 Evidence-backed Receipt。首个内置 `file_artifact` 确定性检查器可跨平台验证工作空间内的普通文件、大小、扩展名和 SHA-256，不跟随符号链接或越界路径。Evaluation Job 固定 Evaluator 配置和最大尝试次数；Maintenance Worker 回收过期租约，耗尽后进入 Operator Attention，而不是无限重试或静默丢失。

**v0.11.10：领域验收执行协议。** program、model 与 business signal 验收器成为带版本、Adapter 身份、配置和启停状态的对象。非人工验收条件可绑定精确验收器形成持久 Job；领域 Worker 只能领取自己 Adapter 的 ready Job，并在有限租约内提交摘要绑定的结构化 Receipt。Craft 据此生成带验收器版本的 Evidence、Check、Assessment 与业务 Outcome。重复报告保持幂等，配置漂移、错误方法、过期租约和 Adapter 越权均失败关闭。协议不把任意命令塞进 Craft，也不把某个研发模板硬编码成通用规则。

**v0.11.9：多方法领域验收。** Work Launch 可绑定独立 Acceptance Plan，按条件指定 program、model、human 或 business signal 四类验证来源。每条 Check 必须由计划声明的评审者类型提交真实 Evidence；缺少必需项保持 pending，明确失败与依赖阻塞分别形成 failed/blocked，全部必需项通过后才形成业务 passed Outcome。Host 执行 Trial 与 Acceptance Trial 完全分开。Workbench 支持逐行填写通用验收条件，并可由用户对 human 条件作出带依据的确认；MCP 暴露计划、检查、人工确认、汇总和读取协议。完成执行但尚未业务验收的工作进入 Attention Inbox。

**v0.11.8：Host 结果进入评测闭环。** 每个 Work Launch 在执行前创建以精确 Launch 版本为 Subject 的 Trial，并记录准备 Trace。Host 进入 completed、failed、cancelled 或 interrupted 后，系统自动登记脱敏回执 Artifact、程序 Evidence、终态 Trace 与 Outcome，记录执行耗时以及 Host 可提供的 Usage/Cost。该 Outcome 只判断 Host 进程和协议是否完成，不代替领域验收；业务质量仍必须由确定性检查、模型评审、人工确认或业务信号追加验证。投影失败不会反向篡改已经确定的 Host 终态。

**v0.11.7：目标到受控运行。** Workbench 可直接创建 Task 和 Host 工作尝试。只读请求准备后立即交给 Supervisor；工作区写入停在 `awaiting_approval`，并持续投影为可恢复的人类待办。界面展示精确 Workspace，用户重新提供摘要匹配的 Prompt 并批准后，系统创建一次性 Autonomy Request，再启动同一 Dispatch。Prompt 不写入 Launch；失败、取消或中断后的 Retry 必须重新提交 Prompt，默认继承原执行配置，并创建带 `retry_of` 的新 Launch/Dispatch/Run。相同 Launch ID 只接受 Host、Sandbox、Workspace 和 Prompt 摘要完全一致的幂等请求。

**v0.11.6：Workbench 运行控制。** `craft serve` 将 Workbench 与 Local Supervisor 绑定为同一所有者进程；网页新增 Host 任务列表、活动状态、增量事件视图和取消按钮。增量接口使用事件序号游标，只投影流向、字节数、摘要、状态和回执引用，不把原始 stdout/stderr 注入浏览器。Home 的活动运行统计纳入 Host Run。当前使用短轮询而非公网推送，避免为本地单用户场景提前引入持久连接和远程认证承诺。

**v0.11.5：本地 Supervisor 与认证 IPC。** `craft supervisor run` 持有单实例锁、私有 Owner Token、回环 HTTP 控制端点和心跳；其他 CLI 进程可用 `host-run start/get/cancel` 控制同一批真实 Host 子进程。Host Run 持久绑定精确 Owner；Supervisor 只有确认旧 PID 已死亡、主机身份一致并成功接管旧锁后，才中断该 Owner 留下的孤儿记录，不扫描或修改其他 MCP/Runner 的任务。本版本仍不是操作系统服务，不会在登录后自动启动，也不会重附着崩溃前的子进程。

**v0.11.4：受管 Host 后台运行。** 持久 MCP/Workbench 进程可启动已经准备的 Codex 或 Claude Dispatch，保存状态、只含流向/字节数/摘要的进度事件，并支持查询与显式取消。取消只由持有真实子进程控制器的进程执行；重启后不能假装重新接管旧进程，只有确认原 Runner 已停止后才把孤儿记录标记为 `interrupted`。一次性 CLI 尚不是常驻 Supervisor，因此不提供后台启动；跨进程 IPC、重连和界面流式控制是下一阶段。

**v0.11.3：统一 Host Driver Protocol 与 Claude Code Driver。** Codex、Claude 共用宿主执行请求、结果和 Driver 生命周期语义。Claude 使用非交互 `stream-json`，只读任务只暴露 Read/Glob/Grep，工作区写入仅增加 Edit/Write，并始终排除 Bash、MCP 和绕过权限模式；同时支持最大轮数与可选美元预算。当前机器没有安装 Claude Code，因此本版本通过注入式 CLI 契约测试，不宣称完成真实二进制兼容验收。

**v0.11.2：真实 Codex CLI Host Driver。** Craft 可准备与执行摘要绑定的 `codex exec --json` 请求；默认只读，工作区写入必须消费精确的一次性 Craft 授权。子进程禁用 Shell，输出、超时和事件解析均有边界，并留下本地持久回执。该版本不绕过 Codex 沙箱，也不宣称具备全平台回滚能力。

**v0.11.1：目标创建与任务证据视图。** Workbench 可创建本地目标并进入任务详情；详情从精确 Task 关联汇总 Checkpoint、反馈、运行、Trial、Outcome、Evidence、Artifact、Lineage、等待和 Attention。缺失的历史引用不会被伪造为成果，任意底层 Payload 不直接进入界面。

**v0.11.0：本地 Workbench Web Shell。** `craft serve` 只监听 `127.0.0.1`，通过进程级随机令牌和同源检查保护 Home/Inbox API，限制请求体并设置禁止缓存和浏览器安全响应头。首个响应式中文界面展示概览、待处理事项、任务、工作空间、运行、预算和成果；它是现有状态协议的可视化入口，不是第二套业务逻辑。

**v0.10.9：Workbench Home 读取模型。** 将任务、工作空间、待处理事项、活动运行、预算余额、最近成果和维护健康组合为受限、无密钥、可供 CLI/MCP/UI 共用的首页投影。它引用权威记录，不复制业务状态。

**v0.10.8：可持续使用入口。** Maintenance Worker 在完成恢复队列投影后自动刷新 Attention Inbox；用户可从跨平台 CLI 查看、按受众筛选、确认或延后事项。桌面端未来复用相同接口，不另造一套状态。

**v0.10.7：统一注意力与行动入口。** 将分散在审批、恢复队列、后台维护和投机运行中的待处理状态投影为按人类、Agent、运维者分组的稳定卡片；支持优先级、确认、延后、源变更重开和源完成自动收口。它为未来 Canvas 首页和通知层提供统一读取面，但不复制或绕过源状态机。

**v0.10.1–v0.10.2：Patch、等待与预算控制面**，优先解决 v0.10.0 对象级并发保护过粗的问题，不先建设联邦群智或自研图数据库。

- `ChangeSet / ActionPatch`：记录基线修订、对象、字段/区间、前置条件、作者和意图；区分可自动合并、需要重算和需要用户裁决，局部标记依赖失效。CRDT 仅作为特定对象 Adapter。
- Durable Wait：Run 可以进入审批、事件或时间等待并释放执行环境；事件唤醒后重验 Policy、输入版本、凭据和外部状态。到期时间等待可由跨平台调度器调用有界 Sweep 恢复。
- Budget Reservation：探索/并行前预留模型、API 和算力预算，回执后结算；父 Task 为子 Agent/分支分配的子预算先冻结配额，关闭时按实际用量回结，避免并行超卖；不足时缩小计划、暂停或请求追加，不固定执行质量不明的模型降级。
- Fallback Contract：可执行 Workflow/脚本声明适用范围、异常分类和回退入口；发生语义或依赖漂移时生成可续接 Trial，回到受控探索而不是直接退出或静默提权。Host 完成回退后以 Evidence、Outcome 和实际资源结算收口。

以上四项已经形成 TypeScript 内核、MCP 工具和确定性测试：无关字段 Patch 可以合并，同字段漂移拒绝提交；等待状态可持久化并在唤醒时复核 Workspace/Policy；预算预留和结算保持幂等；Fallback 受版本、触发条件、次数和预算约束。它们还不是完整 Canvas、事件服务或真实执行网关。具体规则见[控制面护栏](../technical/modules/control-plane-guardrails.md)。

## 真实任务验收

- 研发：需求或接口中途变化、进程中断、人工修改文件后续做，最终检查需求与测试。
- 视频：先形成分镜与素材，再改变人物设定，局部重做相关镜头；程序检查格式/时长，用户比较审美与一致性。
- 非研发交付补充用例：指定可编辑 PPTX、表格或文档，验证真实文件格式、来源与局部可编辑性，不能用 HTML 或操作教程代替要求的成果。
- 对照普通 Host 与 Craft 辅助工作，尽量固定模型、输入、预算与环境；记录交付质量、人工修正时间、重复解释/重做、恢复成功率、总成本和历史回归。
- 纳入权限撤销、过期记忆、超时、取消和服务异常；样本不足如实报告，不把单元覆盖率或一次成功当作业务效果证明。

## 当前实现基线

以下保留版本历史以供查证。列表中的“已实现”描述接口或机制，不代表完整 UI、真实跨 Host 链路或行业效果已经验收。旧版本描述以其当时范围为准，最新边界以模块文档为准。

- 多来源 Capability 索引和按需加载。
- Task、Checkpoint、Artifact、Evidence 与版本化 Workflow。
- Codex、Claude、DeepSeek Harness 和通用 MCP 接入。
- 不可变 Trial/Outcome、只追加 Trace、评测分区和 Workflow 晋级/回滚门禁。

验收：核心代码 100% 行/函数/分支覆盖；插件在无 `node_modules` 缓存目录可启动；`verified` Workflow 不能绕过 held-out Eval。

## 版本演进记录

- Workflow Run 自动登记 Trial、Trace、Artifact、Evidence 与 Outcome。（v0.3.1 已实现）
- 确定性、模型 Rubric、人工和业务结果四类 Grader，以及版本化 Signoff Policy。（v0.4.0 已实现基础协议）
- Search/Development 与 held-out 数据隔离；同一评测集的质量、成本、耗时和失败类型聚合对比。（v0.5.0 已实现确定性基础协议）
- Workflow、Agent Profile 与 Harness Configuration 使用同一评测协议。（v0.5.0 已实现版本对比；Capability 评测待实现）
- Orchestration 执行自动形成 Trial、Trace、Evidence、成本和 Outcome，并锁定 Agent Profile 路由版本。（v0.6.0 已实现）
- 默认编排已成为复杂任务的默认 Skill 策略；优先复用已验证 Workflow，无匹配时自动创建可续接的安全增量研发 Kit，并从同策略完成 Trial 自动列出 Experience Candidate。（v0.9.0 已实现）
- 自然语言续接仅恢复唯一匹配的活动路线；并列、已完成和无匹配任务不猜测。（v0.9.1 已实现）
- 重复通过且带证据的安全路线可生成带溯源的 Workflow 草案；草案仍须走已有评测门禁，不能自动晋级或发布。（v0.9.2 已实现）
- Project Policy 可将 Git 基线、聚焦测试、覆盖率和 Review 回执变成服务端硬门禁；Host Adapter 只能领取已声明支持的下一安全动作。候选按通过率、独立 Task 和 confirmed/bounded Evidence 资格化，检索按名称、描述和别名重排。（v0.9.3 已实现）
- 可选 OpenAI-compatible Embeddings：未配置时严格保持关键词检索；配置后只为 Skill 名称、描述和别名建立按 Provider 指纹隔离的缓存，查询成功时以混合排序增强召回，超时、鉴权、格式或维度失败时自动退回关键词结果。（v0.9.4 已实现）
- 受控 Runtime Core：版本化 Policy 限定 effect、审批、并发和预算；持久 Run/Operation 记录父子归属、环境/Policy 指纹、审批与幂等回执，预算耗尽安全暂停。（v0.9.5 已实现）
- 受信任 Host 的确定性 Driver：只执行已签发、显式输入且通过命令/路径/effect Policy 校验的 Workflow Operation；DAG 依赖、有限重试、Lease 过期恢复以及 Trace/Artifact/Evidence 回执均持久化。通用 Agent/Grader 仍交给 Host Adapter。（v0.9.6 已实现）
- 自动 Eval Runner：对确定性 Workflow 运行 `Case × Subject × N Trial`，自动归档 Trial/Trace/Outcome、Evaluation Run 与可比 Comparison；程序 Grader 可自动出 Grade，Promotion Assessment 对 held-out baseline/candidate 检查最少 Trial、通过率、成本与配对胜负；模型/业务 Agent Subject 必须通过 Host Runtime 提交真实 Outcome。（v0.9.6 已实现）
- Experience Miner 与 Operational Drift：重复成功策略与失败模式只产出 proposal-only 候选；shadow 仅执行只读 held-out baseline/candidate 对照，Promotion 通过后只准备指定 Signoff Policy，仍须独立 Grade/Signoff/Publisher Gate 才能发布。数值线上信号以滑动窗口生成可审计告警。（v0.9.8 已实现）
- 按风险、预算和副作用选择最小 Harness，并将 Operation DAG 编译为版本化 Agent IR、Lower 到 Runtime Run。（v0.9.6 已实现）
- Runtime Adapter 将宿主 Agent/Grader 领取与回执约束为版本化契约；本地 Adapter 不能声明外部/破坏性 Effect。直接 Eval 晋级必须经过 held-out 的 Candidate/Baseline Promotion，成本与时延分别受阈值控制。（v0.9.7 已实现）
- Capability Asset Registry、最小 Activation Profile、profile-bound 过期调用回执、唯一只读 `diagnostic_research` Expert 与最多五个 Context Capsule Sub-agent。（v0.9.9 已实现）
- 评测可靠性、Judge 校准、受审核 development 反馈、最多两个设计轴的 Adaptation Candidate、Signoff 后 Canary/精确回滚。（v0.9.9 已实现）
- 执行按风险分级：普通读/规划可跨平台运行；仅本地生成代码写入依赖 macOS/Linux 网络拒绝隔离；外部写入审批、无补偿破坏性或未受信任 Broker 的凭据请求失败关闭。（v0.9.9 已实现）
- Agent-Native Workspace：显式文件根/纳入路径、可选 Git 基线引用、不可变文件 Checkpoint、摘要 Diff、人工改动记录和显式批准恢复。它是 CLI/插件与未来 Canvas 的共同状态源，不自动执行 Git 或覆盖工作区根。（v0.9.10 已实现）
- Transactional Runtime 与 Trajectory Compiler：本地写事务先固化 baseline、再提交精确 Checkpoint 或显式回滚；passed Trial 只能编译为白名单 Workflow/Checkpoint 的静态脚本候选，exact passed Signoff 后才可标记 verified。外部系统事务、任意代码执行和脚本 Runner 仍未实现。（v0.9.11 已实现）
- 已签发脚本运行交接：verified Script 只能绑定到同一 Workspace 的 prepared Transaction，生成精确 Host 操作单并接收逐项回执；Craft 不 `eval` TypeScript，也不把 Host 回执当作外部副作用的独立证明。（v0.9.12 已实现）
- Workspace Runtime 闭环：结构化工作对象记录版本、状态、来源路径、产物和显式依赖；变更可预览并传递标记 `needs_review`，状态修订阻止旧结果覆盖新修改。用户/任务/工作空间记忆保留来源、有效期和替代历史，并与当前工作对象一起按查询和字符预算装配上下文。（v0.10.0 已实现内核与 MCP 协议；Canvas、自动依赖发现和后台整理仍未实现）
- ChangeSet/ActionPatch：以对象精确版本为基线比较字段路径；未被并发改动的字段可以合并，同路径冲突拒绝提交；成功提交后只传递失效相关依赖。（v0.10.1 已实现内核与 MCP 协议；富文本区间合并和 CRDT Adapter 未实现）
- 控制面护栏：资源预算支持预留、实际结算、幂等和父子配额；审批/事件/时间等待可释放环境并在恢复时复核状态；外部事件按稳定 ID 去重并只唤醒精确等待；Fallback Contract 限制版本、触发条件、次数和预算。凭据只以句柄出现，HTTPS Egress Broker 在最后一跳注入 Secret；Sandbox Inbox Bridge 让容器保持禁网。External Effect/Saga Kernel 在 Host dispatch 前固化请求摘要、幂等键、审批和可选补偿，以不可变 Receipt 区分成功、失败和未知。只读 Reconciler 可通过一次性授权 GET 对账；受控补偿 Adapter 在发送前冻结动作、摘要、审批和结果映射，发送后网络异常保留为补偿未知。（v0.10.2 已实现内核、MCP 和本地 Broker Adapter；真实 Webhook/定时 Adapter、业务正文状态解析、预算预测/计费采集、企业级代理/证书策略和维护版 held-out 安全集仍未实现）
- 受控主动恢复与准备：Recovery Queue 有界投影恢复工作；签名 Webhook Subscription 以 HMAC、重放窗口、过滤、节流、字段投影和预算预留接收授权事件；Speculative Candidate Runtime 只允许索引、总结、草稿和元数据预取，固定输入摘要、预算、TTL 与候选上限，使用短 Lease 和证据回执，自动形成 Trial/Trace/成本/Outcome，人工修改形成偏好信号，绝不自动转成外部写操作或凭单次接受直接晋级。（v0.10.2 已实现内核与 MCP；公网 HTTP Server、供应商 Adapter、常驻调度进程、系统级环境订阅和内置领域 Worker 仍未实现）
- 对象级 Provenance/Lineage：以不可变声明连接精确版本的 Source、Output、可选 Transform 和 Evidence，支持段落/单元格/镜头等 Locator、跨领域上游与下游有界遍历、环检测、同一输出派生冲突阻断，以及输入、输出、转换器新版本提示。（v0.10.2 已实现内核与 MCP；编辑器自动采集、领域可视化和组织访问控制仍未实现）
- 长任务 Dehydration/Hydration：冻结 Task、Workspace 修订、Wait、Runtime 指纹、Budget 和 Recovery Item 的最小引用，不保存原始对话或凭据；恢复前区分 still_waiting、ready 与 needs_replan，使用短 Lease 防并发恢复，完成要求 Evidence，过期 Lease 可回收。（v0.10.2 已实现内核与 MCP；真实容器内存镜像、跨设备文件搬运和远程对象存储仍未实现）
- 分级自主权与审批：版本化 Policy 将动作划分为 automatic、notify-only、human approval 和 multi-signature；授权精确绑定 Policy 版本、Task、Action、Target、请求摘要和 TTL，审批人不可重复，拒绝立即终止，通知与一次性消费留下持久回执。配置有效 Policy 的 External Effect 以同一事务消费授权并进入执行态；Runtime Operation 固定动作身份，Host Adapter 派发与授权消费原子完成，Computer Use 成为一等 Kind，子 Operation 不能旁路。（v0.10.2 已实现内核、MCP 与执行门禁；真实 GUI Driver、生产身份和组织角色由 Host/网关提供）
- Contract Inference：API、MCP 和 Computer Use 只提交脱敏后的输入/输出 Schema、Effect、幂等/补偿观测与 Evidence；至少两次一致成功观测才能生成无执行权 Candidate，人工修订后还需 verified Sandbox Profile 与 evidence-backed passed Trial。精确版本 Diff 区分 equivalent/compatible/breaking；独立 Publisher 才能发布 Capability Adapter，回滚仅能撤回 Publication 仍拥有的 Asset Version。（v0.10.2 已实现内核与 MCP；自动抓包、Schema 合成、真实流量 Canary 和 Host 驱动安装尚待实现）
- Capability Canary：active Publication 与 baseline/candidate 精确版本进行稳定双臂分流；两侧达到最小样本后比较失败率、成本、时延与人工修正率，越界立即停止候选新流量并生成回滚建议，不自动执行高风险回滚。（v0.10.2 已实现内核与 MCP；统计置信、领域业务指标、自动扩量和真实 Host 流量采集尚待实现）
- Capability Supply Chain：Federation 负责脱敏发布与撤销，Hub Sync 负责 Ed25519 签名增量目录，Materialization 负责内容寻址隔离缓存和基础安全门禁；Certification 要求 held-out Evaluation、逐 Trial Sandbox Receipt、Evidence、program Grade、Signoff 和职责分离，最终原子晋级 verified 且不授予执行权。持续治理把来源停用、条目撤回、摘要漂移和高危公告传播为 Asset blocked/stale、Certification invalidated、Activation Profile invalidated 及可恢复的再认证工作。（v0.10.3 已实现本地内核与 MCP；主动 HTTP 拉取、自动公告订阅、沙箱归档解析、深度恶意代码/依赖/许可证分析、企业身份、透明日志和管理 UI 尚待实现）
- Sandbox Adapter Contract：本地进程、容器和远程后端使用同一版本化能力描述；声明态不能执行，普通 Probe 只产生诊断 Evidence，只有黑盒 Conformance Suite 完全通过后才生成 verified 版本。执行 Ticket 绑定精确 Profile、任务、要求和请求摘要；成功回执必须证明相同文件/网络/特性/资源边界，身份或能力漂移均失败关闭。首个 Docker CLI 驱动已验证禁网、只读根、Workspace 可写、环境无常见 Secret、超时取消与无残留容器；业务 argv 无宿主 shell，异常后强制清理并复查。（v0.10.2 已实现协议、MCP、确定性匹配、Docker CLI 驱动和 Conformance Suite；真实 Docker 跨平台安全认证、镜像供应链和远程平台驱动仍未实现）
- Lease TTL/续租、显式幂等提交和实际成本超限阻断。（v0.8.0 已实现基础协议）

验收：同一真实任务集能比较两个版本的质量、成本、耗时和失败类型，并阻止无证据晋级；默认入口不能绕过 Host 审批或把未验证 Skill 当作可执行流程。Runtime 的每个子 Operation 必须归属根 Task，控制/环境指纹变化必须使旧证据失去新晋级资格。

## 后续领域扩展

能力访问治理、`diagnostic_research` Expert 与只读 Sub-agent 的实现边界、证据和后续项见：[专项规划](capability-expert-subagent-plan.zh-CN.md)。

- 将现有 IR Lower 到至少两个真实 Host 的执行计划。
- 用“研发 Kit”和“AI 视频 Kit”验证同一内核能否跨领域复用。

验收：同一 IR 可在至少两个宿主执行；两个领域共用核心协议，只扩展 Kit。

## 长期验证

- 生成多个执行架构候选，使用廉价估算逐级筛选，最终做高可信 Signoff。
- 从 Case 级记录提炼带适用条件的全局经验。
- 学习“什么条件下哪种配置有效”，而不是无限追加聊天摘要。
- 所有自动修改保持预算限制、版本记录、评测门禁和回滚能力。

长期是否成立，以跨模型迁移率、任务完成率、人工修正量、恢复时间、成本和回归率衡量，不以“自进化”叙事衡量。
