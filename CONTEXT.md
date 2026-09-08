# Craft 领域词汇

## Capability Asset

可被发现、选择和授权的能力单元，例如 Skill、MCP Server、Tool、Workflow、Runtime Adapter、Validator 或 Eval Suite。它不是某次执行，也不意味着已经被加载到宿主。

## Activation Profile

针对一个 Task 选择出的最小可用 Capability Asset 集合，连同其版本、权限边界和选择依据。Profile 由 Craft 推荐，宿主负责实际加载或卸载能力。

## Expert

可复用的专业决策配置：定义适用任务、默认 Capability Asset、约束、预算和评测标准。Expert 不是一个运行中的 Agent，也不是单一 Tool。

## Context Capsule

父任务为一个 Sub-agent Run 提供的最小上下文包，只包含 Task Contract、相关 Artifact/Evidence 引用、Activation Profile 和明确的输入边界。它不等同于完整对话历史，也不自动包含原始敏感数据。

## Tool Selection Receipt

一次能力选择的可审计记录，包含候选资产、过滤原因、最终 Activation Profile、权限边界和后续调用结果。它用于评测路由质量，不代表能力已经成功执行。

## Sub-agent Run

由 Orchestrator 为一个明确子目标创建的、可追溯的 Expert 执行实例。它绑定 Task、Context Capsule、Activation Profile、预算、权限、Trace 和 Outcome。默认只读；需要写入时必须使用独立工作区、明确文件所有权和父任务合并验证。

## Execution Decision

对一个 effect 的可审计风险分级结果。`host_read_only` 可在普通 Host 运行；`isolated_local` 只用于可用隔离器上的本地生成代码写入；`approval_required` 不自主执行；`blocked` 代表缺少补偿或受信任凭据 Broker。缺少隔离器不会阻止普通读/规划。

## Adaptation Candidate

来自 Trial/Evidence 的 Harness 改动草案，最多改变两个设计轴。它必须先有同环境、等预算的可靠性评估和候选 Run 的 passed Signoff，才能进入 Canary；Canary 回归保存精确 rollback 目标，不能直接改写默认 Prompt、Skill 或 Workflow。
