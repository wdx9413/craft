# Capability 与领域 Kit

## 职责

Capability Catalog 发现、索引和按需读取 Skill 等能力资产。Capability Design Kit 是长期模块，类似领域“设计包”，组合能力、Artifact Schema、Validator、Policy、Eval Suite、兼容矩阵和示例。

## 关系

- 被 Agent IR 引用，提供可用 Operation 与约束。
- 被 Workflow 装配，提供实际步骤和验证器。
- 被 Experience/Eval 以精确版本作为评测 Subject。
- 由 Runtime Adapter 转成宿主可理解的 Skill、MCP Tool 或 Plugin。

## 边界

v0.9.9 的本地 Capability Asset Registry 已可登记 Skill、MCP Server/Tool、Workflow、Adapter、Validator、Grader 和 Eval Suite 的来源摘要、版本、依赖、信任、health、effect、凭据要求与成本提示。`Activation Profile` 只选择健康且 trusted/verified、权限匹配且不需要未配置凭据的最小集合；`Tool Selection Receipt` 记录候选、过滤理由、Profile 精确版本和授权边界。

发现、激活、授权、调用是四件不同的事：Craft 不替 Host 修改 MCP 配置；调用必须消费绑定 Profile 且会过期的 `call_id`。这是一套本地资产注册表，不是远程 Hub、依赖自动安装器或领域 Kit 编排器。v0.9.4 的可选向量检索仍只负责候选召回，不能承担权限或质量判断。

关联：[Agent IR](agent-ir.md) · [Experience/Eval](experience-eval.md) · [Runtime 接入](runtime-integration.md)
