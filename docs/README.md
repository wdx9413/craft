# Craft 文档

本目录以两套文档为主：简洁的产品文档和稍详细的技术方案。README 介绍产品与当前使用方法；研究证据放在独立的 `research/`，仓库外 `TT.md` 是早期讨论记录，不是理解当前产品的前置条件。

**第一次接触 Craft？** 先读 [总览：受控 Agent 工作运行时](introduction.zh-CN.md)，再读 [快速入门（5 分钟）](quickstart.md)：安装、挂载能力目录、接入宿主、跑通一次最小闭环，并附概念地图和最小术语表。

## 产品文档

- [产品概览](product/overview.zh-CN.md)：Craft 解决什么问题、核心闭环和差异点。
- [产品架构](product/architecture.zh-CN.md)：面向各行业的三大支柱、十个模块与三组横向能力；评测在“学习与改进”支柱内。
- [产品路线](product/roadmap.zh-CN.md)：当前、下一阶段与长期方向，以及各阶段验收标准。
- [能力访问、诊断 Expert 与 Sub-agent 规划](product/capability-expert-subagent-plan.zh-CN.md)：v0.9.9 已实现边界、验收与后续项。

## 技术方案

- [技术总览](technical/overview.zh-CN.md)：架构分层、核心对象与模块关系。
- [Capability 与领域 Kit](technical/modules/capability-kit.md)
- [Capability Access：上下文、能力选择与短期调用票据](technical/modules/capability-access.md)
- [Verified Execution Fabric](technical/modules/verified-execution-fabric.md)：将 Profile、Host Manifest、Work Loop 与状态再观察收敛为一条可复核执行链。
- [Managed Host Bridge](technical/modules/managed-host-bridge.md)：先验证 Manifest 再启动本地 Host，并把终态回流为状态再观察。
- [Agent IR](technical/modules/agent-ir.md)
- [Experience / Eval Kernel](technical/modules/experience-eval.md)
- [Workflow / Verification / Signoff](technical/modules/workflow-signoff.md)
- [Runtime 与宿主接入](technical/modules/runtime-integration.md)
- [TraeWork / WorkBuddy 宿主适配](technical/modules/host-ecosystem-adapters.md)：可复制的本地 MCP、轻量 Skill 与市场提交边界。
- [Closed-loop Runtime](technical/modules/closed-loop-runtime.md)
- [Agent-Native Workspace 与生成界面](technical/modules/agent-native-workspace.md)
- [沙箱与风险分级执行](technical/modules/execution-policy.md)：现有隔离雏形、平台缺口、Shadow/补偿和安全验收。
- [Transactional Runtime 与 Trajectory Compiler](technical/modules/transactional-runtime.md)：本地事务、脚本交接、分支重放与自动编译目标。
- [上下文与记忆管理](technical/modules/context-memory.md)：CVMM 类比、按需工作集、偏好范围与后台整理目标。
- [控制面安全、资源与长任务护栏](technical/modules/control-plane-guardrails.md)：细粒度变更、凭据与提示注入、挂起恢复、预算、主动触发、GUI 兜底及组织共享边界。
- [Recovery Queue 与受控主动性](technical/modules/recovery-proactive-runtime.md)：恢复工作投影、Worker Lease、过期回收、证据回执和主动执行边界。
- [Provenance 与对象级 Lineage](technical/modules/provenance-lineage.md)：精确版本来源、转换器、Evidence、上下游追溯、环检测和陈旧检查。
- [长任务 Dehydration / Hydration](technical/modules/long-task-hydration.md)：最小状态冻结、恢复前验证、三态恢复、Host Lease 和证据回执。
- [分级自主权与审批控制面](technical/modules/tiered-autonomy.md)：四级自主权、精确授权、多人联签、通知证明与一次性消费。
- [Contract Inference](technical/modules/contract-inference.md)：从多次脱敏观测生成非执行候选，经人工、沙箱和证据 Trial 验证。
- [Capability Canary](technical/modules/capability-canary.md)：稳定分流、双臂最小样本、运行指标与停止/回滚建议。
- [Capability Federation](technical/modules/capability-federation.md)：能力包审查脱敏、独立发布、精确订阅与全局撤销。
- [Hub Sync](technical/modules/hub-sync.md)：Ed25519 签名目录、单调游标、分页增量同步、撤销与本地候选检索。
- [Capability Materialization](technical/modules/capability-materialization.md)：按摘要落地隔离缓存、包安全门禁、人工审查和 candidate 登记。
- [Capability Certification](technical/modules/capability-certification.md)：held-out 评测、逐 Trial 沙箱证据、程序 Grade、Signoff 与原子晋级。
- [Supply-chain Governance](technical/modules/supply-chain-governance.md)：来源停用、目录撤回、摘要漂移和安全公告的持续失效传播与再认证恢复队列。
- [Local Maintenance Worker](technical/modules/local-maintenance-worker.md)：过期 Lease 回收、候选清理、供应链复核、Recovery 投影与单实例心跳。
- [Attention Inbox](technical/modules/attention-inbox.md)：把审批、恢复、后台异常和候选成果投影为统一待处理卡片。
- [Workbench Home](technical/modules/workbench-home.md)：为 CLI、MCP 和未来 UI 组合任务、成果、预算、运行与健康状态。
- [Local Workbench Web](technical/modules/local-workbench-web.md)：只监听本机、令牌保护的首个可见工作台。
- [可插拔能力源与最小默认能力](technical/modules/pluggable-capability-sources.md)：把 Skill、MCP、Registry、专家和未来 A2A Agent 接入同一治理链，同时限制内置 Prompt 负担。
- [受治理能力接入示例](governed-capability-intake.md)：从签名目录到非可执行候选的端到端路径，以及跨宿主边界。
- [Knowledge-bound Work Launch](technical/modules/knowledge-bound-work-launch.md)：把受审核、可复算的 Wiki Context Bundle 固定到真实 Host 任务，并在变化时失败关闭。
- [Knowledge Workbench](technical/modules/knowledge-workbench.md)：在本机 Workbench 中审阅 Claim、Markdown Wiki、Bundle、冲突、评测和知识绑定的工作启动。
- [Wiki Candidate Evaluation Bridge](technical/modules/wiki-candidate-evaluation-bridge.md)：把知识候选的检索质量、held-out 评测、Signoff 和人工发布授权固定为独立且可复核的证据链。
- [Wiki Candidate Publication Package](technical/modules/wiki-candidate-publication-package.md)：把已授权的知识候选固定为可人工导入、可跨宿主审阅的便携包，仍不自动安装或执行。
- [Guided Work](technical/modules/guided-work.md)：用目标、资料引用和显式决策形成可恢复的普通用户工作入口；v0.11.45 已在 Workbench 中提供可见的“目标—资料—决策—结果”流程，再进入原有受控启动协议。
- [Execution Safety Preflight](technical/modules/execution-safety-preflight.md)：把已验证 Sandbox Profile 和 Host 资源上限固定到工作启动，且不夸大为系统级隔离。
- [Local Candidate Import](technical/modules/local-candidate-import.md)：以显式确认、目录边界和不可覆盖写入落地已审核交付包，仍默认不启用。
- [A2A Discovery](technical/modules/a2a-discovery.md)：以不可信、只读 Receipt 发现 HTTPS Agent Card，不委派任务或授予权限。
- [Delivery Control Loop](technical/modules/delivery-control-loop.md)：将终态回执、独立验收、可恢复下一动作、脱敏批量比较和可选平台预检连接为受限闭环。
- [Task Control](technical/modules/task-control.md)：用不可变任务契约把启动、回执、验收、交付和交接收敛为一个可复算的下一安全动作。
- [Tool Plane：通用动词与资源注册表](technical/modules/tool-plane.md)：工具面 O(1)、能力走数据的 syscall 接入面。
- [Model Gateway：声明式模型接入](technical/modules/model-gateway.md)：8 家模型族的声明、分层选择与纯函数请求/响应。
- [Internal Host：Craft 自己跑循环](technical/modules/internal-host.md)：第三个 Host Driver 与六道熔断。
- [Runtime Truth（v0.12.10 基线）](technical/modules/runtime-truth.zh-CN.md)：统一 Trace、Tool Call、SSE、OTLP、压缩和结构化工作笔记。
- [Runtime Completion（v0.12.13）](technical/modules/v01213-runtime-completion.zh-CN.md)：受限 Action Gateway、强制 Acceptance Gate、Worker lease/recovery、Provider fallback 和摘要化 A2A 标准操作。
- [Runtime Completion（v0.12.13）](technical/modules/v01213-runtime-completion.zh-CN.md)：有界动作、独立验收、Durable Worker、Provider fallback 与摘要级 A2A。
- [Project Brain 与 Work Session（v0.12.10）](technical/modules/project-brain-work-session.zh-CN.md)：把目标、资料、决策、任务、成果和可复核上下文固定到项目。
- [Workbench Experience（v0.12.10）](technical/modules/workbench-experience.zh-CN.md)：Trace、成果、Evidence 和下一步的只读体验投影。
- [Long Task Worker（v0.12.10）](technical/modules/long-task-worker.zh-CN.md)：释放进程、事件唤醒、重新验证和新 Host 派发。
- [Continuous Work Runtime（v0.12.12 基线）](technical/modules/v01211-continuous-runtime.zh-CN.md)：统一 Context Manifest、受控 Replay、本地 Runtime Service、Project Bundle、Handoff、反馈、领域评测和成本归因。
- [Verified Autonomous Work（v0.12.12 基线）](technical/modules/v01212-verified-autonomous-work.zh-CN.md)：把动作授权、Host 回执、状态再观察、独立验收、交付门、Handoff 和平台 Conformance 串成单 Agent 主路径。
- [当前能力矩阵](technical/current-capability-matrix.md)：区分已实现、本地实现、需要 Adapter 和尚未开始。
- [v0.12.4 Platform Runtime](technical/modules/platform-runtime-v0124.md)：自主运行、Checkpoint/Resume、能力生命周期、记忆整合、远程互操作和观测导出契约。
- [v0.12.6 通用意图与验收闭环](research/craft-v0.12.6-plan-2026-09-13.md)：统一 GUI、CLI、插件和专家入口的 Task/Acceptance Contract，并将覆盖率作为可插拔验收器。
- [v0.12.7 Trace & Evolution Kernel](research/craft-v0.12.7-trace-evolution-2026-09-13.md)：统一跨 Host Trace、状态观察、反馈信号、回放包和 Trace→Case 进化入口。
- [Asset Envelope、路由与跨模型可比性](technical/modules/asset-routing.md)：三类资产的统一信封、只读路由与跨模型闸门。
- [Task Run、平台 Conformance 与 Benchmark](technical/modules/task-run-benchmark.md)：把一个真实 Host 工作收敛为可恢复运行记录，并以同环境、同预算的交付对照形成受门禁候选。
- [可验证执行与演进平台](technical/modules/evolution-platform.md)：范围内本地写入恢复、Campaign 报告、Evidence Canary 与最小 Harness 推荐。
- [Managed Run 与 Evaluation Lab](technical/modules/managed-run-evaluation-lab.md)：长任务的引用化交接、只读 Shadow、显式 Campaign 槽位与校准 Judge Gate。
- [Agent-Native Workspace Runtime](technical/modules/agent-native-runtime.md)：统一协调 Host 事实链、内容无关状态观察、分级自主权和真实 Attempt 对照评测。
- [可运营评测、企业访问与受控远程协作](technical/modules/operational-evaluation-enterprise-collaboration.md)：reviewed Case 排程、短期企业访问 Ticket 与有单 Agent 基线的只读 A2A 控制面。

## 研究证据

- [工作台用户诉求与行业决策（2026-09-08）](research/workbench-user-needs-2026-09-08.md)：原帖、官方进展、研究边界及对 Craft 的影响；不是市场统计。
- [Agent Runtime / Harness 下一阶段业界调研（2026-09-11）](research/industry-agent-runtime-next-2026-09-11.md)：理想态五个面、N1–N4 切片与真实进展。
- [Agent-Native 运行时理想态调研（2026-09-09）](research/agent-native-runtime-ideal-state-2026-09-09.md)：受限自由、五面架构与不建议现在做的事。
- [v0.11.63 差距分析与迭代方案（2026-09-12）](research/craft-next-version-plan-2026-09-12.md)：工具面分片的依据与实施记录。
- [N1 验收报告（2026-09-12）](research/n1-acceptance-report-2026-09-12.md)：六项验收 40/40 与诚实边界。
- [**v0.12.1 方案（2026-09-13）**](research/craft-v0.12.1-plan-2026-09-13.md)：syscall 工具面、模型网关、内建宿主、资产路由与跨模型可比性的完整方案与依据。
- [**v0.12.2 方案（2026-09-13）**](research/craft-v0.12.2-plan-2026-09-13.md)：真实模型传输、`craft doctor/run` 自主闭环、版本门禁与多宿主发布同步；并列出恢复、Effect Policy、Eval Runner、知识血缘和 A2A 的后续收敛项。
- [**v0.12.3 方案（2026-09-13）**](research/craft-v0.12.3-plan-2026-09-13.md)：syscall 低 token 默认面、显式 dispatch 恢复、多宿主同步与发布验收边界；诚实列出远程 A2A、生产级 checkpoint、真实 Eval Runner 等后续能力。
- [**v0.12.4 方案（2026-09-13）**](research/craft-v0.12.4-plan-2026-09-13.md)：自主运行时、持久 Checkpoint、统一能力生命周期、记忆整合、HTTPS 远程互操作和可导出观测契约；明确真实 OS 沙箱、云端 transport 与多用户服务仍由外部 Adapter 验收。
- [**v0.12.6 方案（2026-09-13）**](research/craft-v0.12.6-plan-2026-09-13.md)：跨 GUI、CLI、插件和专家的通用意图/验收合同，以及低 Token 默认接入边界。
- [自适应 Harness 研究基线](research/self-adaptive-harness-closed-loop-2026-09-08.md)：较早版本的研究记录，实施状态以当前模块说明为准。

## 当前实现参考

- [中文架构说明](architecture.zh-CN.md)
- [English architecture](architecture.en.md)

文档区分“已实现接口/机制”“真实链路已验收”和“目标/待实现”。v0.12.13 的本地接口与测试已实现；真实平台 OS 沙箱、Secret Broker、OTLP 部署、远程 A2A 和多人同步仍须由对应 Adapter 提供独立证明。有代码、100% 单元覆盖率、真实平台安全与业务质量是不同证据。
