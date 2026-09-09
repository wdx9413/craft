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

## Workspace

供人和 Agent 共享的版本化状态根。它保存显式本地根目录、纳入的相对路径、可选 Git 基线引用、文件 Checkpoint、人工改动和 Artifact/Evidence 引用；它不是完整对话历史，也不自动执行 Git。

## Workspace Checkpoint

对 Workspace 已声明路径的不可变普通文件快照，每个文件都有内容摘要。比较两个 Checkpoint 只产生路径级 added/deleted/modified 结果；Restore 必须得到显式批准，且不能覆盖整个 Workspace 根。

## Workspace Transaction

只覆盖 Workspace 已声明本地写入的协调记录：先保存 baseline Checkpoint，再提交一个同 Workspace 的精确 Checkpoint，或经明确批准恢复 baseline。它不是外部 API、数据库或网络写入的通用回滚承诺。

## Trajectory Script Proposal

引用同一 Task 的 passed Trial、由调用方提供 operations 的受限脚本候选。当前只含版本锁定的 Workflow 和 Checkpoint IR，并由固定 TypeScript 模板渲染；尚不从原始 Trace 自动推导程序，不接受任意源码、不执行动态代码。只有 exact passed Signoff 才能从 `draft` 变为 `verified`。

## 产品支柱与目标边界

工作与协作包含目标、共享工作空间、能力与上下文；执行与保障包含规划调度、连接与沙箱、验证与观察；学习与改进包含评测与实验、记忆与知识、学习适应、编译与复用。评测是第三支柱内部模块，不是第四支柱。

Generative/Dual-Mode UI、CVMM 类比下的通用工作集管理、后台 Memory Consolidation、自动轨迹编译均是目标，不能用已有状态对象代称完整实现。当前隔离 Adapter 也不是完整安全沙箱。产品面向各行业，研发/视频只是首批验证场景。详见 [产品架构](docs/product/architecture.zh-CN.md) 与 [执行边界](docs/technical/modules/execution-policy.md)。

## Verified Script Run

把一个 verified Trajectory Script Proposal 与同一 Workspace 的 prepared Transaction 绑定后产生的精确 Host 操作单。Host 的逐项回执只能结束该 Run，不能绕过原有 Runtime Policy、评测 Gate 或把任意 TypeScript 变成本地可执行代码。
