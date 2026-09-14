# Agent-Native Capability Platform：一次性定义可实现边界

> as_of: 2026-09-14  
> 目的：为 Craft 定义一个可在若干大版本内完成、可被真实验证的产品边界。它避免把“理想态”误解为无限扩展的 Agent 功能清单。  
> 证据规则：外部事实只引用厂商一手工程文章或开放协议；对 Craft 的结论均为基于 v0.12.17 基线与 v0.12.18 实施的架构推论。  
> 非目标：本文不承诺业务效果，也不把 Provider 的托管能力、协议标准或本地测试等同于生产部署。

## 一句话结论

Craft 的理想态不应是“万能 Agent 平台”或“插件市场”，而是一个 **Agent-Native Capability Platform**：

```text
稳定的事实、权限、回执、验收和评测内核
        +
按需解析、可版本化、可撤销、可跨宿主发布的 Capability Kit
        +
可替换的 Host / Model / Compute / State / Evaluator Adapter
```

因此，**不是每个模块都插件化**；应做到“每个可变能力都有受限扩展点，而所有跨能力的不变量留在内核”。这既能支持 Codex Plugin、Skill、MCP、CLI、Serena 和未来远程 Adapter，又不会让插件绕过事实链或安全 Gate。

## 一手资料的共同结论

| 一手事实 | 对产品边界的意义 |
| --- | --- |
| [OpenAI Agents API（2026-09-10）](https://openai.com/index/introducing-the-agents-api/) 将 Harness、长会话、按需 Tool Search、代码化工具调用、可选子 Agent 与可选择 Sandbox 作为分离能力；开发者仍拥有工具、知识、环境与 UX。 | Harness/模型供应商不是系统事实源。Craft 应持有 Task、Policy、State、Acceptance、Evidence 与 Outcome；Provider/Host 只是可替换执行面。 |
| [Anthropic Managed Agents（2026-04-08）](https://www.anthropic.com/engineering/managed-agents) 将 Session、Harness、Sandbox 虚拟为独立接口；持久事件日志位于 Harness 之外，Sandbox 可按需重建，凭据不进入生成代码环境。 | 固定的核心对象应是 Session/Task、事件、工作状态、授权和回执；Prompt、上下文策略、模型、Sandbox 与子 Agent 拓扑必须是可替换变量。 |
| [Anthropic Agent Evals（2026-01-09）](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) 将评测对象定义为“模型 + Harness + 环境”，并以 Trial 结束时环境中的实际结果判定 Outcome。 | 自进化必须比较完整的可复现实验单元，不能根据模型自述、Trace 长度或单次成功直接升级。 |
| [Google Harness Engineering](https://developers.googleblog.com/the-anatomy-of-harness-engineering-how-to-evaluate-iterate-and-guard-ai-coding-agents/) 将评估、迭代、护栏作为 Harness 工程的连续闭环。 | Capability Kit 的发布不只是安装；必须有 conformance、eval、版本比较、准入、撤销与可回滚。 |
| [MCP 规范](https://modelcontextprotocol.io/specification/2025-11-25) 定义 Client/Server 的上下文与工具互操作，不定义应用的业务验收、权限策略或最终状态。 | MCP 是 Connector/调用协议，不应成为 Craft 的任务事实、权限和交付验收模型。 |
| [A2A 规范](https://a2a-protocol.org/dev/specification/) 规范 Agent Card、Task、Artifact 与生命周期的互操作。 | A2A 只能作为远程 Delegation Adapter；远端身份、权限、Artifact scope、本地再观察和验收仍需 Craft 自己保证。 |

## 目标架构：五平面、一个内核、四类扩展

```text
Human Work Surface
  目标、状态差异、待审批、交付、成本、失败和人工介入
        │
Control & State Kernel
  Task Contract / Workspace State / Policy / Event / Receipt / Outcome
        │
Capability & Trust Plane
  Kit / Asset / Profile / Source / Trust / Health / Revocation
        │
Execution Plane
  Host / Model / Sandbox / Tool / State / Credential Adapter
        │
Evaluation & Evolution Plane
  Case / Grader / Trial / Campaign / Candidate / Signoff / Canary
```

### 必须留在内核的东西

以下对象一旦各自插件化，就会出现“插件给自己授权、插件宣布自己成功、插件覆盖别的插件事实”的循环信任问题，因此必须由 Craft 内核拥有版本和写入权：

- Task Contract、Run、Checkpoint、State Snapshot、Human State Event；
- effect Policy、审批、授权票据、预算、凭据引用和撤销；
- Receipt、Evidence、Acceptance、Outcome 及不可变事件序列；
- Kit 的来源验证、依赖锁、兼容性判定、健康/弃用/撤销传播；
- Trial、Case 分区、Grader 校准、Signoff、Canary、精确回滚；
- 跨 Host 的 Conformance Fixture 与失败关闭语义。

内核可以很小，但不可省略。它的职责不是替模型做推理，而是把“模型提议”与“事实成立”分开。

### 可以插件化的四类扩展

| 扩展种类 | 可提供的能力 | 禁止的能力 |
| --- | --- | --- |
| **Capability Kit** | 领域对象、Skill/操作描述、依赖、效果声明、验证器、评测样例、文档与 UI 声明。 | 安装即执行、直接修改事实库、绕过 Profile/Policy。 |
| **Runtime Adapter** | Codex/Claude Host、MCP、Serena、文件/代码树、Sandbox、Secret Broker、领域系统、Grader。 | 把外部 `completed` 当作 Craft Outcome，或自行扩大 scope。 |
| **Harness Contribution** | 意图增强、澄清建议、计划候选、上下文装配、Evaluator/Expert 拓扑候选。 | 直接写 Prompt/Workflow 默认值，或自动启用多 Agent。 |
| **Presentation/Distribution Adapter** | Codex Plugin、Skill、MCP、CLI/SDK、Workbench 卡片。 | 为同一业务逻辑复制四套独立实现。 |

建议以 **Kit 是唯一交付单元，Adapter 是 Kit 的入口实现，Skill/MCP/CLI 是 Kit 的外部表面** 为原则。一个 Kit 的功能应只实现一次；不同表面只转换输入、展示和授权上下文。

## 统一的最小工作循环

用户所说的“意图 → 澄清 → 执行 → 埋点”是正确骨架，但还必须补入激活、再观察和验收，才能抵抗复合错误与状态漂移：

```text
Intent
  → Clarify（仅在影响范围、权限、验收或风险存在实质歧义时）
  → Activate（最小 Kit / Asset / Context Profile）
  → Preflight（版本、环境、预算、授权）
  → Execute（Host/Adapter）
  → Re-observe（Receipt + State Snapshot）
  → Accept（Artifact/Evidence → Outcome）
  → Instrument & Evaluate（指标、Trial、Checkpoint）
  → Learn（仅生成 Candidate，走 shadow/signoff/canary）
```

这是一个**条件化状态机**，不是所有任务强制走九步：纯读取任务通常跳过写入预检、恢复和 Campaign；无歧义任务跳过 Clarify；尚无足够样本时 Learn 只记录候选而不发布。系统应避免把流程文档暴露给用户；用户只看到目标、必要问题、当前动作、待决策和验收结果。

Kit 的 Hook 也只能落在这些受控阶段：`intent.enrich`、`clarify.propose`、`plan.propose`、`activation.resolve`、`preflight.check`、`execute.adapter`、`observe.snapshot`、`accept.evaluate`、`instrument.emit`、`learn.propose`。所有 Hook 接收脱敏 Context Capsule，返回类型化 Proposal 或 Receipt；只有内核校验后才能形成事实事件。

## v0.12.17 基线与 v0.12.18 实施映射

| 目标能力 | Craft 当前映射 | 尚缺的闭环 |
| --- | --- | --- |
| 控制与状态内核 | `VerifiedWorkLoopKernel`、Task Control、Workspace/State Snapshot、Execution Fabric、Runtime Assurance、Assured Pilot。 | 跨 Host 的标准事件/恢复 Conformance；更广的 State Adapter。 |
| 最小能力激活 | Capability Source/Asset、Logical Capability、`CapabilityAccessKernel`、Activation Profile、Connector ticket、Host Activation Manifest；v0.12.18 已加入 Kit Manifest、Registry、精确依赖、Conformance、Task Activation 和 disable/revoke 传播。 | 兼容性 Migration、签名远端 Registry 与真实 Host 安装仍待部署 Adapter。 |
| 外部来源 | `CapabilityConnectorKernel` 已覆盖内置、GitHub/火山 Skill、stdio/HTTPS MCP 和只读 Serena 元数据。 | 实际 Host 安装/启停、身份与凭据 Broker、协议兼容矩阵和受控远端执行。 |
| 可验证执行 | Host Bridge、Receipt、再观察、独立 Acceptance、Effect Policy、Readiness/Recovery/Assurance。 | 至少一个真实 Host + 一个真实写环境的端到端 Conformance 证据；平台化隔离器。 |
| 评测与进化 | Trial/Trace/Outcome、Campaign、Signoff、Canary、Assured Pilot、受限 Candidate。 | 长期脱敏 Case 维护、金标/Grader 校准、线上遥测与漂移/成本运营。 |
| 多 Agent/A2A | 默认单 Agent；只读 Expert/Sub-agent、Harness Candidate、A2A/Federated Delegation。 | 以真实 Eval 证明净收益后再做可写协作；远端身份、Artifact 内容存储与执行 Adapter。 |
| 对外使用面 | 默认 Core MCP、完整 MCP、CLI、Codex Plugin/Skill 与 Workbench 投影已存在基础；v0.12.18 新增同一 Kit 的 Skill/MCP/CLI/Plugin descriptor 与 CLI/核心面验证。 | 由同一 Kit 自动生成发布包的 SDK、脚手架和跨宿主兼容性测试。 |

该映射意味着下一步不该重新发明 Task、Workflow、Memory 或 A2A，而是把已有深 Module 收敛到统一扩展契约，并证明真实垂直闭环。

## 一次性可实现范围：Capability Platform v1

所谓“一次性做完”应指**一次性完成可扩展的平台边界**，而非宣称实现所有领域 Agent。建议将下列内容定义为同一大版本的 Definition of Done：

1. **Kit Manifest v1 与本地 Registry**：固定 `id/version/digest/compatibility/depends_on/provides/effects/data_scope/config_schema/healthcheck/eval_suite`；安装、禁用、升级、撤销和依赖漂移都有确定性状态与迁移策略。
2. **受限 Kit Runtime**：按上节 Hook 运行；插件仅提交 Proposal/Receipt，不能直写 Store；所有执行仍必须被 Activation Profile、Policy 和一次性 ticket 绑定。
3. **Kit Conformance Suite**：统一 fixture 覆盖只读、越权拒绝、版本/依赖漂移、取消/恢复、敏感文本不入库、Receipt 与再观察不一致、撤销传播。没有通过的 Kit 只能发现，不能进入 Profile。
4. **统一发布面**：提供 Kit SDK/CLI，以同一 Manifest 生成或验证 Codex Plugin、`SKILL.md`、MCP descriptor 和 CLI command；Core MCP 保持少量通用 syscall，按需 `describe`，不默认扩张工具列表。
5. **两条样板纵切**：将“只读 Serena Project Knowledge Kit”和“本地文件/代码工作区 Kit”完整接入，从注册、选择、执行/观察、验收到评测各跑一条真实脱敏 Case。
6. **一个真实 Host Conformance**：至少 Codex 或 CLI 之一证明 `prepare → dispatch → receipt → re-observe → acceptance → outcome → resume`；人工改文件、审批过期、Host 中断和输入漂移均需可复现处理。
7. **最小 Eval 与运营面**：两个 development Case、一个独立 held-out Case、baseline/候选各 3–5 次等环境 Trial；展示质量、成本、时延、干预率、恢复率和安全拒绝，不满足证据时统一为 `inconclusive`。

完成这些项目后，Craft 就具备“任何新能力都能以同一治理方式接入”的平台能力。之后的 Video Kit、企业 Adapter、Computer Use、远程 A2A 或多 Agent 都是受评测扩展，而不是改动核心概念。

## 明确延后，防止功能无限膨胀

- 不做静态行业标签树、全局知识图谱或按文件夹复制 Workflow；它们可作为 Kit 的可选检索/展示层，不能成为事实、路由或权限来源。
- 不默认多 Agent、独立 Evaluator、MCTS/世界模型或直接执行模型临时生成脚本；它们应作为一个最多改变两个 Harness 设计轴的 Candidate。
- 不把 Serena 的 LSP/重构实现复制进 Craft；Serena 是一个可按需启用的 Project Knowledge/代码理解 Adapter。
- 不做公网 Plugin Marketplace、自动安装依赖、任意第三方代码加载、生产凭据托管或跨组织远程写入；这些必须在本地 Kit Runtime 和真实 Eval 证明后，另行建设签名、隔离、身份、合规和商业运营。
- 不因 Provider 具备托管 Sandbox/Session/子 Agent 就重复实现同一底层服务；Craft 保持 Provider/Host 可替换，并只验证它们提供的事实。

## 可判定的“接近理想态”标准

当且仅当以下问题都能以运行证据回答，才可说 Craft 已完成其**平台理想态 v1**：

1. 新 Kit 能否不改 Core 即接入、验证、禁用和撤销？
2. 同一 Kit 能否从 Codex Plugin、Skill、MCP、CLI 访问而不复制业务安全逻辑？
3. 任一动作能否说明其 Task、范围、授权、精确版本、Receipt、状态再观察、验收与失败处置？
4. 人工修改、环境/权限/能力漂移、Host 中断后，系统能否停止旧计划、恢复或重规划而不重用旧事实？
5. 引入一个能力、子 Agent 或新 Harness 后，是否能用真实 Outcome、等预算、重复 Trial 证明它值得成为默认？

若答案仍只是“模型效果看起来不错”或“插件安装成功”，则尚未达到这一边界。反之，满足这些标准后再增加能力，系统会保持可控和可组合，而不会每次迭代都重新发现一整套缺口。
