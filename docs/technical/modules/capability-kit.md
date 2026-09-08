# Capability 与领域 Kit

## 职责

Capability Catalog 发现、索引和按需读取 Skill 等能力资产。Capability Design Kit 是长期模块，类似领域“设计包”，组合能力、Artifact Schema、Validator、Policy、Eval Suite、兼容矩阵和示例。

## 关系

- 被 Agent IR 引用，提供可用 Operation 与约束。
- 被 Workflow 装配，提供实际步骤和验证器。
- 被 Experience/Eval 以精确版本作为评测 Subject。
- 由 Runtime Adapter 转成宿主可理解的 Skill、MCP Tool 或 Plugin。

## 边界

当前 Catalog 只正式索引 `SKILL.md`；Kit Registry、依赖求解和远程 Hub 尚未实现。v0.9.4 的可选向量检索只是候选召回器，不承担版本、权限或质量判断。

关联：[Agent IR](agent-ir.md) · [Experience/Eval](experience-eval.md) · [Runtime 接入](runtime-integration.md)
