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

本 ADR 的缺项已分批落地：权限与数据边界模型（`permission-boundary.ts`）、外部验证器契约（`external-verifier.ts`）、craft-eval 五场景 held-out suite、Hook context receipt 审计用例、`.codex` 安装规范和双向集成说明。**关键增量是 learning-cycle-bridge**：把 craft-eval 的 verified run report 转成 Evolution Value Gate 输入，使 verified outcome 能回流成 `candidate_procedure`/`candidate_mod`。端到端测试用实测的 coding held-out 5/5 complete 结果验证了“评测→验证→积累”链路，失败/未验证结果不会成为持久候选。craft-context 全量测试 42/42 通过，craft-eval 全量测试与 100% 覆盖率门禁通过；真实 Codex 环境下的 end-to-end 触发仍是未覆盖风险。
