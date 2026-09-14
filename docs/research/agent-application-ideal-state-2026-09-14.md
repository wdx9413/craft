# 模型上层 Agent 应用的理想态与 Craft 差距

> as_of: 2026-09-14  
> 调研窗口：优先检索 2026-08-31 至 2026-09-14 的官方发布；窗口不足的运行时、评测和安全结论补充 2026 年一手工程文章或规范。  
> 判断规则：外部“事实”仅来自官方公告、工程文章和开放规范；“对 Craft 的推论”是基于 Craft v0.12.16 已有受控运行时的产品判断，不把厂商产品或客户引述当作普适因果。

## 结论

未来 12–24 个月，强模型会继续吸收规划、工具选择和部分子 Agent 编排；模型上层应用的壁垒将更少来自“多一层 Prompt”，更多来自四种可积累资产：

```text
可复核的工作状态  +  受限而可移植的执行环境
可比较的真实 Outcome + 人机共同维护的控制/交付界面
```

Craft v0.12.16 的方向正确：已具备任务合同、状态再观察、最小能力激活、effect/审批、Runtime Assurance、验收/评测、候选准入，以及受限的 A2A/多 Agent。离理想态的主要距离在于把这些对象接到**真实 Host、真实环境、真实业务 Case 和可理解的工作台**，而不是继续堆 Workflow、向量库或 Agent 数量。

## 近 14 天高价值一手热点

| 日期 | 一手事实 | 对 Craft 的推论 |
| --- | --- | --- |
| 2026-09-10 | [OpenAI Agents API](https://openai.com/index/introducing-the-agents-api/) 将长会话、工具效率、子 Agent 协调、持续运行与可选计算环境作为正式托管 Harness；环境可选托管、自有或合作方 sandbox。 | Provider Harness 应接为可替换的 `Host/Compute Adapter`。Craft 继续拥有 Task、Policy、State、Acceptance、Evidence 与 Outcome；不能把 Provider run 的“completed”直接写成交付成功。 |
| 2026-09-10 | [Google Cloud Developer Plugin](https://cloud.google.com/blog/topics/developers-practitioners/introducing-the-google-cloud-developer-plugin-for-ai-coding-agents) 将 Skill、文档、程序交互组合成可安装 plugin，明确单独管理 Skill 会产生耦合和管理成本。 | Capability 的可交付单位应是版本化、可审计的 **Capability Kit/Pack**，而非给模型暴露成百上千个散工具。Craft 已有 Source/Asset/Profile；下一步是补 Kit 级依赖锁定、兼容性、健康、准入评测和撤销。 |
| 2026-09-09 / 09-01 | [Google Cloud 企业 Agent 平台](https://cloud.google.com/blog/products/ai-machine-learning/google-is-a-leader-in-2026-gartner-magic-quadrant-for-enterprise-ai-assistants) 与 [月度更新](https://cloud.google.com/blog/products/ai-machine-learning/what-google-cloud-announced-in-ai-this-month) 将 Agent Runtime、Agent Identity、成本控制、项目空间、Canvas 和“需要输入/错误/完成”收件箱并列为生产平台能力。 | 产品工作台不只是聊天 UI：它应投影事实、待决策、数据/能力范围、执行状态、成本和交付差异。Craft 当前 Workbench 应优先做这一“控制台”纵切，而不是先做独立桌面壳或通用画布。 |
| 2026-09-06 | [OpenAI 内部研究 Agent 测量](https://openai.com/index/research-acceleration-view-inside-openai/) 显示高并发使用包含下游 subagent；已成功的 4–8 小时任务中，超过一半仍有人工干预。 | 长程系统的核心指标应增加干预率、恢复率、暂停原因、预算和安全事件；“能连续跑”不等于应无人值守。单 Agent 默认与受评测的按需拓扑仍然正确。 |
| 2026-08-27（补充） | [Google DeepMind 双盲 AI 评测试点](https://deepmind.google/blog/piloting-the-worlds-first-double-blind-ai-evaluations/) 用保密计算隔离评测材料与被评模型，降低 benchmark contamination。 | Craft 不必先建设保密计算；但 held-out 至少要具备独立审批/存储边界、Case digest、访问记录、环境/Grader pin 与发布前泄漏检查，不能只是一个可读字段。 |
| 2026-08-22（补充） | [MCP 2026 Roadmap](https://blog.modelcontextprotocol.io/tags/roadmap/) 把 transport/scalability、agent communication、governance maturation 与 enterprise readiness 列为协议演进方向。 | MCP/A2A 是连接与互操作层，不应侵入 Craft 的任务事实、授权和验收模型。Craft 应实现少数 Conformance 过的 Connector，而不是成为所有远程工具的通用透传器。 |
| 2026-07-28（补充） | [MCP 任务与 HTTP 更新](https://blog.modelcontextprotocol.io/posts/2026-07-28/) 引入显式状态 handle、任务扩展、请求级路由与更严格的 OAuth credential 隔离方向。 | Connector 要有协议版本/兼容矩阵；远程 token 应绑定 issuer、Profile、scope 与到期时间，且只能在 Host/Server 都支持对应语义时启用，不能破坏现有 stdio 插件。 |
| 2026-04-15（补充） | [OpenAI Agents SDK 演进](https://openai.com/index/the-next-evolution-of-the-agents-sdk/) 提供 workspace manifest、可替换 sandbox、snapshot/rehydration，并明确分离 Harness 与计算环境可减少凭据暴露和容器丢失风险。 | Workspace Manifest、环境指纹、checkpoint rehydration 和 Adapter Conformance 是稳定的跨模型资产。Craft 不应绑定单一 sandbox 或把本地声明误称为隔离事实。 |
| 2026-04-08（补充） | [Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents) 把 session、harness、sandbox 虚拟化，强调 Harness 编码的模型能力假设会随模型进步变成负担。 | Core 应稳定在 Task/State/Action/Receipt/Outcome/Evidence 的语义；模型、Prompt、模型路由、上下文策略、evaluator 和子 Agent 拓扑都必须是可版本化、可比较、可替换的 Harness 变量。 |
| 2026-01-09（补充） | [Anthropic Agent Evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) 明确评测对象是模型 + Harness + 环境；Outcome 是 Trial 结束时的环境终态，隔离/干净环境是多次 Trial 可比的前提。 | Craft 的自适应只能由真实 State Adapter 和领域 Acceptance 收口。应优先建设脱敏 Case、环境/Grader attestation、paired Campaign 和长期漂移监测，而非根据 Trace 长度或模型自评演进。 |
| 2026-02-18（补充） | [OpenAI Codex App Server](https://openai.com/index/unlocking-the-codex-harness/) 将长生命周期 thread、双向 JSON-RPC、稳定 UI-ready 事件和“需要用户输入时暂停”作为客户端/运行时边界。 | Craft Workbench/插件需要订阅稳定的 `Task/Run/Attention/Receipt/StateDiff` 事件投影；页面不应直接依赖内部 Trace 格式，也不能用轮询聊天文本推断状态。 |

## 12–24 月理想态：五个可替换平面

```text
Human Work Surface ─ 目标、资料、状态差异、待决策、交付、成本与介入
        │
Control & State Plane ─ Task Contract、Workspace事实、审批、检查点、恢复
        │
Capability & Trust Plane ─ Kit/Asset/Profile、来源、身份、scope、health、撤销
        │
Execution Fabric ─ Host/Model/Compute Adapter、Action、Receipt、再观察、补偿
        │
Evaluation & Evolution ─ Case/Grader/Trial、Campaign、Candidate、Signoff、Canary
```

它不是五个独立产品，也不要求 Craft 自建所有执行器。正确关系是：Craft 持有可迁移的控制、状态、证据与评测语义；Host、模型、沙箱、领域系统和远程 Agent 通过可验证 Adapter 接入。

## 差距与优先级

### P0：把已有运行时证明为真实、可靠的工作闭环

1. **真实 Host + State Adapter 垂直切片**：选择一个 Codex Host、一个受控本地工作区、一个研发 Case 和一个文件/视频 Case，完整运行 `prepare → dispatch → receipt → re-observe → acceptance → outcome`。输入、环境、权限、预算或人工编辑漂移都要可恢复且不可复用旧事实。
2. **Runtime Assurance Conformance**：将本地/容器/未来远端 Adapter 的 workspace、网络、凭据、进程/资源、取消清理、环境指纹与恢复能力变成机器可验证的报告；没有报告就只读或拒绝。补充失败注入、容器丢失后的 rehydration 与 `indeterminate` 人工处置。
3. **真实 Eval Campaign 与长期监测**：建设脱敏 development/held-out Case、外部状态 Grader、人工金标校准、同环境等预算的多 Trial 对照；记录质量、成本、时延、干预率、恢复率和安全事件。候选默认可得到 `inconclusive`，不可因单次成功晋级。
4. **可理解的 Human Work Surface**：以事件投影展示状态差异、当前/下一动作、审批、输入漂移、委派、成本、失败与交付验收；支持人类修改目标/文件/参数并生成事实事件。先增加浏览器 E2E 和可访问性/错误态测试，再考虑视觉丰富度。
5. **Capability Kit 的供应链闭环**：为已挂载的 Skill/MCP/Connector 增加 Kit manifest、内容/依赖 digest、最小 operation scope、健康/兼容性 receipt、信任/弃用/撤销与按需 Profile 实验。发现、信任、激活、调用仍必须分离。

### P1：P0 有效果数据后才扩展规模与自治

- **跨 Host / 跨 Compute 可移植性**：统一 Workspace Manifest、Artifact Grant、Checkpoint/Handoff 和 Adapter Conformance；支持 Host/模型/沙箱替换，但不复制底层 Provider 的完整编排器。
- **按需 independent evaluator / Expert / 多 Agent**：拓扑只作为带版本的 Harness Candidate；父任务预算、隔离工作副本、冲突/合并点、独立 Context Capsule 和完整归因是前置条件。
- **受信远程 Capability 与 A2A**：只接通过身份、scope、短期授权、Artifact Grant、协议生命周期与环境 receipt Conformance 的低风险 Adapter；远端结论仍须本地再观察/验收。
- **运营化治理**：项目/组织级成本配额、SLO、并发/容量控制、保留期、告警、异常轨迹暂停与 replay drill。目标是可运营，不是搭建“全自动主管”。

### P2：由领域和 Eval 数据决定是否投资

- **GUI / Computer-use Adapter**：在真实 API 不可得且屏幕/无障碍树可验证时接入；需要截图/DOM 版本、动作回执、页面状态验收和高风险 UI 操作的人审，不能把“看见页面”当作成功。
- **领域 State Adapter / 模拟器**：视频资产、业务数据库、ERP、浏览器或代码仓库各自建立状态、校验器、补偿和测试环境；通用世界模型/MCTS 不替代业务模拟器。
- **可编译的受限自动化**：只把通过评测的、声明式 Action/Script IR 候选编译为可审、可回滚、可复验的资产；不直接运行模型临时生成的任意代码。
- **组织协作与跨设备服务化**：对象存储、组织身份、远程运行、事件流和多租户隔离应在本地/单组织闭环证明价值后建设。

## 明确不做项

- 不默认多 Agent、远程 A2A 或 independent evaluator；它们只是可比较 Harness 变量。
- 不把全部 Skill/MCP、项目记忆或知识图谱塞进上下文；按需 Profile/Kit 才是规模化路径。
- 不将向量、行业标签树、全局知识图谱当成状态或权限真相；它们最多是检索/展示增强。
- 不让 Provider 的托管 Harness、Agent Card、MCP annotation、模型 Judge 或“任务完成”自述绕过 Craft 的 Policy、Receipt、再观察和 Acceptance。
- 不自动写入 Prompt/Skill/Workflow/生产系统；自进化只能生成有范围的 Candidate，并经 Eval、Signoff 和 Canary。
- 不急于做桌面安装包、公网 Agent 市场、复杂视觉 Canvas 或通用世界模型；它们不能弥补真实 Outcome、环境可信性和恢复能力的证据缺口。

## 最小路线建议

下一轮不再按“多加十项能力”推进，而应以一个可量化的 **Verified Work Pilot** 收口：两个脱敏 Case、一个真实 Host、一个已验证写入环境、一个最小 Capability Kit、单 Agent baseline 与一个候选 Profile 的 3–5 次配对 Trial，以及能让用户介入/恢复/验收的浏览器工作台。

只有该 Pilot 能回答“在哪种任务上、为什么值得多花成本、失败时如何恢复”后，P1 的多 Agent、远程 A2A 和跨 Host 扩展才有工程和商业依据。
