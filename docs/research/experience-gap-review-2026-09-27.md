# Experience 组合能力补缺检查

> 2026-09-28 后续执行已接通，当前状态见 [执行绑定与验收](../technical/modules/procedure-invocation.md)。本文保留 09-27 检查时的历史证据。

范围：上一轮多入口、出口、固定版本子流程实现的源码、MCP 契约、持久化和迁移。结论来自当前源码与隔离测试；不把计划编译、Fixture 或覆盖率视为真实研发交付证明。

## 本轮已修复

| 问题 | 原来的行为 | 当前行为与回归 |
| --- | --- | --- |
| Gate 重试破坏版本固定 | 请求身份含当前 Procedure 版本，首次调用会改变这个版本，重试再次写入或发生冲突 | 请求身份绑定资产和评测输入；重复请求只返回当前状态。显式 expected_version 阻止过期状态新写入 |
| 失败后借用旧晋级记录 | Canary 失败仍保留前三阶段通过记录，可直接再次 Canary 放行 | 失败清空本轮资格，旧版撤销记录的残留资格同样不生效；重做较早阶段也使下游资格失效。回放旧成功 Gate 不改变撤销后的状态 |
| Gate 与状态写入不原子 | Gate 写入成功、Procedure 保存失败后留下半条晋级事实 | 复用 CraftStore 事务；注入第二次写入失败时两者一起回滚 |
| 类型伪装及步骤路径冲突 | 带空格的 procedure_call 通过 text 校验，却被原始字符串分支当作叶子；含 `/` 的步骤可与嵌套路径碰撞 | 拒绝首尾空白和 Step ID 中的 `/`，补充负例 |
| MCP schema 与实现不一致 | scope 被自动推断为 object，实际 list 接收 string；旧 Gate 别名的 passed 被推断为 string | 对新旧 List、Gate 和 Draft 别名单独声明类型；标准 JSON-RPC 验证通过 |
| 已晋级流程无法迁移 | 导入强制要求定义版本等于状态版本，晋级后的 1/5 被拒绝 | 分开校验定义引用版本、摘要与状态版本；父子组合晋级后导入另一个临时数据域，重新生成相同计划 |
| 诊断未覆盖核心新接口 | 检测旧 Experience 工具集时不要求 plan | expected_tools 包含 get/gate/plan；缺 plan 被明确归类为 bundle_or_surface_mismatch |

实现入口：[ProcedureStore](../../capability/craft-experience/procedure-projection.ts)、[组合计划](../../capability/craft-experience/procedure-composition.ts)、[Bundle](../../core/knowledge-memory-bundle.ts)、[MCP schema](../../core/mcp/tool-schema.ts)。回归：[Procedure 测试](../../tests/procedure-projection.test.ts)、[组合测试](../../tests/procedure-composition.test.ts)。

## 仍缺的能力，按优先级排序

### P0：把计划接到持久执行闭环

**已证实**：`ProcedurePlanner.plan` 返回树形计划和摘要，`acceptance_status` 固定为 `not_evaluated`；没有 invocation 身份、逐步执行记录、子出口验收记录或恢复点。`ProcedureAutomationKernel` 明确拒绝组合定义。现有 [VerifiedWorkLoop](../../core/verified-work-loop.ts) 和 [DurableActionLoop](../../core/durable-action-loop.ts) 可作为执行基础，但目前未与 Procedure Call 连接。

应增加一个受控绑定 Use Case：将确定入口/出口的计划绑定到同一 Task/Run/Workspace，把叶子工作和每层出口变成既有 Durable Work Item；父流程只能消费已通过子出口验收的输出。重启后从已有 Receipt 恢复；未知外部效果先 reconcile，不重放；每次 dispatch 检查版本、撤销和预算。无需新增第二套调度器。验收至少包含：中断恢复、子流程失败阻止父流程继续、撤销后停止执行、重复回执不推进两次。

### P0：前置证据绑定到具体调用与状态

**已证实**：当前 precondition Evidence 只检查 confidence、scope、condition_ref。它未绑定 Task、工作区 revision、入口输入摘要或过期时间。同项目另一次任务的同名条件，不能自动证明本次条件成立；多个子流程的同名条件也共用一个映射键。

应在上述调用绑定中加入 invocation/输入摘要/状态版本和证据期限。由父步骤产生的材料对应的子入口条件，要在子调用开始时验证，不能在最初生成总计划时假装已经满足。验收包含换 revision、旧 Evidence、同名子条件隔离和父步骤新产物。

### P1：按入口、出口与版本评估经验收益

**已证实**：Observation 目前以 scenario/signature、source、outcome 聚合；没有专门绑定 Procedure 调用及入口/出口的结构化结果。大流程中 Review 改进与整体交付改进无法自然分开归因。

应从真实终态 Receipt 记录精确 Procedure 定义、Entry、Exit、Host、失败阶段和成本；按同场景、同输入基线比较，不以单条命令 exit_code=0 或模型自评代替结果。第一批使用一个完整需求和一次独立 Review 的固定 Case 做配对验证。

### P1：补齐真实 Host 验收

**已证实**：本轮可调用的 Experience MCP 仍未暴露 plan；诊断回应来自旧工具集。同版本号并不能证明当前进程已加载最新源码。Knowledge/Memory 本轮未暴露可调用 MCP，已使用 Skill 的 unavailable 路径。

源码 stdio conformance 证明分发协议，安装器测试证明配置与文件行为；它们不证明 Codex、Claude、Cursor、VS Code 等真实会话都能完成完整路径。更新安装后，按实际 tools/list 与一次真实场景的端到端 Receipt 验证。远程交付仍遵循“提供部署配置及验收脚本，暂不上线”。

## 验证记录

71 项受影响回归、14 项打包/协议测试通过；实际 stdio 跨四组件 74 次调用通过。本轮增量 50 行和 38 个分支路径全部覆盖；Procedure 组合和投影模块的原生 Node 行/分支/函数门禁均为 100%。typecheck、分层、工具面、文档链接和 diff 检查通过。具体数据见 [机器可读证据](evidence/experience-gap-review-2026-09-27.json)。这些结论不覆盖真实 Host 任务交付与线上部署。

## 本轮非目标

不新增 Graph 编辑器、任意表达式语言、独立调度器或自动发布。前述执行与证据绑定闭环的优先级高于继续扩大 Graph 语法。也未用 Fixture 数据创建用户真实可路由 Procedure。
