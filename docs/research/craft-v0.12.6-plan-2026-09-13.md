# Craft v0.12.6：通用意图与验收闭环

v0.12.6 将 Craft 的核心入口统一到一份与宿主无关的 Task Contract 和 Acceptance Contract。GUI、CLI、Codex/Claude 插件、Trae Adapter、WorkBuddy Expert 和 Skill+MCP 都调用同一编译内核；宿主只负责显示、审批和传输，不再各自解释用户目标。

## 本版实现边界

- `craft_intent_compile`：将自然语言目标编译成持久、可哈希、可恢复的 Task Contract。
- `craft_acceptance_compile`：根据任务类型生成程序、人工或领域验收合同；模型自述不构成完成证据。
- 覆盖率只是一个可插拔的验收器：支持增量/全工作区范围、方法/函数/行/分支/全部指标和阈值。
- 通用目标默认生成 Human Confirmation 验收，而不是把所有任务误判成测试任务。
- 意图含糊时返回结构化澄清问题，失败关闭；重复编译使用幂等摘要拒绝静默漂移。
- 新入口加入 Core MCP，保持低 Token syscall 面；Full MCP 仍作为显式高级入口。

## 统一入口契约

```text
Intent Compiler
  → Task Contract
  → Acceptance Compiler
  → Work Launch / Host Adapter
  → Receipt + State Re-observation
  → Evidence-backed Outcome
```

`craft-route` 仍然是默认轻量 Skill；Skill 只负责路由和澄清，Contract、权限、执行和验收由 Craft 核心实现。后续 GUI、CLI 和各宿主 Adapter 应继续复用这些合同，而不是复制业务判断。

## 非目标

本版不宣称已经提供所有平台的 OS 级沙箱、云端 Registry、生产 A2A Transport 或所有行业的自动修复器。这些能力必须继续通过对应 Adapter、Conformance 和真实 Case/Suite 验收。
