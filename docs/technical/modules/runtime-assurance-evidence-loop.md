# Runtime Assurance & Evidence Loop（v0.12.17）

> 状态：本地实现并有脱敏测试。它证明 Craft 已收集到的事实彼此一致；不把本地记录冒充为对未接入 Host、外部系统或操作系统隔离器的控制。

## 目的

`RuntimeAssuranceKernel` 是现有 Task Run、Host Receipt、State Workspace、Delivery、Platform Conformance 与 Eval Campaign 之上的小接口，不再另建一套执行状态机。

```text
Task Run + terminal Host Receipt
        + pinned environment / budget
        + current re-observation
        + (write => verified platform preflight)
                         ↓
             Runtime Assurance Attestation
                         ↓
  every bound Campaign slot has matching attestation
                         ↓
          existing Campaign / Benchmark / Signoff gate
```

它回答的是“这条已发生的 Host 尝试是否仍可作为本次交付或比较的证据”，而不是“模型是否真的理解业务”。

## Attestation 规则

一个 Attestation 固定 Task Run、终态 Host Run、环境与预算摘要、effect、再观察、Delivery 和 Evidence 引用。

- Host `completed` 不是自动 verified：还需要当前 Workspace Observation 或 Verified Work Loop Receipt。
- 观察到无归属的 Workspace 变化，状态为 `needs_replan`。
- 环境或预算摘要不一致直接拒绝，不能复用旧 Host Receipt。
- `local_write`、`external_write`、`destructive` 还必须引用当前有效的 `PlatformExecutionPreflight`；其 Profile 要有已验证的禁网/工作区/凭据/取消/资源 Conformance。
- Attestation 只保存摘要、版本和引用，不保存 Prompt、业务正文或秘密。

`Runtime Intervention` 是与 Task Run 关联的追加账本，记录 approval、pause、resume、timeout、cancel、retry、revoke、handoff 等人工或运行时干预。它不替代真实暂停/取消动作；Host Adapter 仍负责执行并交回 Receipt。

## Eval Campaign 规则

`runtimeAssuranceCampaignAdvance` 先确认每个已绑定 `Case × Harness × Trial` slot 都有相同环境、预算且 `verified` 的 Attestation，才委托已有 Campaign Runner 聚合。由原有 Benchmark、held-out、重复 Trial、Judge 校准、Signoff 与 Canary 决定是否可晋级。

本模块不会启动隐藏 Host、伪造 Trial/Outcome、因单次 Host 自述发布 Candidate，或自动启用多 Agent、修改 Skill/Workflow/Prompt。

## 外部 Connector 的配套边界

外部 Connector（GitHub/火山 Skill、MCP、Serena）固定用户批准的最小 `allowed_operations` scope、与 metadata digest 绑定的 content-free health receipt、消费 ticket 时的二次 scope/health/version 核验，以及不可逆 revoke。Serena 仍只登记为 read-only Connector；Craft 不写 Serena 文件。

## MCP 面

- 默认 core 面：`runtime_assurance_get`、`runtime_assurance_intervene`，以及 Connector list/ticket 的受限路径。
- full 面：Attestation、Campaign advance、Connector register/discover/health/revoke 等显式治理动作。

Host 决定真实启停 MCP、凭据、网络与执行环境；Craft 只签发可核验的 Profile/票据并验证回流事实。

v0.12.17 之上的 [Assured Pilot](assured-pilot.md) 会进一步把已验证 Attestation、Runtime Readiness、恢复演练、可信 Capability 版本与密封评测引用固定为同一条事实链；它仍不替代真实部署 Adapter。
