# 经验手册属于 Experience Procedure，不属于项目文档或 Notes

状态：Accepted

Craft Experience 以版本化 Procedure/Graph 拥有可复用的任务经验；“runbook”是其面向下一个零上下文 AI 的可读视图，不另建项目级 `docs/runbooks/` 来源，也不写入 Craft Notes。一次已验证任务可产生项目范围内、不可路由的 Procedure Candidate，记录适用条件、真实踩坑、原因、正确做法、完成判据、失败处置、证据引用和有实测依据的时间/规模；无测量证据时标明未测。可保留非敏感 UI 文案或错误片段及脱敏合成示例；项目真实源码只保留路径、版本和摘要引用，不复制提示词、对话、原始命令/工具输出、密钥或客户数据。Craft Context 在任务开始时召回相关已路由 Procedure，并在任务收尾编排经验提交；Context Hook 只观察编辑与验证等脱敏信号、提示 Host 模型提交 Candidate 或明确跳过，不能否决已发生的工作。新 Candidate 可在同项目中作为明确标记的待验证提示参与 Context，不得自动执行；只有至少两项独立验证任务和预先绑定的评测合同通过后，Procedure 才自动成为可路由经验，跨项目使用还须经过跨项目验证。正式 Work Loop 将“已保存 Candidate 或明确无新经验”纳入完成验收；普通 Host 对无法写入的情况必须报告未沉淀，不得声称已保存。用户可在 Experience 界面检查来源并随时撤销已启用版本。

## 可检查后果

- Experience Procedure Candidate 可包含经过整理、脱敏的可读经验；Hook Observation 仍保持内容无关，只提供来源、编辑/验证状态和证据引用。
- Context 对 Candidate 的投影必须标明 `candidate`/待验证状态及项目范围；它是只读提示，不等同于可路由计划或执行授权。
- Candidate 的晋级沿用独立验证和固定评测门槛，通过后自动启用且可撤销；项目范围经验不得因一次成功自动泛化为全局经验。
- 普通 Host 的 Stop Hook 仅触发提示或续办，不拒绝已发生的外部效果；只有正式 Work Loop 可以把捕获回执作为验收条件。
- Device Note、Directory Note、File Note 仍只保存对应设备、目录或文件的短说明；流程步骤和恢复经验归 Experience。

## 当前实现状态

Craft 0.20.9 的本机开发包已实现 Runbook 捕获/明确跳过 MCP 工具、通过任务结束 Hook 提供非阻断提示、同项目按查询召回待验证内容、Experience 页查看来源与人工撤销。捕获要求既有 Host 终态 Observation 和相同项目、任务、会话的完成证据；字段有长度上限并拒绝常见密钥格式；时间/规模没有可核验证据时明确标为未测。候选不可路由、不可导出，正向 Procedure 门禁拒绝直接晋级。

仍未实现：Runbook Candidate 经多任务评测后自动转换为可路由 Procedure 的关联与晋级、正式 Work Loop 对“捕获或明确跳过”的完成验收、跨项目评测与部署。可路由 Procedure 仍须走现有多观察提案和独立评测链路；当前不能声称 Runbook Candidate 本身会自动晋级。此次版本只进入本机 npm Registry 的 Craft 0.20.9 / Experience 0.20.7 开发包，尚未推送 Git 或发布远端。
