# Experience 多入口流程组合

目标：同一研发 Procedure 支持完整开发、独立 Code Review 与不同交付边界，并复用固定版本子流程。语义见 [领域词汇](../../../CONTEXT.md)，设计依据见 [官方来源研究](../../research/experience-process-composition-2026-09-27.md)，对外输入与完整示例以 [Experience Skill 组合契约](../../../skills/craft-experience/references/composition.md) 为准。

## 模型与执行边界

Procedure 是复用资产；Entry/Exit 是任务范围契约；Route 是选定范围后的有序步骤；Procedure Call 是固定版本组合。多入口、粗粒度、复用本身不要求 Graph。Route 支持显式有界只读并行组；运行时条件分支、回环和复杂补偿继续使用既有 Graph Compilation，不能从组合计划推断自动执行语义。

新增 `craft_procedure_plan` 是一个只读 Interface。`ProcedurePlanner` Module 在同一 Seam 内完成完整定义校验、作用域及 Audience/Tenant 检查、材料依赖检查、子流程解析、effect 收窄和有界计划生成。它提高 Interface 的 Depth；Host Adapter 无须自行遍历依赖。其 Implementation 使用现有 CraftStore、ProcedureDefinitionStore、Scope Envelope 与 digest，不引入依赖或第二套执行器。

调用链：MCP catalog/schema → action handlers → CraftService delegate → ProcedureStore.plan → ProcedurePlanner。计划保持子调用结构和输入/输出绑定，保留每层来源、失败处置与 Acceptance。Host/Runtime 仍拥有真实执行、Receipt、恢复及验收。生成计划不持久化业务输入，不产生 Outcome，不获得执行许可。

新 composition 走 `workflow_evolution_proposal` 和 checked JSON Procedure，继续四阶段晋级；不会同时生成一个允许绕过 Entry 的旧 Workflow 记录。旧 Workflow、Graph、Prompt 和未声明 composition 的存量定义保持原路径。旧 Automation API 对组合 Procedure 明确拒绝，要求先确定 Entry/Exit；这一版本不提供无人值守组合 Runtime。

## 验收证据

| 验收条件 | 实现与验证 |
| --- | --- |
| 完整开发与 Review 得到不同计划；完整开发可在不同交付边界停止 | composition.entries.routes；集成测试经 standalone MCP 提交、晋级、解析三条路径 |
| 入口不能跳过所需材料，出口必须可交付 | 所有 Route 的 requires/provides 静态检查；plan 的精确输入键与前置 Evidence 校验 |
| 子流程复用没有隐式最新版本或权限扩大 | 记录版本 + 定义摘要固定；最新 routeable、scope、Audience/Tenant、祖先 effect 和 Call effect 联合检查 |
| 不允许递归或无限展开 | 递归拒绝、8 层与 100 个展开 Step 上限；独立负例覆盖 |
| 多入口不能通过一条路径的成功而整体晋级 | 每阶段 Evidence metadata 覆盖所有 Entry→Exit，精确绑定定义摘要；失败 Gate 可立即停止路由 |
| 兼容旧能力，无 Hook 可用 | 76 项相关回归通过；打包后 4 组件共 69 次真实 stdio 调用，其中 Experience 35 次，含 composition 提交与 plan |
| 增量覆盖及源码边界 | 新模块原生 Node 行/分支/函数 100%；本任务增量行/分支 100%；typecheck、分层、surface、文档和打包检查通过 |

可机器读取的 [本轮验收记录](../../research/evidence/experience-composition-2026-09-27.json) 记录打包摘要、协议调用、测试与增量覆盖；主测试是 [procedure-composition.test.ts](../../../tests/procedure-composition.test.ts)。覆盖率相对本轮开始时的脏工作区快照计算，不将其他未提交改动纳入本轮完成声明。

分发产物已同步到 marketplace 与 common-use。安装器现在复制完整 Skill 文件树，能修复旧的仅 SKILL.md 安装，并在冲突/卸载时保护本地修改与新增文件；2 项来源校验和 7 项安装器测试通过，安装器本轮增量行/分支覆盖率也为 100%。

## 未证明的内容

- 计划编译和 Fixture Gate 不能证明真实研发任务的完成质量；首次可路由资产需要真实场景、每条 Route 的独立评测及出口验收。
- 前置 Evidence 校验其 confidence、scope、condition_ref；时效与当前任务材料关联仍由 Host 验证。
- 当前是组合 Workflow 的 Host 计划，不含自动重入、持久子流程调度、Graph 子调用展开或视觉流程编辑器。
- 本轮未执行各厂商编程工具的真实会话验证，未升级正在运行的插件缓存，未上线远程服务。
