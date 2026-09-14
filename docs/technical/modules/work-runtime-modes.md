# Console 与独立 Agent 运行模式

Craft 的稳定内核不属于某一个模型或 Host。v0.12.19 用同一个 `WorkRuntimeMode` 表达两种产品形态：

```text
Console mode: Craft → Codex / Claude / IDE / MCP Host
Agent mode:   Craft → 选择 model + Host + Profile → Verified Work Loop
```

两种模式都只生成 digest-pinned `WorkRuntimePlan`，引用既有 Task、Activation Profile 和 Context Resolution Receipt。Plan 的状态固定为 `ready_for_verified_work_loop`，不直接发起模型调用、终端命令或外部写入。

- Console mode 将用户已选 Host（例如 Codex）作为执行者；
- Agent mode 要求明确模型与允许的 Host 集；首期选择的是配置固定的默认模型/Host，后续模型路由器可替换此选择器，但仍通过同一 Activation、Policy、Receipt、Acceptance、Eval 和 Canary 链路；
- 切换模型、Host、Skill/MCP 或执行环境会形成新 Plan，旧 Receipt 不可复用。

因此 Craft 可以逐步提供 CLI、Web 或 API 的独立 Agent 入口，而无需复刻 Codex 的模型、终端或桌面应用。Host 的模型调用与原生工具仍由对应 Adapter 实现和验证。
