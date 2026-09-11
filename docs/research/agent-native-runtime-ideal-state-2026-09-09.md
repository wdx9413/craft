# 面向通用 Agent Runtime 的理想态调研：受限自由，而非行业定制

> as_of: 2026-09-09  
> 范围：模型上层通用应用、Agent-Native Workspace、长程 Agent、持久执行、人工介入、评测、MCP/A2A 互操作。  
> 证据规则：外部事实只引用官方文档、官方工程文章或协议规范；“建议/推论”是结合 Craft 当前模块边界的架构判断，不宣称为行业定论。  
> 非目标：不把行业分类、特定模型提示词或某厂商 Host 写入 Craft 内核；不因本研究直接修改产品行为。

## 结论

未来理想态不是“更会自动编排的万能 Agent”，而是一个**受限自由（bounded agency）的 Agent-Native Workspace & Runtime**：

```text
模型/Agent（可替换的推理者）
        ↓ 在任务合同和能力预算内探索
状态工作台（事实、Artifact、检查点、人工改动）
        ↓ 生成版本化 Action Contract
受控执行面（Policy、审批、隔离、回执、恢复）
        ↓ 形成可比较 Trace / Outcome
信任与演进面（评测、候选、灰度、回滚）
```

这里的“自由”是：模型可针对陌生、复合、会变化的任务自行分解、搜索并选择**已授权的少量能力**，也可请求新的信息、审批或能力；不是允许它自行扩大权限、修改默认 Workflow、把一次成功当成知识，或把模型的完成宣称当作现实完成。

这条路线比“按行业分类 + 每目录一份 Workflow”更通用，也比“只有 Prompt + MCP 聚合”更能支撑长任务、模型替换与可信复用。

## 一、外部一手资料显示的共同收敛点

| 观察 | 一手事实 | 对 Craft 的推论 |
| --- | --- | --- |
| 长任务需要结构化交接，而非无止境累积上下文 | Anthropic 的长程 Harness 将初始化与后续增量工作分开，并用进度文件、特性清单、Git/测试等可读 Artifact 让新会话接续；其同时明确单 Agent 与多 Agent 谁更优仍是开放问题。[Effective harnesses for long-running agents（2025-11-26）](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 将 `Task Contract + Workspace State + Context Capsule + Checkpoint` 做成内核；多 Agent 是可选策略，不能当成默认。 |
| 高质量 Harness 会拆角色，但其复杂度必须被证明值得 | Anthropic 的后续实验采用 planner / generator / evaluator，并强调“先用最简单方案，必要时才增加复杂度”；其案例也说明多 Agent 有成本和延迟。[Harness design for long-running application development（2026-03-24）](https://www.anthropic.com/engineering/harness-design-long-running-apps) | Profile/Expert/子 Agent 是可比较的 Harness 设计轴。默认走单 Agent/最短路径，只有在相同 Case、环境、预算下优于基线时才启用。 |
| 审批必须可暂停、可恢复且在执行前重新校验 | OpenAI Agents SDK 将敏感工具调用变成 interruption，序列化 `RunState` 后可恢复；在等待审批期间仍会在真正执行前运行工具输入检查，畸形参数失败关闭。[Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/) | Approval 不是聊天确认框；它应绑定精确 Action、Policy、参数摘要和过期时间，恢复时再做前置条件/权限检查。 |
| Trace 是调试与比较基础，但不能无边界保存 | OpenAI Agents SDK 将模型生成、工具调用、handoff、guardrail 记录为层级 Trace，并支持自定义导出；其文档也说明零数据留存场景无法使用该 tracing 服务。[Tracing](https://openai.github.io/openai-agents-js/guides/tracing/) | Craft 保留本地、可脱敏、可选择导出的 Trace/Evidence；原始 Payload、秘密和思维链都不是默认长期记忆。 |
| 持久状态应分“当前运行”与“跨任务知识” | LangGraph 区分线程内 checkpoint 与跨线程 store：前者用于 HITL、恢复、time travel、容错，后者用于偏好、事实和共享知识。[Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) | 严格分开 `RunState/WorkspaceState`、情境记录和已验证程序记忆；不能用向量库或聊天历史替代可恢复运行状态。 |
| 人工不只批准/拒绝，还可能更正动作或直接提供状态 | LangGraph HITL 对暂停动作提供 approve、edit、reject、respond 四种结果，并保存图状态以便恢复。[Human-in-the-loop](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop) | 人工改动是第一等 State Event：人可改目标、参数、文件或直接给观察结果；Runtime 应使旧计划失效或重规划，而非继续假装原状态成立。 |
| Agent 评测必须同时看结果与轨迹 | LangSmith 文档将 final response、single step、trajectory 区分；轨迹可做确定性匹配或 LLM Judge，后者更灵活但更不确定。[Agent trajectory evaluations](https://docs.langchain.com/langsmith/trajectory-evals) | 评测对象要包含 Outcome、最少必要动作、越权/无效动作、成本/时延和人工介入；确定性 State/Receipt Grader 优先，Judge 只在校准后参与 Gate。 |
| MCP 解决“接工具”，不解决治理 | MCP 规范把 Host、Client、Server 分离，并明确协议自身无法强制安全；应用仍应提供同意、授权、访问控制和隐私保护。Tool annotation 也只是 hint，不能把不可信 Server 的描述视为安全事实。[MCP Specification](https://modelcontextprotocol.io/specification/2025-06-18/index)；[Tool schema annotations](https://modelcontextprotocol.io/specification/2025-06-18/schema) | Capability Catalog 必须维护来源、digest、信任、健康、effect 与依赖；发现、激活、授权、调用四个状态不能合并。 |
| A2A 解决跨 Agent 任务交接，不等于运行时质量/安全 | A2A 规范定义状态化 Task、Artifact、Agent Card、长任务查询/流式更新及认证；终态 Task 不可重启，并将 MCP 定位为工具/资源互连的互补协议。[A2A Specification](https://a2a-protocol.org/v0.2.5/specification/) | 只预留 A2A Adapter：映射 Task、Artifact、状态和能力声明；不要把远程 Agent Card 或自报能力视为可执行/可信/已评测。 |
| 代码执行可复用会话状态，但隔离是执行环境能力 | Google ADK 的 Agent Runtime Code Execution 为一个任务保持 sandbox 状态，保存变量/文件并在结束时清理；它依赖已创建的 sandbox 与服务账号授权。[ADK Code Execution](https://google.github.io/adk-docs/tools/google-cloud/code-exec-agent-engine/) | Craft 应统一描述隔离、网络、凭据和生命周期，但具体 sandbox 是 Adapter；读/规划任务不应因没有隔离器而不可用，高风险写入才失败关闭。 |

## 二、理想架构：五个深模块

```text
                 ┌────────────────────────────────┐
                 │  1. Task Control Plane          │
                 │  contract / plan / budget       │
                 └───────┬────────────────────────┘
                         │
     ┌───────────────────┼────────────────────┐
     │                   │                    │
┌────▼─────┐      ┌──────▼──────┐      ┌──────▼──────┐
│2. State  │      │3. Capability│      │4. Execution │
│Workspace │      │  Plane      │      │  Plane      │
└────┬─────┘      └──────┬──────┘      └──────┬──────┘
     │                   │                    │
     └───────────────────┴──────────┬─────────┘
                                     │
                            ┌────────▼────────┐
                            │5. Trust &        │
                            │  Evolution Plane │
                            └─────────────────┘
```

### 1. Task Control Plane：任务合同，而不是行业路由

**职责**：把自然语言目标转换为可更新的 `Task Contract`，协调计划、预算、权限、依赖与暂停；不固化行业分类树。

最小字段：

- goal、success criteria、non-goals、constraints；
- workspace / object references；
- allowed effects、预算、截止/重试限制；
- 当前计划、未决假设和待人工决策；
- 关联 Capability Profile、Policy、State Snapshot 与 Evidence。

**关键原则**：行业、任务类型和标签可以是按需生成的语义视图，辅助检索和解释；系统长期保存的是目标、输入输出、动作、Artifact、关系与证据。复合任务用 Task Graph 表达，父任务统筹目标/预算/裁决，子任务只获取最小 Context Capsule。

### 2. State Workspace：事实源与可恢复交接

**职责**：保存“现实中现在是什么状态”，而不是保存冗长对话。

应提供统一的 `State Adapter` 接缝：

- 文件/代码：文件树、Git 基线、测试状态、变更摘要；
- 媒体/生成任务：素材引用、模型/参数、seed、生成 Artifact、评测结果；
- 外部系统：只读快照、版本/ETag、业务对象引用；
- 人工修改：明确的 `HumanStateEvent` 与其影响范围。

每个 Action 之前读取观察状态、检查前置条件；之后记录 Receipt 并重新观察。无法观察或验证的系统只能降低自主权，而不是让模型补全想象中的世界模型。

### 3. Capability Plane：全量发现、少量激活

**职责**：管理 Skill、MCP Server/Tool、Workflow、Script、Adapter、Grader 与远程 Agent 的逻辑资产。

它的内核模型应是：

```text
Source / Origin → logical Asset → immutable Revision
                         ↓
                 Activation Profile（本任务最小集合）
                         ↓
               Authorization / issued call_id → Invocation
```

- 多目录、软链接、镜像带来的重复应在 `logical Asset` 层基于真实路径、内容 digest 和显式优先级去重，不能让用户靠禁用 Source 管理；
- 所有 Asset 可索引，只有小规模、可解释的 Activation Profile 暴露给 Host/模型；
- MCP/远程 Agent 自报 `readOnly`、`idempotent` 等属性只能作候选信息，真正的 effect 由 Craft Policy、Adapter 与本地证据决定；
- `Workflow` 是参数化模板；只有可证明重复成功的路线才能提升为全局或工作区 scope，目录本身不是 Workflow。

### 4. Execution Plane：动作合同、可控自由与渐进自主权

**职责**：把模型提议变成一个可拒绝、可回执、可恢复的 `Action Contract`。

```text
observe → propose action → authorize → (approve if needed)
       → execute through adapter → receipt → observe/verify → checkpoint
```

每个 Action 至少包含：输入引用、前置条件、effect、资源预算、幂等键、预期 Artifact、适用 Policy、审批状态、补偿/人工处置方式与过期时间。

建议将自由度做成可比较的**自治阶梯**，而不是一个“自动/手动”开关：

| 等级 | 可做的事 | 默认保障 |
| --- | --- | --- |
| A0 观察 | 检索、读文件、规划、生成草稿 | 最小 Profile、脱敏 Trace |
| A1 受控本地写 | 在已声明工作区中改文件/生成 Artifact | precondition、Checkpoint、测试/差异验证 |
| A2 可补偿外部写 | 通过明确 Adapter 写入可回滚或幂等的外部系统 | 精确审批、Receipt、补偿链 |
| A3 高风险/不可逆 | 删除、发布、付费、生产变更等 | 默认阻断或必须人工最终执行 |

这也解释了沙箱的边界：不是所有任务都必须在本地沙箱运行；对读、研究、计划应保持可移植性。只有 A1 以上且存在代码/文件/网络风险时，要求有足够能力的 Adapter；没有满足策略的 Adapter 就拒绝该动作，不回退到“裸执行”。

### 5. Trust & Evolution Plane：只让被证明的经验影响未来

**职责**：将任务运行与长期复用分层，而不是把每条对话写进“记忆”。

```text
RunState（当前任务）
  → Episodic Record（一次成功/失败及证据）
  → Candidate（假设 + 变更 diff + 适用条件）
  → Eval / Signoff / Canary
  → Program Memory（Workflow / Script / Pack 的精确版本）
```

候选只允许改变有限、可归因的设计轴，例如 Capability Profile、上下文模板、验证步骤、是否启用 Expert。每次变更都要有 baseline、同环境/同 Case/等预算 Trial、质量/成本/时延/安全/人工介入比较；缺条件则结果为 `inconclusive`。生产 Trace 只能脱敏采样、人工审核后变成 development Case，不能直接污染 held-out 或触发发布。

## 三、“相对可控，但有自由度”的产品原则

1. **控制约束动作，不替模型规定所有步骤。** 模型可在 Contract 内规划和探索；Policy 只约束 effect、数据边界、预算、审批和验证门。
2. **允许请求扩权，不允许静默扩权。** 找不到合适能力时，模型产出请求与理由；Host/用户决定是否安装、激活或批准。
3. **默认最小 Harness，可证后升级。** 单 Agent 优先；检索、Expert、子 Agent、脚本化和更高并发均是可测的增量，不是“越多越强”。
4. **系统存事实，分类只是投影。** 不建固定行业树；根据目标、对象、动作、Artifact 和关系检索，领域聚类/说明随时间可重建、可纠正、可过期。
5. **模型、Host、执行器可替换；状态和证据不可丢。** 任何模型/Host 只需实现 Adapter 协议，就能领取已签发 Action、提交 Receipt、恢复 Run；Craft 保有中立记录。
6. **评价最终环境，不评价模型自信。** 任何“完成”都需 Observation / Artifact / Grader / 人工确认中至少一种可追溯证据。

## 四、必须明确解耦：稳定 Session / State 与可变 Harness

这是理想态最重要、也最容易被混淆的边界。

```text
稳定的任务事实层                     可变的推理/执行层
Task Contract                         model / prompt / tool-selection policy
Workspace / Artifact references       single agent / planner / evaluator / sub-agent
Action / Approval / Receipt           context strategy / retry strategy / profile
Outcome / Evidence / ownership        workflow candidate / script candidate
```

**为什么要解耦。** Anthropic 的长程 Harness 以外部可读的进度/特性/测试 Artifact 跨越新会话，而不是依赖某次上下文压缩；LangGraph 将 thread checkpoint 与跨线程 store 分开；OpenAI 的 HITL 将 `RunState` 序列化后再恢复。这三类设计都说明：可恢复性依赖显式状态，而不依赖“同一个模型还记得”。[Anthropic long-running harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) · [OpenAI HITL](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)

**Craft 的规则。**

- Session/Run 只保存任务事实、指针、已批准的决策和可恢复状态；聊天历史是可选输入，不是状态真相。
- Harness 的模型、Prompt、Profile、Capability revision、工作流/状态 schema 必须冻结在 Run/Action 上；新版本只影响新 Run 或经过显式迁移的恢复。
- 若候选 Harness 改变了 Context Capsule、工具集合或计划拓扑，不能改写正在运行的 Task；只能生成新 revision，并在 shadow/canary 中验证。
- 任何恢复都以最后一个已提交 Receipt/State Snapshot 为起点；checkpoint 可以帮助重跑，但不是对外部世界已经发生过什么的证明。外部副作用需要幂等键、Receipt 和重观察。

此边界还解决供应商锁定：模型、Codex/Claude Host、沙箱和远程 Agent 可以逐步替换；Task、Artifact、Receipt、Evidence 和权限决策保持中立、可读、可迁移。

## 五、何时增加 Evaluator 或 Multi-agent

不要把角色数当能力等级。增加一个角色至少应能解释它补上的失败模式，并在既定评测中抵消额外成本。

| 条件 | 建议 | 不应据此增加 |
| --- | --- | --- |
| 目标清晰、动作少、可用确定性验证 | 单 Agent + 最小 Capability Profile | “看起来专业”或希望多一层总结 |
| 存在独立、可操作的质量标准，且生成者自评出现系统性偏差 | 增加独立 Evaluator；其输入是 Artifact/Receipt/Contract，不是只看生成者总结 | 仅为了复述或给模型自身打分 |
| 子问题可并行、输入边界清楚、父任务能裁决冲突，且共享预算仍有收益 | 增加限定数量的只读 Expert/Sub-agent；统一根 Task 预算与取消 | 将完整对话/全部工具复制给每个子 Agent |
| 任务跨多个长会话、状态经常漂移 | 先补 Context Capsule、Checkpoint、State Adapter 和恢复验证 | 用更多 Agent 来掩盖状态不清 |
| 计划、模型、工具或子 Agent 组合存在争议 | 将其作为 Harness candidate，做同环境、同 Case、等预算比较 | 基于 Demo、单次成功或主观偏好直接默认启用 |

这与 Anthropic 的结论一致：多 Agent 的效果仍应被实测；其有价值的案例依赖将评估标准外化、让 evaluator 基于实际运行产物反馈，而非“再调用一个 LLM”。[Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)

## 六、控制不能只靠 HITL：从逐次点击到环境边界

逐工具审批适合不确定、高风险或早期上线阶段，但持续要求用户点确认会产生批准疲劳。Anthropic 的 sandbox/containment 文章将控制重心转向文件系统、网络出口和凭据边界；MCP 规范也要求 Host 具备真实的同意、授权与访问控制，而不是信任 Tool 描述。[Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing) · [MCP specification](https://modelcontextprotocol.io/specification/2025-06-18/index)

因此 Craft 的边界应是分层的：

1. **预先限制环境**：工作区根、可写路径、网络出口、可见 Artifact、短期 scoped credential、并发与成本。
2. **动作级硬闸**：版本化 Policy、Action Contract、pre/post-condition、effect、幂等与 Receipt；不得由 Prompt 或远端 Tool annotation 绕过。
3. **例外走人工**：不在允许域、不可逆、涉及支付/生产/个人数据、前置条件失效、或不确定性超阈值时暂停，让人 approve/edit/reject/respond。
4. **执行后再验证**：审批通过不等于操作成功；须从目标系统、Artifact 或确定性 Grader 获得 Receipt/Observation。

这正是“相对可控、有一定自由度”：把模型的探索空间放进经过限制、可观察、可回滚或可人工处置的环境，而不是不断缩小它的计划空间。

## 七、对 Craft 的优先级建议

Craft 当前已有 `WorkspaceState`、受控 Runtime、Trial/Trace/Outcome、Proposal/Signoff、Local Adapter 与 trajectory/script handoff 的基础（具体边界见现有技术文档）。为避免重复造轮子，建议下一阶段只补以下 P0：

### P0：把已有能力闭合为同一运行语义

1. **Task Contract + State Adapter 协议**：将目标、成功条件、观察状态、人工更正和前后条件链接到 Runtime Operation；先提供文件/代码 Adapter，媒体与远程系统只定义接缝。
2. **Capability Catalog / Activation Profile**：逻辑去重、多来源优先级、按需激活、Profile Receipt、`call_id` 绑定授权，直接解决“Skill/MCP 太多”。
3. **Lifecycle Reconciler**：原子/幂等地闭合 Task、Route、Run、Trial、Outcome、Artifact、Evidence；崩溃恢复和孤儿状态审计。
4. **Action Contract 扩展**：明确 pre/post-condition、idempotency、effect、审批、补偿/人工处置；审批恢复时二次验证。
5. **Artifact 数据治理**：内容寻址、版本谱系、大小上限、脱敏、引用有效性和导出策略，避免把命令全文与敏感输入无界写入主存储。

### P1：让“自由度”成为可比较的配置

1. 将单 Agent、检索、`diagnostic_research` Expert、子 Agent 及未来脚本运行表示为最少的 Harness 设计轴；同环境、同 Case、等预算比较。
2. 建立状态/回执优先的 Grader，模型 Judge 必须版本化、人工金标校准；未校准只出诊断。
3. 候选只在 shadow/held-out 对照后进入 Signoff；Canary 监控质量、成本、安全与环境指纹回归，并精确回滚。
4. 为远程 MCP/A2A 建 `Adapter`，但不将互操作、Agent Card 或模型供应商信息误当作信任、授权和质量 Gate。

### P2：在真实数据之后再做

- 自适应选择器：先用可解释规则和可比较历史选择最小 Profile；探索仅 shadow/canary；
- 受审核线上反馈：脱敏采样、去重、人工标注、不可变分区；
- Capability Kit Registry：来源/签名/digest/依赖锁定/弃用与健康；
- 图形 Canvas、远程 Hub、A2A 市场、复杂多 Agent 拓扑。

## 八、明确不建议现在做的事

- 固定行业/岗位分类作为数据骨架；
- 一目录一 Workflow 或一客户一套核心控制流；
- 以向量相似度、MCP 注释或模型自述直接授权执行；
- 为所有任务默认启动多个 Expert/Sub-agent；
- 用一次成功、单个 LLM Judge 或线上告警自动改 Prompt/Skill/Workflow；
- 把通用“世界模型”当作前置条件。应先为可观察对象接 State Adapter，未知世界则降低自主权；
- 将本地文件 Checkpoint 宣称为外部系统的完整事务回滚；外部写入需要明确 Adapter、幂等/补偿/人工处置。

## 九、可验证的理想态验收

1. 同一 Task Contract + Workspace/Policy/Capability revision 输入，生成相同 Activation Profile 与选择回执。
2. Task 被人工修改或恢复后，后续 Action 可追溯到新的 State Snapshot；旧前置条件不再可被静默复用。
3. 模型无法调用未签发、过期、跨 Profile 或 effect 越权的能力；无隔离能力时只拒绝高风险写入，不影响 A0 任务。
4. 任一终态 Outcome 都能追溯至真实 Receipt/Observation/Artifact；无法验证时明确为 `bounded` 或 `unverified`。
5. 单 Agent 与任意多 Agent/Expert Profile 能在同一环境、同一 Case、等预算下比较；不可比时不输出胜负。
6. 候选无法绕过 shadow、Signoff、Canary；出现质量、成本、安全或环境回归时能定位到精确版本并停止/回滚。
7. 更换 Codex、Claude、模型供应商或未来 A2A Host 后，Task/State/Artifact/Evidence 仍可读取与恢复；差异仅在 Adapter 能力边界。

## 参考来源

- OpenAI Agents SDK：[Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)、[Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)、[Guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/)
- OpenAI：[A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
- Anthropic：[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)、[Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- LangChain：[LangGraph Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[Human-in-the-loop](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop)、[Trajectory evaluations](https://docs.langchain.com/langsmith/trajectory-evals)
- 协议：[MCP Specification（2025-06-18）](https://modelcontextprotocol.io/specification/2025-06-18/index)、[A2A Specification](https://a2a-protocol.org/v0.2.5/specification/)
- Google ADK：[Agent Runtime Code Execution](https://google.github.io/adk-docs/tools/google-cloud/code-exec-agent-engine/)、[Agents CLI evaluation workflow](https://google.github.io/agents-cli/guide/hands-on-tutorial/)
