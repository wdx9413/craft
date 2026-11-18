# ADR-0034：Codex 使用 craft-context 插件后的通用自进化方案

状态：Accepted

## 背景

用户目标不是让 Craft 变成一个独立大平台，而是：**Codex 安装 `craft-context` 插件后，日常对话与真实任务能持续提升各场景效率**。现有能力已经具备三块基础：

1. Hook 层：`craft-context` 在 Codex 的 SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd、PreCompact 上运行 `craft-codex-hook.cjs --member context`。
2. MCP 层：`craft-context` 暴露 Knowledge、Memory、Experience、Codebase 与统一 Context 工具面；`component-context-agent` surface 还包含 procedure invocation / gate / runbook 等 Experience 状态工具。
3. 内核层：Knowledge/Memory/Experience 三账本、本体论概念标签、Mod 生命周期、Procedure/Workflow 候选与晋级门禁、Craft Notes 设备/目录/文件 typed notes。

缺口不在“没有存储”，而在“从日常场景到可复用能力”的闭环没有自动驱动：用户明说的规范/偏好/事实已能入账本，但办公、编程、旅游、AI 创作、科研中大量“做过一次才知道怎么做”的经验，仍不会稳定地变成程序记忆、技能、行为约束或可评测候选。

## 决策

### 1. Codex 插件定位为入口，不是自进化主运行时

`craft-context` 在 Codex 中负责：
- 触发：SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd/PreCompact。
- 收集：用户明确陈述、工具信号、验证结果、终态 observation。
- 呈现：把有界 Context receipt、capture 摘要和必要的 Mod context additions 返回给模型。
- 调用：通过 MCP 工具面把候选写入 Craft 账本。

自进化主运行时仍放在 Craft core：状态机、证据、scope、expiry、revoke、shadow/hield-out/signoff/canary、digest、receipt 都由 Craft 维护。Codex 不拥有独立记忆库，不直接发布 Procedure/Mod/Skill。

### 2. 引入 Evolution Value Gate 作为统一写入判定

所有“是否值得沉淀”的判断经过同一个 gate，而不是散落在 hook、模型提示或各能力内部。输入包括：用户陈述、工具轨迹、验证结果、重复次数、scope、evidence、artifact/domain 标签。输出只能是：

- `store_as_fact`
- `store_as_preference`
- `candidate_procedure`
- `candidate_mod`
- `ignore`
- `needs_review`

Gate 只产生候选和理由，不改变执行权限，不把推断写成事实。五个通过条件：可独立理解、重复或高价值、可验证/有来源、带适用边界、可治理。

### 3. 以 Experience 工作流状态为自进化主干

craft-experience 已有足够的状态骨架：`experience_observe/patterns_list/procedure_draft/submit`、`experience_learning_evaluation_*`、`procedure_gate`、`procedure_invocation_bind/dispatch/report/resume/transition`、`runbook_capture/revoke`、`asset_inspect/restore`。自进化应把这些状态串成主链：

```text
用户陈述 / 工具轨迹 / 验证结果
        ↓
Evolution Value Gate
        ↓
Knowledge/Memory 记录  ──证据──>  Experience Observation / Pattern
                                      ↓
                              Procedure Candidate / Runbook
                                      ↓
                       Shadow / Held-out / Signoff / Canary
                                      ↓
                         routeable Procedure / Skill / Tool
                                      ↓
                         Procedure Invocation 状态与反馈回流
```

Record 是事实层，Procedure 是可复用技能层，Mod 是行为约束层；三者通过 evidence 与 digest 关联，不能各自为政。

### 4. 用户明确口述的通用操作步骤先进入 Runbook/Procedure candidate，而不是直接执行

“怎么操作网页、怎么做 PPT、怎么跑一个科研实验流程”这类口述步骤，若被识别为可复用 know-how，应生成 diagnostic-only 的 Runbook/Procedure candidate。它可读、可评审、可进入 eval，**不能直接路由执行**。只有重复出现、带证据并通过现有门禁后，才能成为 routeable asset。

### 5. Domain Adapter 只做薄适配，不复制内核

coding、office、travel、creation、research 共用 Craft core。每个 adapter 只定义：
- 提取提示词/模式
- 价值阈值
- evidence 类型
- scope/domain 边界
- eval case 模板

官方维护少数核心 adapter；用户/插件可提供候选 adapter；模型只能生成候选，不能直接发布 adapter。

### 6. 创作与办公采用 Artifact Lineage，不存大文件

AI 创作和办公场景记录素材引用、prompt/参数、生成工具、版本、用户评价、最终选择；不把图片/视频/PPT 原文件塞进账本。检索时先按 artifact 类型或模态路由，再做文本相似；低可信或冲突记录降权或 abstain。

### 7. Craft Notes 统一设备/目录/文件语义

所有相关命名使用 Craft Notes，不再使用旧名。Environment place 由 Device Note、Directory Note、File Note 组成；`craft_notes_*` 是唯一工具面，`craft_notes_location` 是位置存储集合。设备/目录/文件笔记为 Procedure/Experience 提供环境作用域，避免把一台机器上的路径误当全局知识。

### 8. 小插件可拆，但不是当前前置条件

当前默认发布一个 `craft-context` 聚合插件，足以跑通闭环。未来可按角色拆 `craft-knowledge`、`craft-memory`、`craft-experience`、`craft-notes` 小插件，用于降低工具面和按角色安装；但所有小插件必须复用同一个 Craft core 与状态机。独立发版会引入版本矩阵和兼容成本，除非有强需求，先不做。

## 场景覆盖判断

| 场景 | 当前 | 目标闭环 |
|---|---|---|
| 编程 | 明说规范/偏好、少量成功 finalize | 错误模式、调试策略、验证过的 patch → Experience → Procedure/Skill/Mod |
| 办公 | 流程偏好 | 会议决议、模板、附件版本、权限、续写状态 → Artifact Lineage + Prospective Memory |
| 旅游 | 偏好 | 行程动态状态、预订证据、时间/地理约束、变更失效 → scoped Memory + Adapter |
| AI 创作 | 风格偏好文本 | 素材/prompt/参数/版本/评价 → Artifact Lineage + style preference |
| 科研 | 事实/术语 | 文献证据、假设、参数、结果、反例、复现步骤 → Research Memory Graph |

## 验收条件

1. Codex 安装 `craft-context` 后，不额外安装 CLI/daemon 也能通过 hook 与 MCP 触发完整写入/读取闭环。
2. 用户明说的 rule/fact/preference 可进入 Knowledge/Memory，并有 evidence/provenance。
3. 口述的可复用操作步骤可生成 procedure/runbook candidate；候选默认不可执行。
4. 重复且验证过的经验可进入 Shadow / Held-out / Signoff / Canary；只有 pass 才 routeable。
5. 五类场景各有一个 craft-eval 最小闭环：write、recall、apply、forget、scope leak。
6. Craft Notes 命名在源码、工具面、文档与新测试中无旧名残留。

## 非目标

- 不做全局行业本体树；不把推理结果写成事实。
- 不自动修改 Craft 代码、权限、UI 或 Host 配置。
- 不把大文件、原始聊天记录和敏感数据塞入账本。
- 不要求用户安装多个插件才能完成日常自进化。
- 不把模型生成的 adapter/procedure/mod 直接发布为可信资产。

## 后果

短期先在 craft-context 单插件内接通 Value Gate、Runbook/Procedure candidate 流程与 Craft Notes 作用域；长期可在不破坏内核的前提下拆小插件。因为状态机与评测仍在 Craft core，拆分只是分发形态变化，不会改变自进化语义。
