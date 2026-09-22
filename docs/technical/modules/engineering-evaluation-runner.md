# Engineering Profile 的真实 Host 评测

`pnpm engineering:eval` 是 Engineering Quality Profile 唯一的执行入口。它必须显式给出模型、Case 目录、Craft 本地 Store、归档目录、时限、输出上限和 `--trials 5`；没有隐式默认执行。

每个 arm 都从版本化 fixture 复制到临时目录，使用 `codex exec --json --ephemeral --sandbox workspace-write --ignore-user-config --ignore-rules`。fixture 只允许 `node` argv 数组；不经 shell、没有任意 Prompt/Graph/网络 effect，临时目录在结束后删除，不使用 Git worktree。

自然语言终态不是验收事实。归档的 `VerifiedEvaluationReceipt` 分别引用 Host 终态、冻结输入、前后快照、验收、两个 sibling、effect、安全、事实与根因程序 Evidence。根因 Evidence 的最低标准是：Host 运行前在冻结副本中由声明的验收程序复现缺陷，且该复现步骤不能改写副本；它不是对模型自然语言诊断的替代或证明。事实 Evidence 由验收与两个 sibling 的独立程序结果组成，不能再由“工作区发生了变化”推导。任何一项失败、超时、取消、截断或越权都只能形成拒绝/handoff，不能写 `verified`。历史直接写入继续是 `revalidation_required`，且该导入入口不在 MCP surface。

普通 PR CI 仅验证 fixture 和单元测试。真实评测仅能由 `main` 的 `workflow_dispatch` 在受审批 `codex-evals` Environment 中运行；其权限只有 `contents: read`，`OPENAI_API_KEY` 只传给实际 Codex 步骤，不能推送、开 PR 或合并。12 Case × 5 完整配对才可能进入 Shadow；单个/三次运行仅是诊断。
