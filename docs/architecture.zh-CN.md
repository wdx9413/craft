# Craft 架构

[简体中文](architecture.zh-CN.md) | [English](architecture.en.md)

## 产品边界

Craft 的产品目标是面向各行业的人机共同数字工作台；本页记录现有 Agent Harness 内核及版本演进。Codex、Claude Code、DeepSeek Harness、未来桌面端或自建程序都可以成为 Host 或 Client。

完整目标见 [三大支柱与十个模块](product/architecture.zh-CN.md)，后续取舍见 [路线](product/roadmap.zh-CN.md)。评测属于“学习与改进”支柱，沙箱属于“执行与保障”。历史章节中的隔离描述不得解释为已完成安全认证；当前实际缺口见 [沙箱与执行策略](technical/modules/execution-policy.md)。

## 概念关系：Agent、Harness、Runtime、Context 与 State

这些词不是同一层的同义词。Craft 采用下面的稳定关系：

```text
Agent = Model + Harness
Harness = Context + Tool + Permission + Environment
Environment = Sandbox + Runtime

Goal
  ↓ 澄清并固化
Target + Task Contract + Acceptance
  ↓ 生成或选择
Plan（Step 列表、依赖、预算、effect）
  ↓ 由 Harness 组织
Context Resolution + Capability Activation + Permission Preflight
  ↓ 运行在
Environment（Sandbox + Runtime）
  ↓ 交给
Host（Codex / Claude / CLI / API / Fixture）
  ↓ 每个 Step 都要
Action → Receipt → State Re-observation → Accept
  ↓ 汇总
Outcome → Trace / Evaluation / Candidate
```

- `Agent = Model + Harness`。模型负责理解与提议；Harness 负责把提议变成有边界的行动循环。
- `Harness = Context + Tool + Permission + Environment`。Context 是受限输入，Tool 是动作面，Permission 是策略边界，Environment 是执行地点和生命周期。
- `Environment = Sandbox + Runtime`。Sandbox 解决隔离，Runtime 解决持久执行、租约、回执、检查点、取消与恢复；没有可验证隔离器时，高风险动作失败关闭。
- `Tool` 可以来自 Skill、MCP、插件、Workflow、检索器或 Host Adapter，但只有登记为受治理 Capability Asset 并经过 Activation 后才是当前可调用 Tool。
- `Context` 是给模型/Host 的受限投影，不是事实存储；知识、记忆、经验和 state 只有被解析后才进入上下文。
- `State` 分为 Control State（Task/Run/Operation/Lease/Checkpoint）和 World State（Workspace/Artifact/外部状态摘要）；模型上下文可以引用 State，但不拥有 State。
- `Host` 是真实执行者。Codex App 的插件模式默认复用当前 embedded Host，不会隐式启动第二个 Codex CLI；独立 Agent 模式才由 Craft 选择模型和 Host。
- `Hook` 是挂在生命周期时点的扩展 seam，例如激活前、执行前、回执后、再观察后和验收前。它可以观察、补充证据或阻断，但不能替代 Tool、Permission、Receipt 或 Acceptance，也不能绕过主流程扩大副作用。

因此，Craft 的目标不是再做一个聊天壳，而是提供一套共享 Control Plane、Runtime 和证据模型的工作运行时。

## 两种入口与单点能力

产品保持“两扇入口、一套事实账本”：

| 入口 | 默认路径 | 适用边界 |
| --- | --- | --- |
| 完整 Craft / Codex 控制台 | `Goal → Clarify → Activate → Preflight → Host → Observe → Accept → Learn` | 写入、交付、长任务、跨会话恢复、需要证据的工作 |
| 单点 MCP/Skill/插件 | 读取、受管写入或候选操作直接调用相应组件；发布和外部 effect 仍回到 Control Plane | `craft-knowledge`、`craft-memory`、`craft-experience` |

单点能力可以被 Codex、Claude、IDE 或独立 Agent 使用，但不能复制一套 Store、Policy、Trace 或 Eval。它们共享相同的 `data_space`、来源摘要、Receipt 和权限边界；当操作产生副作用或需要发布时，必须回到 `VerifiedWorkLoop`。

## 对话、目标与计划模式

主流程不是把所有输入都当成长期任务，而是根据交互模式选择最小路径：

```text
普通对话（turn）
  → Context Resolution（可选）
  → 回复 / 追问

目标任务（goal）
  → 澄清 Goal
  → 固化 Target + Task Contract + Acceptance
  → 生成/选择 Plan
  → 执行 Step
  → 再观察并 Accept
  → Outcome / Learn

计划审查（plan）
  → 只生成或修改 Plan，不执行副作用

验证审查（verify）
  → 只检查 Step/Target 的 State、Artifact 和 Evidence
```

`Goal` 是用户想要的结果，`Target` 是经过澄清的对象、范围和期望终态，`Plan` 是如何完成，`Step` 是可观察的最小动作，`Accept` 是如何证明完成。只有在目标任务、执行、验证或学习模式需要持久状态时才建立 Task Run；普通对话不必被强行包装成 Workflow。

## 五层主链与三类评测

全流程按五个逻辑平面组织：`Control`（Goal/Task/Policy/Budget）、`Context`（Knowledge/Memory/Experience/Resolution）、`Capability`（Asset/Activation/Connector）、`Execution`（Runtime/Host/State/Receipt）和 `Trust`（Acceptance/Evaluation/Signoff/Evolution）。这五层是职责边界，不要求五个独立进程。

每个可独立暴露的能力都要有自己的 `Evaluation Contract`，至少覆盖：

1. **机制与契约**：输入校验、scope/effect、版本/摘要、MCP 工具面和失败关闭；
2. **Fixture 与阶段集成**：确定性样例、漂移/重试/幂等、敏感泄漏、真实 Receipt 与上游/下游契约；
3. **Host/业务准入**：真实 Host 或脱敏业务 Case 的 Outcome、成本/时延、恢复率、回归和可复用性。

状态只能逐级升级：`mechanism_passed → fixture_passed → host_verified → business_eligible → routeable`。组件握手、单元覆盖率和一次成功都不能越级成为 `routeable`。

## 框架：harness 与 context 的分解

全站反复用到的分解方式，先写在这里，避免每次重新推导：

```text
agent       = model + harness
harness     = context + tool + permission + environment
environment = sandbox + runtime
context     = history + knowledge + memory + experience + state
```

这里的 `state` 是“可被当前任务引用的 State Projection”，不是把 Control State 或 Workspace 全量塞进上下文；Context 仍然是预算化、可重建的投影，事实主键、版本和变更留在 Runtime/Store。这样既保留五成员的产品解释，又避免把 Context 误当成第二套状态账本。

`hook` 仍是流程中的正交时点，不属于四个组成面；它回答“在流程的哪一刻触发”，而不是“Agent 依赖什么”。其中 `knowledge`、`memory`、`experience` 通常以 Capability Adapter 接入，`history` 多由 Host 提供，`state` 由 Runtime/Workspace 产生并只以受限投影进入 Context。Hook 也不应成为隐藏的第五条主流程。

五个上下文成员**各由谁持有、门槛是什么、`state` 具体存什么**，见 [上下文的五个成员](technical/modules/context-members.md)；其中 `history`（宿主提供）与 `state`（当前任务）**不是**可插拔成员，只有三个累积型成员可以是能力。能力如何在进程内声明并装配，见 [Capability 扩展协议](technical/modules/capability-protocol.md)。这两个问题与“MCP 暴露哪些工具面”是不同层：MCP 是对外协议，能力契约是内部协议。

已决定、不应重新争论的取舍见 [决策记录（ADR）](adr/README.md)。

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

v0.12.16 为可选的远端协作增加 `FederatedDelegationKernel`：只有健康、精确 Card 版本、已审核信任关系和父 Task Run 都一致时，才签发一次性的只读 `Delegation Grant` 与派生 `Artifact Grant`；远端超时进入 `indeterminate`，不会猜测成功。`HarnessTopologyKernel` 保持单 primary 为默认，仅允许经同环境、等预算评测证明净收益的最多五个只读角色参与路由。真实 HTTP、凭据、回调、远端隔离和组织身份仍由显式 Adapter 负责；缺失这些运行时事实时，`RuntimeReadinessKernel` 会返回阻断项而不是放宽执行。

v0.12.17 增加 `AssuredPilotKernel` 作为证据收口：它不复制 held-out Case 正文，只用 `Sealed Evaluation Case / Access` 固定外部读取权限；并把已验证的 Host Receipt、Readiness、Recovery Drill 与精确 Capability Profile 组合为 Pilot。Pilot 重新评估时会检查 Task Run/环境、能力版本、Case 摘要与 Work Loop 人工失效，任一漂移进入 `needs_replan`。这使评测样本与执行事实相连，但不把本地数据模型夸大为企业级密封存储、真实隔离或生产成功。

v0.12.18 增加 `CapabilityKitRuntime`，把可变供给面与不可变控制面分开：Manifest 精确固定 Kit、依赖、effect、数据范围、入口、Hook、健康检查和评测套件；Registry、Conformance、Activation、Contribution 与撤销形成唯一生命周期。Kit 只能在已声明阶段提交摘要化提议或回执，不能加载任意代码、直接写 Craft 事实、获取凭据或扩大权限。Skill、MCP、CLI 和插件只是同一 Kit 的投影；核心 MCP 仅暴露查询与描述，安装/撤销等管理动作保留 Full 面。

v0.12.19 用 `KnowledgeSource`、`MemoryLedger` 与 `ContextResolutionReceipt` 收敛外部知识、可撤销记忆和模型上下文：外部正文仍归 Serena、kefu、Wiki 或项目文件所有，Craft 只固定来源/信任/版本/装配事实。相同内核可投影为 Codex 等 Host 的控制台模式或模型无关的 Agent 模式计划；两者都必须走 Policy、State、Receipt、Acceptance、Eval 与受限演进。

v0.12.32 将这些模块收敛为 Runtime Assurance & Learning Loop。Trace Review 负责从不可变事件链定位首错和根因；Memory Maintenance 负责 Light/Review/Deep 三阶段候选提炼；两者只提供诊断与候选，不绕过 Acceptance、Evaluation、Signoff、Canary 和回滚。新增 `RuntimeProofKernel` 将 manifest、probe、conformance、attestation 和 checkpoint rehydrate 统一为执行环境证明；新增 owner-scoped `McpTaskKernel`，在异步工作前持久化 Task，支持 TTL、input_required、取消、幂等和过期。SQLite 是本地事实源，正文和外部归档仍通过可替换 Adapter 管理。

v0.12.20 用 `ContinualHarnessView → Refinement → bounded Session activation / governed promotion` 连接运行与学习，并以通用 `StatefulComputeHost → Session → Dispatch → Receipt` 支持持久状态和函数式只读委派。该层只提供控制协议，不绑定第三方 Agent，不把后台进程当沙箱，也不允许复盘越过评测直接修改全局资产。

v0.12.21 将上述能力收口到 `VerifiedWorkLoop` 唯一公开门面，并增加 `UncertaintyPolicy → Resolution → optional Adjudication` 和 `ReferencePilot → 5× paired Qualification → Platform Assessment`。自动化只可提升求证强度，不能提升权限；机制验收与真实业务效果分别记录，证据不足时明确返回 `inconclusive`。

v0.12.36 的完整 `craft` 插件是组合根；`craft-knowledge`、`craft-memory`、`craft-experience` 是唯一独立安装投影。它们复用稳定 Component SDK/MCP/Bundle 契约而不是私有源码；旧 Context、Skill Quality、Workflow Evolution 和 Workflow DAG 仅保留迁移读取。Execution Host 分为 `embedded`、`managed`、`remote`；Codex/Claude 插件模式默认复用当前宿主，不启动第二个 CLI。

v0.12.23 增加 `VerificationPlane` 深模块。它位于开发变更与既有执行/评测模块之间：调用方只提交无正文 Change 描述，模块按风险生成 Contract、确定性端到端、状态机、对抗、恢复、Host Conformance、Eval 与 Release Qualification 检查；回执必须绑定同一环境与 Evidence。它不新增命令执行入口，也不把测试通过误写为业务价值证明。详见 [Verification Plane](technical/modules/verification-plane.md)。

v0.12.24 增加 secret-free `EvaluationModelProfile` 与 `WorkflowEvolution` 深模块。前者的 Profile/Ticket 只固定 Provider、精确模型、预算、用途、环境变量名和输入/输出引用；默认网络关闭，真实调用仍由 Host/Adapter 负责。后者仅接收独立、脱敏且 Evidence-backed 的执行观察，限制 Candidate 至多两个设计轴，并只创建新的 `draft` Workflow；既有 Eval、Signoff、Canary 与 rollback 是唯一晋级路径。`verified` 后才可回流 Capability Discovery，草案不能被默认路由。关键词、向量及未来检索器也是可替换、需单点评测的 Adapter，不能替代 KnowledgeSource、MemoryLedger 和 Context Receipt 的事实边界。

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

知识与记忆正文写入 `knowledge/md/`、`memory/md/` 的版本化 Markdown；对应的 `knowledge/knowledge.db`、`memory/memory.db` 保存可重建域索引，主 SQLite 继续保存跨域生命周期事务。正文带 `craft.content.v1` frontmatter 与 SHA-256 摘要，引用读取会校验路径、版本和摘要。旧 `content/` 正文或内联正文可通过显式 `craft_content_migrate` 做备份、dry-run、幂等迁移，漂移或敏感内容会失败关闭。

所有业务实体按 `(kind, id, version)` 保存；事件流按 Stream 单调递增。写入使用 SQLite 事务和 WAL，配置使用同目录原子替换。

## 当前边界

当前版本已提供 Provider 模式的核心/完整 MCP 路径、Capability Asset Registry、任务/证据、确定性 Workflow、可续接默认编排、受限诊断 Sub-agent、受控确定性 Driver、Runtime Adapter 契约、程序化晋级评测、配对可靠性检查、Agent IR 编译/Lowering、Task Control，以及将一次真实 Host 工作固定为 Task Run Manifest 的受控恢复路径。`Work Coordinator` 将 Fabric、Managed Run、Host Run、Receipt 与再观察串为可恢复事实链；显式工作区仅以摘要 Diff 观察变更；`Autonomy Ladder` 不把人工批准本地写误称为隔离执行；`Agent Eval Lab` 只接纳同环境、同预算且终态再观察后的 Host Attempt。v0.12.13 进一步加入有界 Action Gateway、独立 Acceptance Gate、Durable Worker 租约/恢复、Provider fallback，以及 HTTPS-only 摘要级 A2A message/task 入口；standalone CLI 在独立验收前保持 `needs_review`，不把 Host 自述写成成功 Outcome。详见[Runtime Completion](technical/modules/v01213-runtime-completion.zh-CN.md)。真实容器/Windows 隔离 Adapter、外部短期凭据 Broker、自动模型/业务 Grader 执行、真实业务金标、远程 Hub/A2A 传输、桌面端、预算预估和通用补偿事务仍是部署边界，不应在文档中被描述成已完成。
