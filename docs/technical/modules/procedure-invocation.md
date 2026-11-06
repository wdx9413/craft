# Procedure 调用、恢复与效果评估

2026-09-28：组合计划现在可以绑定到既有 Verified Work Loop。Procedure Invocation 是本次调用事实，Procedure 仍是可复用定义；粗粒度研发流程继续使用 Entry/Exit/Route/Call，无须引入第二套 Graph 执行器。

## 实现

[ProcedureInvocationKernel](../../../core/application/procedure-invocation.ts) 通过六个 `craft_procedure_invocation_*` 操作实现 bind/dispatch/report/resume/get/evaluate。复用 DurableActionLoop 的依赖、派发、回执、恢复和 Trace，以及 AcceptanceGate 的验收。嵌套调用的出口是独立 Work Item，子出口通过前不向父流程暴露材料。事务包住调用记录、Gate、Durable 状态和 Outcome；重复回执只读原结果，乐观版本检查保护新写入。

每次派发校验 Task/Policy、当前资产版本、撤销、定义文件完整性、次数/时间及 Task 预算。尚未得到回执的派发只要求 reconcile，恢复发现工作区漂移则 needs_replan。当前支持 read_only/local_write，真实动作由 Host 的既有许可和适配器执行。

前置证据按调用路径隔离，到子调用真正获得输入时才验证 Task、输入摘要、快照、状态修订及过期时间。流程编译的公开只读路径仍保留原来的提前检查；执行绑定使用内部的延后验证选项。

每层出口以及失败步骤保留定义摘要、版本、Entry/Exit、Host/模型/预算、输入及失败阶段。3–100 对终态调用在相同上下文下比较通过率、耗时及有来源的成本/重试指标。缺测量值保留 unavailable。所有外部上报回执明确标为 host_attested，结果不会自动晋级，也不冒充可信执行器的独立证据。

顺便修复实际调用链中 AcceptanceGate 写 `status` 而 DurableActionLoop 只读 `verdict` 的不兼容；旧 verdict 记录仍可读。补全 Host Session/Outcome Observer 的 fingerprint 参数类型和模型/预算字段，避免源码接口可用、MCP wire 不可用。

## 使用与接入

完整参数及恢复步骤见 [Skill 执行指引](../../../skills/craft-experience/references/invocation.md)。Experience daily 保持 24 个工具；准备 Task、工作区和 Host Session 的完整 Runtime 可由同数据目录的 `craft-mcp-full` 提供。两者都是 MCP，可只用 Skill + MCP，无须 Hook。独立 Experience 本身不创建另一条 Task 生命周期。

多 Host 实机状态见 [Host 验收记录](../../research/host-acceptance-2026-09-28.md)。远程部署仍使用已有 [部署配置与验收](../../../deploy/components/README.md)，本轮不部署线上。

## 可验证的验收条件

| 条件 | 证据 |
| --- | --- |
| 父子流程执行、别名产物映射、每层出口验收 | procedure-invocation 测试的嵌套流程与 alias 场景 |
| 重启恢复、未知派发不重放、重复回执不重复推进 | 关闭重开真实临时 SQLite，reconcile_dispatch 及幂等回执测试 |
| 子条件晚绑定，同名条件、任务、输入、修订、TTL 隔离 | 程序化负例与实际父产物引用 |
| 失败/撤销/Policy变化/预算耗尽阻止继续 | 失败、撤销、版本、预算、漂移测试 |
| 事务失败没有半条进度 | 注入 receipt 写失败，Gate 和 Durable 状态一并回滚 |
| 有界、可比较、无自动晋级的效果评估 | 3 对终态调用、上下文冲突、缺测量及费用累加测试 |
| MCP 可调用且兼容旧数据 | 真实 JSON-RPC handler 校验及受影响模块回归、stdio conformance |

测试入口：[procedure-invocation.test.ts](../../../tests/procedure-invocation.test.ts)。本地验收不等于真实项目效果提升；Claude/Cursor 等 Host 的登录和环境状态以实机记录为准。

本轮验收：84 项受影响回归、14 项打包/协议测试通过；四组件实际 stdio 调用 74 次通过。相对本轮脏工作区起点，增量 319 行及 241 个分支路径全部覆盖；Invocation 与 Composition 两模块的原生行/分支/函数门禁均 100%。[机器可读证据](../../research/evidence/procedure-invocation-2026-09-28.json) 单独记录源码验证、真实 Codex 会话和未通过的 Host 登录状态。

后续业界差距补齐增加非成功状态保留、证据绑定恢复和只读并行组，详见同目录 Skill 执行指引。上文 84 项与覆盖率数字为前一轮验收，不适用于后续改动；本轮结果单独记录在业界补齐交付报告。
