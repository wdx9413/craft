# Agent Runtime / Harness 下一阶段业界调研

> as_of: 2026-09-11  
> 范围：模型上层 Agent Runtime/Harness、Agent-Native Workspace、持久执行与人工介入、能力/工具治理、评测与受控自进化、多 Agent 的适用边界。  
> 证据规则：外部事实只引用协议、厂商官方文档/工程文章或原始论文；“Craft 建议”是基于当前仓库文档的工程判断，不把厂商路线当作必然结论。  
> 读取基线：`docs/product/roadmap.zh-CN.md` 标注当前基线为 v0.11.41；本记录不修改代码或产品配置。

## 结论

下一代上层应用的共同形态，不是固定行业流程树，也不是把更多 Agent、Skill、MCP 一次性塞给模型，而是一个**稳定控制面 + 可替换 Harness/Host/Sandbox + 可验证状态工作区**。

```text
稳定：Task / Workspace State / Action / Receipt / Evidence / Outcome
可变：模型 / Prompt / 单或多 Agent / Capability Profile / Sandbox / Host
```

模型应在受限的任务合同内自由规划、检索、尝试和请求扩权；系统应只允许经策略与真实回执约束的动作改变状态。只有经对照评测的候选才可以影响以后默认的 Profile、Workflow 或脚本。

这个判断与 Craft 的定位一致，但“内核对象已很多”不等于“真实闭环已跑通”。当前最大的缺口不是再增加一个 Expert 或 Workflow，而是将已有对象统一接到**真实 Host 执行、状态再观察、领域验收与可比较评测**这条链路。

## 一、近 6 个月一手资料的信号

| 信号 | 一手事实 | 对 Craft 的含义 |
| --- | --- | --- |
| Harness 会随模型能力而过时 | Anthropic 将 session、harness、sandbox 解耦，理由是 Harness 编码的模型能力假设会失效；其目标是让接口比具体实现活得更久。[Scaling Managed Agents（2026-04-08）](https://www.anthropic.com/engineering/managed-agents) | 固定 Task、Action、Receipt、Artifact、Evidence 的语义；把模型、Prompt、规划器、Expert 拓扑视作可版本化和可替换的 Subject。不要把当前“最佳 Prompt/多 Agent 结构”写入核心。 |
| 长任务靠外部结构化状态，不只靠上下文压缩 | Anthropic 报告长任务跨会话仍是开放问题；其有效做法是初始化环境、每轮增量工作，并留下进度与版本控制等可读 Artifact。其文中也明确 compaction 本身不足。[Effective harnesses for long-running agents（2025-11-26）](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | `Task Contract + Workspace Snapshot + Context Capsule + Checkpoint` 必须成为 Host 无关的恢复基线；聊天摘要不能作为状态真相。 |
| 多 Agent 能提升上限，但成本很高且不应默认 | Anthropic 在一项长程全栈实验中使用 planner/generator/evaluator；同时强调要逐项移除 Harness 组件，因模型变强后原先必要的构件可能变为负担。该实验的完整 Harness 比单 Agent 显著更贵。[Harness design for long-running application development（2026-03-24）](https://www.anthropic.com/engineering/harness-design-long-running-apps) | 单 Agent + 最小 Capability Profile 应为默认。Expert/子 Agent/评估者只在可比较 Case、同环境和等预算下证明净收益后启用。 |
| 并行 Agent 需要独立工作区和显式协调 | Anthropic 的 16 Agent 编译器实验让每个 Agent 在独立容器工作副本中提交，并以任务锁避免做同一件事；文章也明确要求在容器中运行，而非宿主机器。[Building a C compiler with a team of parallel Claudes（2026-02-05）](https://www.anthropic.com/engineering/building-c-compiler) | 真正的写入型多 Agent 不应建立在共享目录与自然语言协调上。先提供 Task Graph、对象版本/ChangeSet、工作区隔离、冲突与合并门；否则仅保留只读 Expert。 |
| Runtime 正在与计算环境解耦 | OpenAI 的更新 Agents SDK 将可配置 workspace Manifest、sandbox、snapshot/rehydration 与可选多个隔离环境放入运行时，并明确将 harness 与 compute 分离以降低凭据暴露和容器丢失导致的运行丢失。[The next evolution of the Agents SDK（2026-04-15）](https://openai.com/index/the-next-evolution-of-the-agents-sdk/) | Craft 应保持 Sandbox Adapter 与 Workspace Manifest/State Adapter 的抽象，不自己绑定某个沙箱厂商；写入任务的恢复以持久状态和 Receipt 为准，不以“原容器仍在”假定成功。 |
| 审批与 AI 分类器不是安全根 | Anthropic 的 Auto Mode 工程文说明逐项批准会产生批准疲劳，输入/输出分类器只构成纵深防御，不能替代隔离边界。[How we built Claude Code auto mode（2026-03-25）](https://www.anthropic.com/engineering/claude-code-auto-mode) | 将低风险自动化建立在确定性 Policy、工作区、网络和凭据边界上；模型/分类器只用于建议风险与减少不必要打断，拒绝或连续异常应进入可恢复人工处理。 |
| Tool 输出也应视为不可信输入 | Anthropic 的 containment 工程文章将工具、文件和网络都视为可能承载攻击的边界，并指出已审计的 connector 不代表其读取的数据可信。[How we contain Claude（2026-05-25）](https://www.anthropic.com/engineering/how-we-contain-claude) | Capability 来源/签名与一次调用返回的数据都要分开处理：后者进入 Context 前需脱敏、限制、标识不可信，不能因工具“verified”而被当成指令。 |
| 评测对象是“模型 + Harness + 环境” | Anthropic 将 Task、Trial、Trace、Outcome、Harness、Eval Suite 分开；尤其强调 Outcome 是环境终态，而非 Agent 的“我已完成”。多次 Trial 用于对抗模型随机性。[Demystifying evals for AI agents（2026-01-09）](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Craft 已有 Trial/Trace/Outcome/Signoff 基础，应优先导入真实脱敏 Case 与环境验证器，做 Candidate/Baseline 重复对照；不能只以单测覆盖或 Host 退出码宣传业务提升。 |
| 线上评测需要与开发评测可比较 | Google 的 Agent Platform 将开发与上线后实际任务放在同一评测引擎；其同时保留程序/LLM Judge、环境模拟器和生产 Trace 的持续评测/漂移告警。[Agent and Model Evaluations ... GA（2026-07-31）](https://developers.googleblog.com/agent-and-model-evaluations-in-gemini-enterprise-agent-platform-are-now-ga/) | 最终要有脱敏离线 Suite、shadow/Canary 及线上监控，但先建立相同 Metric/Grader 版本的离线闭环。线上原始数据不得直接触发发布或污染 held-out。 |
| 协议互操作不等于能力可信 | MCP 的 OAuth 规范要求资源绑定、受众验证、最小 scope 与运行时 scope challenge；MCP 的安全讨论也明确 tool annotation 是风险词汇/提示，不是可执行安全证明。[MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) · [Tool annotations as risk vocabulary（2026-03-16）](https://blog.modelcontextprotocol.io/tags/security/) | MCP/A2A/Card/Skill 元数据只能进入 Discovery；信任、effect、健康、凭据和执行授权须由 Craft Policy、Adapter 证据与一次性授权独立决定。 |
| 异步 MCP Task 不应取代系统任务模型 | MCP 的 2026-07-28 RC/Tasks draft 以 tool 调用返回 task handle，再由客户端查询、更新或取消；草案提示 task ID 可能等同 bearer token，所有 Task 请求仍须鉴权。[MCP Tasks RC（2026-07-28）](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) · [Tasks draft](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks) | 将外部 Task 映射为 Craft Operation/Receipt Adapter；Craft 自己继续拥有跨 Host 的 Task、Run、权限和 Evidence 生命周期。句柄必须绑定主体/会话，不能作为可枚举全局 ID。 |
| 真实世界需要“渐进自主权”，不是二元批准 | Anthropic 对数百万交互的研究显示，经验用户会更常开启自动批准，但也更常中断；复杂任务中 Agent 主动澄清的次数可超过用户中断。其结论是需要上线后的监控与人机共同管理自主权的新交互。[Measuring AI agent autonomy in practice（2026-02-18）](https://www.anthropic.com/news/measuring-agent-autonomy) | 将自主权做成 Policy 的可观测阶梯：只读、受控本地写、可补偿外部写、高风险阻断；同时把“主动暂停、请求澄清、人工编辑状态”做成一等事件。 |

## 二、未来理想态：受限自由的五个深模块

```text
Task Control ─────── goal / constraints / budget / approvals / task graph
       │
State Workspace ─── observed state / artifacts / versions / human edits
       │
Capability Plane ── logical assets / minimal activation / provenance / cost
       │
Action Gateway ──── preconditions / policy / execution / receipt / re-observe
       │
Trust & Evolution ─ eval / episodic record / candidate / canary / rollback
```

### 1. Task Control：任务合同而非行业分类

长期保存目标、成功条件、非目标、预算、风险、未决问题、工作对象引用与已批准决策。行业标签、任务类别和领域聚类可以是可重建的检索/展示视图，但不应成为固定主数据或强制路由条件。复合任务用 Task Graph 表达依赖；只有有清晰输入输出和父任务裁决规则的节点才值得并行。

### 2. State Workspace：观察到的世界才是事实

应统一表达：`预期状态 → Action → Receipt → 再观察到的状态`。文件/代码、媒体素材与生成物、数据库/业务对象都通过 State Adapter 接入。人类直接改文件、参数或目标时产生 `HumanStateEvent`，使依赖旧版本的计划/结果进入复核或重规划；不能继续沿用模型的旧叙述。

### 3. Capability Plane：发现全量，激活极少

正确对象层次是：`Source/Origin → Logical Asset → immutable Revision → Activation Plan/Profile → Authorization → Invocation/Receipt`。它同时解决多目录/镜像去重和工具过多问题：保留来源与优先级，但仅向当前 Host 交付有预算、理由、版本和 scope 的少量材料。Workflow 是参数化、可证的模板；目录不是 Workflow，单次路线不是 Workflow。

### 4. Action Gateway：控制动作，不限制思考

模型可提议多个方案、dry-run 或请求额外能力；真正改变状态的动作必须有版本化契约：目标、输入引用、前置条件、effect、允许范围、幂等键、资源上限、预期 Artifact、验证器、补偿或人工处置、TTL。执行后以 Adapter 的 Receipt 和目标系统/Artifact 再观察收口。对无法观察、补偿或隔离的高风险动作，降级自主权或拒绝。

### 5. Trust & Evolution：经验要分层

```text
RunState                 当前任务，不是长期记忆
Episodic Record          一次成功/失败、环境指纹、证据与适用范围
Candidate                有限设计轴的假设和 diff
Program Memory           通过 Eval/Signoff/Canary 的 Workflow/Script/Pack 精确版本
```

“总结成功做法”最多生成 Candidate；只能在 shadow/held-out 后进入 Signoff 和 Canary，且要能精确停用/回滚。不要让原始对话、未审核生产 Trace 或未验证模型结论直接变成默认 Prompt/Skill。

## 三、当前 Craft 与理想态的差距

以下是根据当前产品/技术文档的实现边界，不是对运行时效果的断言。

| 优先级 | 已有基础 | 关键缺口 | 为什么先做 |
| --- | --- | --- | --- |
| P0 | Source Mount、Logical Capability、Context Profile、Activation Plan、受控 Host Dispatch 已分模块存在 | **统一能力生命周期**：Logical Capability/Activation Plan 尚未与既有 Capability Asset 信任、effect、健康、发布链统一；Task Graph 也尚未进入执行生命周期 | 否则“选中的内容”“可信可执行的能力”“Host 实际执行了什么”仍可能是三套记录，无法端到端审计或最小激活。 |
| P0 | Workspace/Checkpoint、ActionPatch、Run/Wait/Lease、Host Driver 与 Outcome 已有协议 | **单 Agent 的真实状态—动作闭环**：将 Task Contract、对象版本、前后条件、Host Dispatch、Receipt、再观察、领域验收原子串联；恢复时统一进行版本/权限/输入复核 | 这是长期运行、人工插入与准确 Outcome 的前提，比先做默认多 Agent 更重要。 |
| P0 | Docker Sandbox Adapter、Preflight、Execution Policy、Credential/Egress 内核已有 | **真实可用的写入环境矩阵**：为当前支持平台完成沙箱 Conformance、取消清理、凭据隔离、网络出口与工作区边界的真实验证；不满足时明确降级/拒绝 | 当前文档已明确不应把 helper/profile 宣称为系统级隔离。真实写入开放必须先有可复验环境证据。 |
| P0 | Trial/Trace/Outcome、Acceptance Plan、若干文件/覆盖率/媒体检查器、Signoff/Canary 协议已存在 | **真实任务评测闭环**：建设脱敏研发与视频两个首批 Case/Suite，固定环境与验收指标，比较 baseline/candidate；引入少量人工金标校准和线上只读监控 | 单元测试 100% 只证明 Craft 机制；不能证明对用户工作质量、人工返工、恢复率、成本的净收益。 |
| P1 | Workbench Brief/Launch/Run、Artifact/Evidence、Wiki/Context Compiler 基础已有 | **普通用户的端到端项目体验**：从“目标 + 资料 + 必要决策”到运行、暂停、修正、验收、交付，展示对象差异、实际动作、费用、等待与可恢复入口 | 目前能力较多但入口仍偏技术协议。产品价值需要在一个完整真实任务上被用户理解与验证。 |
| P1 | 只读 Expert、Task Graph、Context Capsule、预算/租约/ChangeSet 基础已有 | **受评测的并行/子 Agent 扩展**：先让只读研究/独立验收成为可比较配置；写入型子 Agent 必须使用隔离工作副本、任务锁/对象冲突、合并和父预算 | 业界显示多 Agent 是上限手段而非默认。没有隔离和冲突治理时会放大错误面。 |
| P2 | Federation、Hub Sync、Candidate Delivery、A2A Discovery 已有本地/只读基础 | **远程来源与组织协作 Adapter**：先提供只读 registry health、签名/撤销、透明审计和显式 materialization；随后才是 A2A Task 执行 | 互操作解决发现和传递，不解决安全、权限、质量。过早做网络市场会扩大供应链和身份治理面。 |

## 四、建议的下一阶段切片

### N1：统一“计划到真实结果”的单 Agent 垂直切片（最优先）

目标不是新增大模块，而是将现有模块接成一个可信主路径：

```text
Guided Brief / Task Contract
  → Context Profile + Activation Plan（统一到 Asset Revision）
  → Safety Preflight + 一次性 Action Authorization
  → Host Dispatch
  → Receipt + Workspace/State 再观察
  → Acceptance Job / Human confirmation
  → Outcome + Evidence + 可恢复 Checkpoint
```

验收：选择一个研发任务和一个视频/文件任务；中途人工修改、Host 中断、审批过期和输入漂移均能如实进入重新规划/人工处理；不得把进程完成当交付完成。

### N2：真实 Eval 与 Harness 配置比较

- 固定至少两个真实但脱敏的任务域、Case 版本、环境指纹、成本/时延与验收器版本；
- 比较 `minimal single-agent` 与一个增量 Harness（如检索 Profile 或独立 evaluator）；
- 多 Trial、held-out、人工金标校准，输出 `eligible/rejected/inconclusive`；
- 再将线上脱敏 Trace 作为人工审核后的 development Case，统一 Metric 版本做漂移观察。

验收：明确得到“哪项 Harness 在什么任务、环境与预算下有收益”，而不是只得到更丰富的 Trace。

### N3：把写入型自动化建立在已验证的 Sandbox 上

- Sandbox Manifest/Workspace/Network/Credential 边界与可验证 Receipt 对齐；
- 对 Windows/macOS/Linux 分别声明已验证与拒绝的能力，不能以一个平台的测试替代其他平台；
- 先执行白名单 Action/Script IR，再考虑模型生成脚本；生成脚本必须先成为静态、可审、可评测 Candidate，不能 `eval`。

验收：每一类允许写入的动作都有可证明的路径边界、取消行为和失败处理；任何不满足 Conformance 的后端无法领取 Ticket。

### N4：在 N1-N3 有数据后再开多 Agent / 远程协作

只读 Expert、独立 Evaluator、并行子任务、A2A delegation 都作为受评测的 Harness 变体；使用最小 Context Capsule、父预算、精确状态/Artifact 引用和明确合并点。达到收益阈值才进入推荐 Profile。

## 五、不应作为近期主线的事

- 固定行业标签树或全局知识图谱：先保存带版本的任务事实、对象、Artifact、关系和 Evidence；分类/聚类是可重建视图。
- 每个目录复制 Workflow：使用参数化的全局模板与工作区条件；只有重复成功且有证据的特殊流程才创建 scoped revision。
- 默认启动多 Agent：没有独立失败模式、并行边界和比较结果时，它只会增加 token、时延、冲突和权限面。
- “自动自进化”：只能有 Candidate 搜索和受控发布；不可让一次成功、用户点击接受或未审核生产日志改变默认行为。
- 直接运行模型生成的任意 Python/TypeScript：先走 Action/Script IR、Sandbox Ticket、静态审查、Eval、Signoff 与适用性检查。
- 先做远程 Hub/A2A 商店：供应链、身份、撤回、凭据和组织数据治理未闭合前，扩大接入面不会提升可用性。

## 六、对未来 12–24 个月的推断

这是基于上述一手信号的推断，而非事实承诺：

1. **模型能力提升会压缩固定 Harness。** 复杂 role-play、冗长 planning 和固定上下文重置会不断被更强模型淘汰；持久状态、动作边界、证据与评测仍会保留，因为它们描述的是外部世界而非模型能力。
2. **竞争点会从“会不会调用工具”转为“能否在真实状态中连续、可审计地完成工作”。** Provider 会提供更多 Agent loop、沙箱和多 Agent 基元；Craft 的差异应是跨 Host 的任务状态、权限、Evidence、评测与复用中立层。
3. **通用应用会以 Capability/Domain Kit 和 State Adapter 扩展，而非行业分支。** 视频、研发、销售等只替换对象、验证器和外部连接；内核继续复用版本、动作、Receipt、预算与验收。
4. **渐进自主权和后部署监控会成为产品能力，而非合规附属项。** 最终体验应让用户逐步扩大可信范围，同时在漂移、超预算、低置信或环境变化时自动降级到观察、请求澄清或人工批准。

## 可执行的优先级结论

**先做 N1 + N2，再做 N3；N4 只在有真实收益数据后启动。**

这条顺序能把 Craft 从“能力治理与协议很完整”推进到“普通用户能可靠完成、恢复、验证一项真实工作”；也保持模型、宿主、行业和未来 Capability 市场的可替换性。
