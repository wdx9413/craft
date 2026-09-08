# Craft 文档

本目录分为两套文档。README 只介绍产品和安装；研究过程、竞品材料与历史决策保留在仓库外的 `TT.md`，不再混入用户文档。

## 产品文档

- [产品概览](product/overview.zh-CN.md)：Craft 解决什么问题、核心闭环和差异点。
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
- [风险分级执行](technical/modules/execution-policy.md)

## 当前实现参考

- [中文架构说明](architecture.zh-CN.md)
- [English architecture](architecture.en.md)

文档中的能力统一标记为“已实现”“正在建设”或“方向”，避免把设计目标写成当前功能。
