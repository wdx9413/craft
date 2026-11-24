# ADR-0039：craft-context 四个子能力作为 Codex 插件的自进化链路评估与缺项

状态：Accepted

## 决定

craft-context 0.20.4 插件下的四个子能力（craft-codebase、craft-experience、craft-knowledge、craft-memory）**不能独立构成完整的自进化积累循环链路**，也不足以作为 Codex 插件“全面增强”的全部能力。自进化链路在插件内部无法自闭环，必须依赖外部验证器和缺失的评测层。

## 背景

四个子能力的实际职责如下：

- craft-codebase：仓库索引、符号探测、调用/数据/控制流、影响诊断。**只读结构证据**，不写入、不执行。
- craft-experience：版本化场景 Graph、Procedure 发现/编辑/评测；`observe → draft → submit → shadow/held-out/signoff/canary → current` 门禁。最接近自进化，但 `craft_learning_cycle_finalize` 需要 `verified: true` 的 terminal outcome，而该 outcome 必须由 Host（Codex）实际运行测试/验证产出，craft-experience 本身不执行测试。
- craft-knowledge：证据支撑的 fact/rule/decision，`claim → review → promotion → held-out eval`。属于知识层，不是执行闭环。
- craft-memory：作用域记忆账本，捕获事实/陈述、过期、撤回、迁移。属于上下文层，不产出可执行资产。

关键缺口：craft-context 插件包内**不存在 `craft-eval` 子能力**。craft-experience 内部的 shadow/held-out/signoff/canary 和 craft-knowledge 的 `evaluation_run` 是组件内部验证，不能替代面向整个 Codex 插件能力的端到端全面评测（固定查询集、有/无 context receipt 对比、覆盖率、错作用域泄漏、回归容忍等）。没有证据表明有使用 `craft-eval` 做过全面评测并通过。

## 还缺什么（作为 Codex 插件全面增强）

1. **独立评测层 `craft-eval`**：对代码理解、知识检索、经验复用、记忆事实做固定查询集评测，测量有/无 context receipt 的同一 coding case 的 pass-rate、first-pass-rate、错误率、覆盖率、延迟、成本。
2. **Codex Hook 自动注入**：每个用户 prompt 时自动 resolve Knowledge/Memory/Experience 并把 context receipt 注入上下文，而不是依赖手动调 `craft_context_open`。文档明确 Hook 是可选的，且 "MCP alone cannot force a turn callback"。
3. **代码写入与测试执行能力**：craft-codebase 是只读结构证据，需要能调用 Codex 原生的文件编辑、终端命令、测试运行器，把 verified outcome 落地到代码仓库，否则自进化循环卡在“观察”阶段，进不了“执行→验证→积累”。
4. **与 Codex 原生能力的双向集成**：在 Codex 的文件树、聊天界面、命令面板、模型选择等交互流中被调用，而不是作为独立侧边工具。
5. **插件分发与安装规范**：`.codex` 插件清单、安装脚本、`.craft-codebase.json` 项目级配置模板、面向普通用户的一键安装路径。
6. **权限与数据边界模型**：什么能读、什么能写、凭据如何隔离、用户数据是否离开本地。文档虽提 `CRAFT_DATA_DIR` 和访问控制，但缺少针对 Codex 插件场景的权限清单。

## 非目标

- 不把模型生成的 adapter/procedure/mod 直接发布为可信资产。
- 不自动修改 Craft 代码、权限、UI 或 Host 配置。
- 不把大文件、原始聊天记录和敏感数据塞入账本。
- 不要求用户安装多个插件才能完成日常自进化。

## 后果

短期先在 craft-context 单插件内接通 Value Gate、Runbook/Procedure candidate 流程与 Craft Notes 作用域；长期可在不破坏内核的前提下拆小插件。自进化链路的“执行→验证”环节必须由外部验证器（Codex 测试运行器/终端命令）提供，craft-context 本身不承担。

## 后续迭代（2026-11-24）

2026-11-24 复核发现，之前的 `learning-cycle-bridge` 只接收调用方传入的报告计数和引用；对应“5/5”测试也只是硬编码对象，不能证明评测执行、报告来源或持久化。该断言已撤回。

当前改造增加了受控链路：Workbench 评测提交时把 Host、任务、会话、回合、Context receipt、已存 Host completion Evidence ID 和该 Evidence 的 verification ref 绑定进评测输入摘要；`craft_learning_cycle_evaluation_finalize` 按评测 ID 从 Eval owner 读取终态记录，重新计算报告，重新核验 Host Evidence 对应的当前 Codex 会话归档，并核对任务身份与成功终态。两类来源都通过后，才复用 Experience 的 `learningCycleFinalize` 写入/幂等复用 Observation，并持久化受控评测 Evidence 与 Observation 的关联；后续 `learningCycleRequestGet` 会把评测摘要和 Evidence ID 一并交给候选起草读取，`workflowEvolutionProposalSubmit` 会自动将仍匹配该关联的 Evidence ID 并入 Procedure 草案。失败、未完成、报告被改、Host 归档缺失/变化或绑定身份不一致都不会写成功 Observation 或评测关联。归档核验不等于密码学 Host 身份认证。Observation 后续仍走现有异步分类、候选提交和 Shadow/Held-out/Signoff/Canary 门禁；写入 Observation 不等于已有候选或已经启用。

定向集成测试实际启动 Workbench evaluator 子进程，分别验证通过报告产生一条任务 Evidence/Observation、失败报告不增加成功记录。它证明本地受控评测到 Observation 的接线，不证明真实 Codex Host 的身份、模型质量或候选最终启用。评测报告是本机受控执行及完整性复算结果，不是密码学签名。`permission-boundary.ts` 是独立策略判断组件，默认不授予任何路径访问；Craft 运行时的实际存储权限仍由 owner store、路径绑定与调用边界实施。Marketplace 包、真实 Codex Host 安装和异步 worker 后续晋级仍须单独验证。
