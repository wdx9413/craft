# Craft 文档

本目录以两套文档为主：简洁的产品文档和稍详细的技术方案。README 介绍产品与当前使用方法；研究证据放在独立的 `research/`，仓库外 `TT.md` 是早期讨论记录，不是理解当前产品的前置条件。

**第一次接触 Craft？** 先读 [快速入门（5 分钟）](quickstart.md)：安装、挂载能力目录、接入宿主、跑通一次最小闭环，并附概念地图和最小术语表。

## 产品文档

- [产品概览](product/overview.zh-CN.md)：Craft 解决什么问题、核心闭环和差异点。
- [产品架构](product/architecture.zh-CN.md)：面向各行业的三大支柱、十个模块与三组横向能力；评测在“学习与改进”支柱内。
- [产品路线](product/roadmap.zh-CN.md)：当前、下一阶段与长期方向，以及各阶段验收标准。
- [能力访问、诊断 Expert 与 Sub-agent 规划](product/capability-expert-subagent-plan.zh-CN.md)：v0.9.9 已实现边界、验收与后续项。

## 技术方案

- [技术总览](technical/overview.zh-CN.md)：架构分层、核心对象与模块关系。
- [Capability 与领域 Kit](technical/modules/capability-kit.md)
- [Agent IR](technical/modules/agent-ir.md)
- [Experience / Eval Kernel](technical/modules/experience-eval.md)
- [Workflow / Verification / Signoff](technical/modules/workflow-signoff.md)
- [Runtime 与宿主接入](technical/modules/runtime-integration.md)
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
- [Guided Work](technical/modules/guided-work.md)：用目标、资料引用和显式决策形成可恢复的普通用户工作入口，再进入原有受控启动协议。

## 研究证据

- [工作台用户诉求与行业决策（2026-09-08）](research/workbench-user-needs-2026-09-08.md)：原帖、官方进展、研究边界及对 Craft 的影响；不是市场统计。
- [自适应 Harness 研究基线](research/self-adaptive-harness-closed-loop-2026-09-08.md)：较早版本的研究记录，实施状态以当前模块说明为准。

## 当前实现参考

- [中文架构说明](architecture.zh-CN.md)
- [English architecture](architecture.en.md)

文档区分“已实现接口/机制”“真实链路已验收”和“目标/待实现”。有代码、100% 单元覆盖率、真实平台安全与业务质量是不同证据；本次方案更新不代表新增代码能力。
