# Claude Code Host Driver

v0.11.3 通过统一 `HostDriver` 协议接入 Claude Code 的非交互模式。

- 固定使用 `claude -p --output-format stream-json --verbose --no-session-persistence`。
- 只读模式使用 `plan` 权限，只暴露 `Read,Glob,Grep`。
- 工作区写入在 Craft 一次性授权后使用 `acceptEdits`，只增加 `Edit,Write`，不开放 Bash。
- 两种模式都通过 `--disallowedTools mcp__*` 排除未经 Craft 建模的 MCP 副作用，并使用 `--permission-prompts none` 防止无人值守任务悬挂。
- 支持 `max_turns`、可选 `max_budget_usd`、进程超时、输出上限、Stream JSON 校验、成本/Usage 回执和敏感赋值脱敏。

当前开发机未安装 `claude`，所以兼容性由官方 CLI 契约和注入式进程测试证明；发布前仍需在安装 Claude Code 的 Windows、macOS 和 Linux 环境执行真实二进制矩阵。
