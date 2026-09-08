# Craft 产品路线

## 目录

- 当前：可靠内核
- 下一阶段：Experience/Eval 闭环
- 中期：Agent IR 与领域 Kit
- 长期：设计空间探索与经验编译

## 当前：可靠内核

- 多来源 Capability 索引和按需加载。
- Task、Checkpoint、Artifact、Evidence 与版本化 Workflow。
- Codex、Claude、DeepSeek Harness 和通用 MCP 接入。
- 不可变 Trial/Outcome、只追加 Trace、评测分区和 Workflow 晋级/回滚门禁。

验收：核心代码 100% 行/函数/分支覆盖；插件在无 `node_modules` 缓存目录可启动；`verified` Workflow 不能绕过 held-out Eval。

## 下一阶段：Experience/Eval 闭环

- Workflow Run 自动登记 Trial、Trace、Artifact、Evidence 与 Outcome。（v0.3.1 已实现）
- 确定性、模型 Rubric、人工和业务结果四类 Grader，以及版本化 Signoff Policy。（v0.4.0 已实现基础协议）
- Search/Development 与 held-out 数据隔离；同一评测集的质量、成本、耗时和失败类型聚合对比。（v0.5.0 已实现确定性基础协议）
- Workflow、Agent Profile 与 Harness Configuration 使用同一评测协议。（v0.5.0 已实现版本对比；Capability 评测待实现）
- Orchestration 执行自动形成 Trial、Trace、Evidence、成本和 Outcome，并锁定 Agent Profile 路由版本。（v0.6.0 已实现）
- 默认编排已成为复杂任务的默认 Skill 策略；优先复用已验证 Workflow，无匹配时自动创建可续接的安全增量研发 Kit，并从同策略完成 Trial 自动列出 Experience Candidate。（v0.9.0 已实现）
- 自然语言续接仅恢复唯一匹配的活动路线；并列、已完成和无匹配任务不猜测。（v0.9.1 已实现）
- Lease TTL/续租、显式幂等提交和实际成本超限阻断。（v0.8.0 已实现基础协议）

验收：同一真实任务集能比较两个版本的质量、成本、耗时和失败类型，并阻止无证据晋级；默认入口不能绕过 Host 审批或把未验证 Skill 当作可执行流程。

## 中期：Agent IR 与领域 Kit

- 定义 Goal、Constraint、Artifact、Operation、Route、Validator 和 Policy 的稳定 IR。
- 将 IR 渐进式编译成不同 Host 的执行计划。
- 用“研发 Kit”和“AI 视频 Kit”验证同一内核能否跨领域复用。

验收：同一 IR 可在至少两个宿主执行；两个领域共用核心协议，只扩展 Kit。

## 长期：设计空间探索与经验编译

- 生成多个执行架构候选，使用廉价估算逐级筛选，最终做高可信 Signoff。
- 从 Case 级记录提炼带适用条件的全局经验。
- 学习“什么条件下哪种配置有效”，而不是无限追加聊天摘要。
- 所有自动修改保持预算限制、版本记录、评测门禁和回滚能力。

长期是否成立，以跨模型迁移率、任务完成率、人工修正量、恢复时间、成本和回归率衡量，不以“自进化”叙事衡量。
