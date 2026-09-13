# Craft v0.12.4：自主运行与平台化能力收敛

## 发布边界

v0.12.4 把此前差距分析中的 P0/P1/P2 收敛为可验证的本地内核契约，并继续保持失败关闭：

| 方向 | 本版实现 | 证据 |
| --- | --- | --- |
| P0 自主运行 | Provider-neutral Autonomous Runtime，步骤/Token 上限、Action 结果、Checkpoint、Resume、Cancel | `src/autonomous-runtime.ts`、`craft_autonomous_runtime_*` |
| P0 状态恢复 | 每个 Action 自动留下状态摘要和 checkpoint，恢复只接受同一 Run 的精确 checkpoint | `autonomous_run` / `autonomous_checkpoint` |
| P0 普通入口 | 通过 MCP 提供目标、脚本化模型回合和受限 Action 记录入口；现有 Guided Work/Workbench 继续作为 UI 投影 | `CraftService.autonomousRuntimeRun` |
| P1 能力资产 | 统一 Register → Install → Activate → Disable → Upgrade → Retire 生命周期，升级固定 source digest | `src/capability-lifecycle.ts` |
| P1 记忆 | Episodic → Semantic 整合、范围检索、冲突状态和来源血缘 | `src/memory-consolidation.ts` |
| P1 远程互操作 | HTTPS-only Remote Request、Transport 注入、远程回执和不可信边界 | `src/remote-interop.ts` |
| P1 运营 | 成员角色授权、内容无关观测和可导出的 `craft.observability.v1` | `src/platform-operations.ts` |
| P2 接入 | 上述能力同时进入 Full MCP；默认 syscall 仍保持小工具面，按 resource/operation 动态寻址 | `src/mcp.ts` |

## 诚实边界

本版实现的是可组合、可测试、可替换的内核和 Adapter 契约，不把本地记录伪装成生产基础设施：

- 真实 Windows/macOS/Linux OS 沙箱仍由平台 Adapter 提供并通过既有 Conformance 验收。
- Remote Interop 的网络、认证、流式传输和取消由受信 Host Transport 注入；Craft 不暗中发送凭证或授予远端执行权。
- 真实模型供应商仍由 Model Gateway/Host Driver 提供；脚本化回合入口只用于确定性测试、回放和 Adapter 验证。
- OTel、团队身份服务、云端 Registry、Marketplace 审核仍是外部部署集成，不在本地仓库虚构上线状态。

## 验收

- 增量测试：`tests/v0124-platform.test.ts`，5 个测试全部通过。
- 类型检查：`tsc --noEmit` 通过。
- 版本门禁：`scripts/check-version.ts` 通过，package、Service、Codex/Claude、WorkBuddy、DeepSeek、README 对齐到 v0.12.4。
- MCP：新增能力均有 Full MCP handler；默认 syscall 不扩张，继续保持低 Token 路由面。

## 下一步

下一阶段应把本版契约接到真实 Provider Host、跨平台沙箱和 HTTPS A2A Transport，再用真实业务 Eval Runner 验证成本、延迟、成功率和安全回归；在这些证据出现前，不应宣称 Craft 已经是云端多用户 Agent 服务。
