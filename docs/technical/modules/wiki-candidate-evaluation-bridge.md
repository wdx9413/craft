# Wiki Candidate Evaluation Bridge

> 状态：v0.11.35 已实现。它连接既有评测记录与知识候选；不自行运行模型、生成通过结果、写入 Skill/Workflow 文件或启动执行。

一个 Wiki Skill 或 Workflow 候选先由人工标为 `ready_for_evaluation`。`craft_wiki_skill_candidate_evaluation_attest` 只接受下列三份现有、精确版本的证据：

- `eligible` 且零 candidate leak 的 Knowledge Evaluation Run；
- 候选精确版本的 `passed` held-out Evaluation Run；
- 绑定该 Evaluation Run 与候选精确版本的 `passed` Signoff。

在生成 attestation 和人工授权前，Craft 重验候选引用的每条 Claim 版本、审核状态和 Evidence。任一 Claim、检索评测、held-out Run 或 Signoff 漂移都会失败关闭。

评测 attestation 只将候选推进为 `evaluation_passed`。随后 `craft_wiki_skill_candidate_publication_authorize` 还要求一名明确 reviewer 和理由，才会产生 `publication_authorized` 记录。该记录的 `publication_allowed` 仅表示治理层允许后续的人工发布流程；`execution_authority` 仍为 `false`，并且本模块不会向宿主目录写入任何内容。

因此，发布链仍为：知识质量 → held-out 行为评测 → Signoff → 人工发布授权 →（未来由独立、受治理的发布适配器执行）。没有任何一步把模型自述、候选草案或 UI 点击当成实际验证或执行。
