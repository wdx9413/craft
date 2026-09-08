# 能力访问、诊断 Expert 与 Sub-agent 规划

## 状态与目标

v0.9.9 已实现本规划的受限闭环：本地 Capability Asset Registry、Activation Profile、调用回执、唯一只读 Expert、Context Capsule、最多五个只读 Sub-agent、可靠性评估、Judge 校准、受审核 feedback Case 与 Signoff 后 Canary。这里保留设计理由、验收边界和仍未实现项。

目标是让 Craft 在不把全部工具常驻给模型的前提下，为任务选择最小能力集；先支持一个只读的“诊断研究 Expert”，再把工具路由、Expert 与 Sub-agent 的表现纳入同一套评测闭环。

## 已确认的决策

- Craft 推荐 Activation Profile，Host Adapter 负责实际启停 MCP Server；初期不自动修改 Codex、Claude 或系统级 MCP 配置。
- 默认只常驻 Craft 路由、能力检索、Task/Evidence 与本地 Git/测试等基础能力；业务 MCP、浏览器、内网和发布能力按任务选择。
- 能力选择顺序为：任务语义匹配、权限/副作用过滤、已验证 Workflow、历史结果、成本与时延。
- 首个 Expert 仅为 `diagnostic_research`。
- Sub-agent 默认只能并行只读研究。写入型子任务必须使用独立工作区、声明文件所有权，并由父任务合并和验证。
- Sub-agent 仅接收 Context Capsule，不能默认继承全部历史或原始敏感数据。
- Expert 的提示、默认能力包、约束或预算改变都是版本变更，必须经过 held-out Eval、Promotion 和 Signoff 才能替换默认版本。

## 目标模型

```text
Task Contract
    ↓
Capability Asset Catalog ──→ Activation Profile ──→ Tool Selection Receipt
                                      ↓
                               Expert Profile
                                      ↓
                    Orchestrator → Sub-agent Run(s)
                                      ↓
                  Runtime / Host Adapter / Evidence
                                      ↓
                  Eval → Promotion → Signoff
```

| 对象 | 职责 | 关键边界 |
|---|---|---|
| Capability Asset | 可发现的 Skill、MCP Server、Tool、Workflow、Adapter、Validator 或 Eval | 被发现不等于被加载或获授权 |
| Activation Profile | 当前 Task 的最小可用资产、精确版本和权限 | 由 Craft 推荐，Host 实际执行 |
| Expert Profile | 专业策略、默认能力包、约束、预算和 Eval | 不是一次 Agent 执行 |
| Sub-agent Run | Expert 面向子目标的一次受控执行 | 绑定 Context Capsule、预算、Trace 和 Outcome |
| Tool Selection Receipt | 从候选到激活、再到调用结果的审计记录 | 选择正确不等于执行成功 |

## v0.9.9 交付范围

以下能力已作为同一个 v0.9.9 版本交付；每一项仍受前一项的安全门禁约束。

### 切片 A：能力访问治理

- 将 MCP Server 与 Tool 作为 Capability Asset 登记版本、来源、描述、权限、副作用、依赖、健康状态和成本提示；保留现有 Skill 索引兼容性。
- 新增 Activation Profile 和 Tool Selection Receipt：输出候选、过滤理由、最小激活集、版本和授权边界。
- 路由只推荐 Profile，不启停 Server；未知、失效、越权或高风险资产不能进入激活集。
- 建立工具路由 Eval：正确资产 Top-K 命中率、错误/无效调用率、定义 token 预算、首个有效动作时延。

验收：同一评测集上，Profile 可复现；高风险资产不会被自动推荐为可执行；关闭不相关资产后，路由质量和延迟有可比较证据。

### 切片 B：`diagnostic_research` Expert 与只读 Sub-agent

- Expert Profile 版本化，初始只定义适用范围、只读能力分类、预算、输出合同和 Eval Suite。
- Orchestrator 可将可独立验证的诊断假设分派为只读 Sub-agent Run。
- 每个子运行接收 Context Capsule，并输出假设、Evidence 引用、反例、置信边界和下一步建议；父任务统一裁决，不把子结论直接当事实。
- Runtime Policy 强制只读 Effect；超预算、无证据、冲突结论或宿主中断均形成可恢复 Outcome。

验收：并行子任务不共享写入工作区；每个结论可追溯到输入与 Evidence；父任务能恢复、取消或重试单个子任务。

### 切片 C：Expert/路由评测与受控晋级

- 将 Activation Profile、Expert Profile 和 Sub-agent 拓扑作为评测 Subject。
- 对比基线与候选：解决质量、Evidence 覆盖、无效调用、token、时延、人工介入和失败类型。
- 使用多次 Trial、held-out 分区、Promotion 和 Signoff 管理 Expert 默认版本；线上数据只做脱敏数值回流与漂移告警。

验收：不能因单次成功替换 Expert；Profile、Expert 或环境变化后，旧 Trial 不可冒充为新版本晋级证据；每次默认版本变化可回滚到精确版本。

### 后续：Host 自动激活与写入型子任务

- 为支持动态能力加载的 Host 增加 Adapter；不支持时仍输出 Activation Profile 供 Host 或用户执行。
- 引入写入型 Sub-agent 的独立工作区、文件所有权、变更合并、测试和 Diff Gate。
- 已实现的本地隔离仅适用于 macOS/Linux 的本地生成代码写入，网络默认拒绝；真实容器/Windows Adapter、短期凭据、MCP 信任供应链和通用补偿事务仍须在此阶段完成，不能由提示词替代。

## 非目标

- 不把所有 Skill、MCP Server 或 Tool 自动加载进模型上下文。
- 不自动启用未知/高风险 Server，不自动写入系统级配置。
- 不让诊断 Expert 修改业务代码、发布资产或替代人工 Signoff。
- 不把向量检索、单次 Trial 或模型自述当成路由/Expert 已验证的证据。

## 下一次实现前的输入

- 一份可公开、脱敏的诊断任务集：目标、正确能力类别、允许副作用、预期 Evidence 类型。
- 当前常用 MCP Server/Tool 清单及其权限、成本、健康状态。
- `diagnostic_research` 的 held-out Case、成功判定和人工抽检规则。
