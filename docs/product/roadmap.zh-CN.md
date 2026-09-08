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
- 重复通过且带证据的安全路线可生成带溯源的 Workflow 草案；草案仍须走已有评测门禁，不能自动晋级或发布。（v0.9.2 已实现）
- Project Policy 可将 Git 基线、聚焦测试、覆盖率和 Review 回执变成服务端硬门禁；Host Adapter 只能领取已声明支持的下一安全动作。候选按通过率、独立 Task 和 confirmed/bounded Evidence 资格化，检索按名称、描述和别名重排。（v0.9.3 已实现）
- 可选 OpenAI-compatible Embeddings：未配置时严格保持关键词检索；配置后只为 Skill 名称、描述和别名建立按 Provider 指纹隔离的缓存，查询成功时以混合排序增强召回，超时、鉴权、格式或维度失败时自动退回关键词结果。（v0.9.4 已实现）
- 受控 Runtime Core：版本化 Policy 限定 effect、审批、并发和预算；持久 Run/Operation 记录父子归属、环境/Policy 指纹、审批与幂等回执，预算耗尽安全暂停。（v0.9.5 已实现）
- 受信任 Host 的确定性 Driver：只执行已签发、显式输入且通过命令/路径/effect Policy 校验的 Workflow Operation；DAG 依赖、有限重试、Lease 过期恢复以及 Trace/Artifact/Evidence 回执均持久化。通用 Agent/Grader 仍交给 Host Adapter。（v0.9.6 已实现）
- 自动 Eval Runner：对确定性 Workflow 运行 `Case × Subject × N Trial`，自动归档 Trial/Trace/Outcome、Evaluation Run 与可比 Comparison；程序 Grader 可自动出 Grade，Promotion Assessment 对 held-out baseline/candidate 检查最少 Trial、通过率、成本与配对胜负；模型/业务 Agent Subject 必须通过 Host Runtime 提交真实 Outcome。（v0.9.6 已实现）
- Experience Miner 与 Operational Drift：重复成功策略与失败模式只产出 proposal-only 候选；shadow 仅执行只读 held-out baseline/candidate 对照，Promotion 通过后只准备指定 Signoff Policy，仍须独立 Grade/Signoff/Publisher Gate 才能发布。数值线上信号以滑动窗口生成可审计告警。（v0.9.8 已实现）
- 按风险、预算和副作用选择最小 Harness，并将 Operation DAG 编译为版本化 Agent IR、Lower 到 Runtime Run。（v0.9.6 已实现）
- Runtime Adapter 将宿主 Agent/Grader 领取与回执约束为版本化契约；本地 Adapter 不能声明外部/破坏性 Effect。直接 Eval 晋级必须经过 held-out 的 Candidate/Baseline Promotion，成本与时延分别受阈值控制。（v0.9.7 已实现）
- Capability Asset Registry、最小 Activation Profile、profile-bound 过期调用回执、唯一只读 `diagnostic_research` Expert 与最多五个 Context Capsule Sub-agent。（v0.9.9 已实现）
- 评测可靠性、Judge 校准、受审核 development 反馈、最多两个设计轴的 Adaptation Candidate、Signoff 后 Canary/精确回滚。（v0.9.9 已实现）
- 执行按风险分级：普通读/规划可跨平台运行；仅本地生成代码写入依赖 macOS/Linux 网络拒绝隔离；外部写入审批、无补偿破坏性或未受信任 Broker 的凭据请求失败关闭。（v0.9.9 已实现）
- Agent-Native Workspace：显式文件根/纳入路径、可选 Git 基线引用、不可变文件 Checkpoint、摘要 Diff、人工改动记录和显式批准恢复。它是 CLI/插件与未来 Canvas 的共同状态源，不自动执行 Git 或覆盖工作区根。（v0.9.10 已实现）
- Transactional Runtime 与 Trajectory Compiler：本地写事务先固化 baseline、再提交精确 Checkpoint 或显式回滚；passed Trial 只能编译为白名单 Workflow/Checkpoint 的静态脚本候选，exact passed Signoff 后才可标记 verified。外部系统事务、任意代码执行和脚本 Runner 仍未实现。（v0.9.11 已实现）
- Lease TTL/续租、显式幂等提交和实际成本超限阻断。（v0.8.0 已实现基础协议）

验收：同一真实任务集能比较两个版本的质量、成本、耗时和失败类型，并阻止无证据晋级；默认入口不能绕过 Host 审批或把未验证 Skill 当作可执行流程。Runtime 的每个子 Operation 必须归属根 Task，控制/环境指纹变化必须使旧证据失去新晋级资格。

## 中期：领域 Kit 与跨 Host 运行

能力访问治理、`diagnostic_research` Expert 与只读 Sub-agent 的实现边界、证据和后续项见：[专项规划](capability-expert-subagent-plan.zh-CN.md)。

- 将现有 IR Lower 到至少两个真实 Host 的执行计划。
- 用“研发 Kit”和“AI 视频 Kit”验证同一内核能否跨领域复用。

验收：同一 IR 可在至少两个宿主执行；两个领域共用核心协议，只扩展 Kit。

## 长期：设计空间探索与经验编译

- 生成多个执行架构候选，使用廉价估算逐级筛选，最终做高可信 Signoff。
- 从 Case 级记录提炼带适用条件的全局经验。
- 学习“什么条件下哪种配置有效”，而不是无限追加聊天摘要。
- 所有自动修改保持预算限制、版本记录、评测门禁和回滚能力。

长期是否成立，以跨模型迁移率、任务完成率、人工修正量、恢复时间、成本和回归率衡量，不以“自进化”叙事衡量。
