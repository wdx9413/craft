# Craft 架构

[简体中文](architecture.zh-CN.md) | [English](architecture.en.md)

## 产品边界

Craft 的产品目标是面向各行业的人机共同数字工作台；本页记录现有 Agent Harness 内核及版本演进。Codex、Claude Code、DeepSeek Harness、未来桌面端或自建程序都可以成为 Host 或 Client。

完整目标见 [三大支柱与十个模块](product/architecture.zh-CN.md)，后续取舍见 [路线](product/roadmap.zh-CN.md)。评测属于“学习与改进”支柱，沙箱属于“执行与保障”。历史章节中的隔离描述不得解释为已完成安全认证；当前实际缺口见 [沙箱与执行策略](technical/modules/execution-policy.md)。

Craft Core 管理以下稳定对象：

- Capability：可检索的能力资产。当前扫描 `SKILL.md`，未来扩展插件与 MCP 元数据。
- Task / Checkpoint：跨会话任务状态和可信接续点。
- Artifact / Evidence：产物引用、明确主张、来源与置信度。
- Workflow / Run：版本化步骤、输入、权限和执行回执。
- Evaluation Suite / Signoff：可复用评测用例与精确版本的晋级决定。
- Experience Pattern / Skill Proposal / Publication：多个 Trial 的可复用经验、版本化 Skill 候选与受控发布回执。
- Agent Profile / Orchestration Plan：模型角色、宿主路由与依赖图。

## 运行结构

```text
Codex / Claude / DSH / CLI / future desktop
                     │
              Plugin or MCP
                     │
       Craft TypeScript application service
          ┌──────────┼──────────┐
       Catalog    Workflow   Orchestration
          └──────────┼──────────┘
              SQLite + ~/.craft_data
```

运行时统一使用 TypeScript 和 Node.js 23+。SQLite 使用 Node 内置驱动；在不带 FTS5 的运行时自动降级为关键词检索。

## 能力发现

Source 同时保存用户输入路径和解析后的真实路径。扫描器跟随目录链接并用真实路径避免循环；同一真实来源不会重复注册。增量扫描先比较大小和修改时间，变化时才读取正文并计算摘要。

本地关键词召回返回最多 20 个候选卡片且不携带正文，Client 选择后才用 `craft_capability_get` 读取完整内容。当前 Node 运行时没有 FTS5 时，Craft 在持久化的名称、描述、别名和正文索引上做关键词排序；这里节省的是模型上下文和重复查询成本，首次扫描仍需读取来源文件。v0.9.4 可选接入与关键词结果融合的 OpenAI-compatible 向量召回；未来可接入 Hub 清单增量同步。

## Workflow 与验证

节点声明 `read_only`、`local_write`、`external_write` 或 `destructive`。本次调用没有明确批准的副作用不会执行。路径必须位于指定项目根目录内，命令输出默认脱敏并截断。

确定性验证包括命令退出码、文件存在、JSON 字段和值、覆盖率报告阈值。它们由程序计算；模型不能用一句“已经 100%”覆盖程序结果。主观判断与人工审批后续通过 Judge/Human Adapter 扩展，并保留来源。

## 多 Agent 编排

Plan 是带依赖的有向无环图。Node 指定角色、目标、候选 Agent Profile 和副作用级别。`dispatch` 只领取依赖已通过且并发容量允许的节点；失败时可以切换到下一个 Profile，最终失败会阻塞下游。`submit` 必须引用有效 Lease 并声明 provenance。

v0.6.0 起，Plan 创建时会锁定每个候选 Agent Profile 的精确版本。需要进入评测历史的编排使用 Orchestration Trial：Dispatch、失败换路、Submit、Artifact、Evidence 和成本自动写入 Trace；Plan 到达终态时自动生成回执与 Outcome。普通 Plan 仍可用于不需要评测留痕的临时协调。

Craft 不绕过 Host 的 Sandbox、审批或并发限制，也不直接假定 Codex/Claude 的内部任务 API。插件负责把 Lease 翻译成宿主原生执行，再把真实结果交回 Craft。

v0.9.0 将默认编排变为 Craft Skill 的默认策略，而非要求用户重复固定话术：复杂目标先经 `craft_default_route` 创建 Task、检索少量 Capability、优先选择匹配的 `verified` Workflow；只有已验证 Workflow 才能经 `craft_default_route_execute` 执行并自动形成 Trial/Trace/Outcome。短问答和一次性读取不创建路线。v0.9.1 增加 `craft_default_route_find`：用户用自然语言续接时，只恢复唯一匹配的 `active` Task；最高分并列、没有匹配或已完成任务都不会被猜测性恢复。v0.9.2 仅在同一策略积累至少两条通过且带 Evidence 的路线后，允许 Host 通过 `craft_route_workflow_proposal_create` 写入带溯源的 `draft` Workflow；步骤由 Host 抽象提供，不能复制原始业务文本，且仍需已有 held-out Eval/Signoff Gate 晋级。v0.9.3 增加版本化 Project Policy、结构化 Route Receipt 和 Host Adapter 协议：严格项目会在服务端要求 Git 基线、聚焦测试、覆盖率和 Review 的真实回执；Adapter 只能领取它声明支持的下一安全动作并上报结果，不能绕过 Host 审批。经验候选还会区分通过率、独立 Task 数和 confirmed/bounded Evidence，避免由未验证自述生成草案。
v0.9.4 增加可选的 OpenAI-compatible Embeddings 混合检索：未配置时不发网络请求并保持关键词排序；配置后仅为 Capability 的名称、描述和别名建立与 Provider 指纹、内容摘要绑定的缓存，查询和索引均成功才参与排序。超时、鉴权、格式或维度错误会记录脱敏状态并自动回退关键词结果；向量分数只影响候选召回，不能绕过 Workflow 的验证、Signoff 或 Host 审批。v0.9.5 将已有对象接成受控闭环：Runtime Policy 限制 effect、并发和预算；Runtime Run 绑定精确 Policy 与环境摘要；Operation 支持父子归属、Lease、审批等待、幂等回执和恢复动作。所有子 Operation 的资源费用汇总到根 Run，不把子 Agent 的副作用藏在顶层任务之外。v0.9.6 增加受信任 Host 的确定性 Workflow Driver、DAG 依赖和有限重试/恢复；Driver 只执行服务端签发、明确输入且通过命令/路径/effect 检查的本地安全动作。v0.9.7 以版本化 Runtime Adapter 约束 Agent/Grader 的可领取 kind、Effect、并发和回执；本地 Adapter 不得声明外部或破坏性 Effect。v0.9.8 让经验候选只能经只读 held-out shadow 评测运行，持久化 Promotion 和精确 Signoff 的准备信息；它从不签发发布权限。

v0.9.9 将 Skill、MCP Server/Tool、Workflow、Adapter 和 Grader 纳入本地 Capability Asset Registry，并以可复现的 Activation Profile 与 Tool Selection Receipt 分离发现、激活、授权和调用。默认 `craft-mcp` 仅暴露核心面，`craft-mcp-full` 保留兼容入口；实际启停仍由 Host 决定。首个 `diagnostic_research` Expert 只能创建最多五个只读 Sub-agent，Context Capsule 只保存 Task/Artifact/Evidence 引用，结果必须包含假设、反例、Evidence、置信边界和下一步。评测新增等环境、等预算的重复配对可靠性检验及 Judge 校准；Harness 候选最多改变两个设计轴，须经可靠性、Signoff、Canary 与精确回滚。v0.9.10 新增 Agent-Native Workspace：显式根目录和相对路径形成唯一文件状态边界，Checkpoint 复制普通文件并以摘要比较，人工干预以状态版本记录；恢复必须批准且不能替换根目录。v0.9.11 在其上把 local_write 变成 baseline/commit/approved-rollback 的小事务，并把 passed Trial 生成固定模板的 Workflow/Checkpoint 脚本候选；它不执行任意 TypeScript，只有 exact passed Signoff 可以签发为 verified。执行按风险分级：普通读/规划不强制隔离，macOS/Linux 的本地生成代码写入才启用网络拒绝隔离；外部写入等待审批，无补偿破坏性动作或未接入受信任凭据 Broker 的调用失败关闭。

没有匹配 Workflow 时，Craft 自动创建安全增量研发 Kit：先锁定 Git 基线和原有行为，再最小改动、运行测试/覆盖率、复查 Diff。它是给 Host 的可验证计划，不是假装已经替 Host 修改了代码。`craft_default_route_update` 必须按顺序记录每个已完成阶段的真实 Artifact/Evidence，并把最终 Review 写成 Outcome；Project Policy 设为 `required` 时，更新还必须引用同阶段的通过回执。`craft_default_route_resume` 在跨会话时只返回下一步。带有同一能力组合的路线以 `route_strategy` 作为 Trial Subject，只有两个以上独立 Task 的通过路线且带 confirmed/bounded Evidence 才可生成一个 Workflow 草案，仍不能自动发布或替代 Workflow。

Plan 的 Lease 带 TTL，可由同一 owner 续租；下次 Dispatch 自动回收过期 Lease，且不改变已锁定的 Profile 路由。Submit 支持显式幂等键。Plan 可声明成本预算；实际成本超限后，已完成节点和成本仍会保留，未开始节点被阻断并产生 `budget_exceeded` 的终态原因。

## 受控运行时与评测闭环

Runtime 不直接调用任意宿主私有 API。它签发 `agent`、`workflow` 或 `grader` Operation；Host 只领取已签发且未超出 Runtime Policy 的 Operation，并以 Lease 和真实回执提交结果。`local_write` 等高风险 Effect 可以进入 `awaiting_approval`；批准、拒绝和完成均追加 Trace。Run 保存 Policy 摘要与环境摘要，供晋级时精确比对；控制或环境改变后，历史 Trial 仍可阅读，但不能被冒充为新候选的通过证据。

v0.9.5 的 Eval Runner 会在相同 Suite 分区、相同环境摘要下，对版本化确定性 Workflow 执行 `Case × Subject × N Trial`，自动创建 Trial、Outcome、Evaluation Run 与 Comparison。v0.9.6 增加程序 Grader、按 Case 配对的 baseline/candidate 对比与持久 Promotion Assessment；v0.9.7 将成本指标与 `duration_ms` 分开回归判断，配置阈值却缺少相应指标时拒绝晋级。直接使用 Evaluation Run 晋级 Workflow 必须引用该 Candidate 的 eligible Promotion；Signoff 继续承担模型、人工或业务 Grade 的精确门禁。模型或业务 Agent Subject 不被伪装成已执行：它们必须先作为 Runtime Operation 由兼容 Host 运行并提交 Outcome。线上 Operational Signal 仅保存脱敏数值，基于前后窗口产生可审计漂移告警。v0.9.8 的 Experience Miner 从重复的成功策略和失败模式生成 `proposal_only` 候选，且不复制 Trace 内容；shadow 评测必须是只读 Workflow 的 held-out 对照，Promotion 通过也仅形成指定 Policy 的 Signoff 准备态，不能直接改写 Skill 或 Workflow。

## 从执行经验中改进 Harness

Craft 后续不会把“学习”简化成不断增长的对话摘要，而会把一次执行明确记录为 `Task → Trial → Trace → Outcome`。Harness 配置按六个可诊断面组织：上下文装配、工具与检索、生成预算、编排方式、记忆策略、输出验证。每次变更都应保存配置版本、差异、成本、证据和失败归因。

经验分为两层：具体 Case 的完整执行记录，以及由多个 Case 归纳出的可复用模式。`Experience Pattern` 至少引用两个已完成 Trial 和 Evidence，保存成功策略、失败模式、适用条件及从 Outcome 派生的结果摘要；它不复制 Trace 或创建第二套评测状态。Pattern 可生成版本化 `Skill Proposal`，候选与 Workflow 一样复用既有 held-out Evaluation/Signoff Gate 才能进入 `verified`。

Craft 默认只索引能力 Source。已验证 Proposal 只有在调用方明确批准 `allow_external_write=true` 后，才可写入已存在且位于所选 Source 内的 `SKILL.md`。Publisher 写前校验调用方提供的 SHA-256 摘要，备份原文件，并在原子替换前再次校验；发布和回滚各保存回执。回滚也要求当前文件仍等于已发布摘要，因此不会覆盖用户并发修改。

v0.7.0 已实现 Experience Pattern、Skill Proposal 和受控 Publisher；v0.8.0 会从多个同 Subject、且带 Evidence 的已完成 Trial 自动列出 Experience Candidate，仍须人工补充适用条件后才可创建 Pattern。v0.9.3 记录候选通过率和独立 Task 数，但不把它们伪装成统计显著性。v0.9.4 已实现可选向量召回。v0.9.5 已实现持久 Operation、策略/环境指纹、确定性 Workflow Eval Runner、失败模式候选和数值漂移告警。v0.9.6 已实现受控确定性 Driver、程序 Grader、持久 Promotion Assessment、shadow 实验、按风险选择 Harness 以及 Agent IR 的编译/Lowering。v0.9.8 已将重复成功/失败的脱敏经验候选接入只读 held-out shadow 与 Promotion，但仍不自动生成 Proposal、执行模型/业务 Grader、做统计显著性、发布或线上自适应；这些以及 Kit Registry、远程 Hub 与桌面端仍是后续能力，不能描述为已完成。

## 存储与跨平台

默认根目录是 `~/.craft_data`，可用 `CRAFT_DATA_DIR` 覆盖。配置写入 `config/`，版本化状态写入 `db/craft.db`，其余目录用于可重建索引、日志、备份、缓存和运行时文件。业务项目仅作为读取或明确授权的 Workflow 工作目录，不存放 Craft 内部数据。

所有业务实体按 `(kind, id, version)` 保存；事件流按 Stream 单调递增。写入使用 SQLite 事务和 WAL，配置使用同目录原子替换。

## 当前边界

当前版本已提供 Provider 模式的核心/完整 MCP 路径、Capability Asset Registry、任务/证据、确定性 Workflow、可续接默认编排、受限诊断 Sub-agent、受控确定性 Driver、Runtime Adapter 契约、程序化晋级评测、配对可靠性检查、Agent IR 编译/Lowering、Task Control，以及将一次真实 Host 工作固定为 Task Run Manifest 的受控恢复路径。v0.11.57 进一步把 Fabric、Managed Run、Host Run、Receipt 与再观察串为 `Work Coordinator`；显式工作区仅以摘要 Diff 观察变更；`Autonomy Ladder` 不把人工批准本地写误称为隔离执行；`Agent Eval Lab` 只接纳同环境、同预算且终态再观察后的 Host Attempt。平台 Conformance 可固定 verifier 提交的边界检查，Task Benchmark 可将已观察交付汇聚为 held-out 候选；两者都不等于自动安全执行或业务效果。Codex 与 Claude 插件使用不依赖 `node_modules` 的单文件 MCP bundle。真实容器/Windows 隔离 Adapter、外部短期凭据 Broker、自动模型/业务 Grader 执行、真实业务金标、远程 Hub/A2A、桌面端、预算预估和通用补偿事务是后续增量，不应在文档中被描述成已完成。
