# Turn Cognitive Runtime（v0.12.28）

`Turn Cognitive Runtime` 是 Craft 的轻量认知控制面，不是又一套聊天 Agent，也不是每句话都要跑一次任务工作流。

它将“本轮是否值得读取上下文、发现能力、进入受治理工作、提出可沉淀记忆、记录评测信号”收敛为可复现的策略决定：

```text
Host 或 Craft Agent 的语义理解
        ↓ Turn Proposal（输入摘要、意图、信号、可选记忆候选）
Turn Policy（精确 scope、最小动作规则）
        ↓
Turn Receipt（动作、版本、理由引用；不存原始输入）
        ↓
Context / Capability / Work / Candidate Memory / Observation
```

## 责任边界

- **控制台模式**：Codex、Claude、IDE 等 Host 负责理解本轮对话并提交 `Turn Proposal`；Craft 只验证范围、策略和事实边界。
- **独立 Agent 模式**：Craft 复用既有 `work_runtime_mode` 的模型声明来标记语义所有者与模型版本；本模块不内置模型网络调用。实际调用仍须经已配置的 Model/Host Adapter。
- **Host Hook**：`TurnHostAdapter` 可以声明 `manual` 或 `event_hook` 能力。Craft 仅生成接入计划，绝不会改 Codex、Claude 或 IDE 配置，也不会偷偷启动 CLI。

因此，短回答可得到全 `none` 决策；它不加载上下文、不发现工具、不创建任务，更不会自动保存聊天。只有 Host/Agent 给出相应意图和信号，且同 scope 的 Policy 允许时，才返回下一步建议。

## 核心记录

| 记录 | 用途 | 不做什么 |
| --- | --- | --- |
| `turn_policy` | 规定一个 user/project/workspace/task scope 内的最小接入规则 | 不授予 effect 或执行权 |
| `turn_proposal` | 记录 Host/Agent 的内容无关语义提议 | 不保存原始输入正文 |
| `turn_receipt` | 固定策略、Proposal、动作和精确版本 | 不等于模型完成或执行回执 |
| `turn_memory_candidate` | 存放待用户确认的记忆候选 | 不是 Memory Ledger，也不自动进入上下文 |
| `turn_evaluation_case/run` | 评测策略是否漏选、误选或越过 scope | 不替代真实业务 Outcome 评测 |

`Turn Receipt` 可以建议六个动作：`context.resolve`、`capability.discover`、`workflow.route`、`work.prepare`、`memory.candidate`、`evaluation.observe`。它们全部是下一步**建议**；后续模块仍会独立执行权限、健康、预算、环境和验收校验。

## 候选记忆与正式记忆

候选遵循 `candidate → accepted | rejected | revoked`。只有明确 `accepted` 后，Craft 才以原始 Source、scope、sensitivity、Evidence 与有效期写入 `MemoryLedger`；`confirmed` 或 `procedural` 仍需要现有 Evidence 规则。这样普通闲聊可以提出有价值的知识候选，但不会把每轮聊天自动变成长期事实。

## 评测与安全

`Turn Evaluation` 使用内容无关 fixture 比较预期和实际动作，输出决策准确率、误触发数与 scope 拒绝数。它用于单点评测；真实工作效果仍由现有 Trial、Outcome、Acceptance、Campaign 与 Signoff 链路证明。

所有 Proposal、Receipt 和评测 Case 均拒绝凭据形态的文本；scope 不一致、失效 Policy、未激活或不可信知识源均失败关闭。候选记忆的采纳仍遵循 `KnowledgeMemoryRuntime` 的 Source/证据/敏感性边界。
