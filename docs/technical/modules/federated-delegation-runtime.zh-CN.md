# 联邦委派与受限多 Agent 运行时（v0.12.16）

> 状态：本地控制面和脱敏测试已实现。网络传输、远端身份、Broker、Sandbox 与业务质量仍由部署 Adapter 和真实评测证明；Craft 不把本地记录冒充为远端执行成功。

## 目的

Craft 保持单 Agent 为默认 Harness，但支持在证据足够时按需启用本地 Expert、独立 Evaluator 或远程只读 Agent。v0.12.16 将此前的 A2A Session 与摘要协议补成可撤销的授权和可观察的远程生命周期。

```text
single-Agent baseline + confirmed Evidence + human trust
                         ↓
                 A2A Delegation
                         ↓
     healthy exact Agent Card + Delegation Grant
                         ↓
        scoped Artifact Grants + one-time consume
                         ↓
 Host/Adapter transport and remote task lifecycle receipt
                         ↓
  matching environment/effect/Evidence => remote Receipt
                         ↓
       paired evaluation => eligible topology or baseline
```

## 1. Federated Delegation

`FederatedDelegationKernel` 不建立第二套 A2A Session，也不直接联网。它只补上 A2A 控制面中以前缺失的五件事：

- `federated_agent_health` 固定 Agent Card 的版本和 digest；健康未知、退化或 Card 漂移均拒绝签发。
- `Delegation Grant` 同时绑定 delegation、父 Task Run、父操作、远端 audience、已声明 Capability、Artifact 范围、只读 effect 和原 delegation 到期时间。
- Grant 必须由精确 audience 一次性消费；消费前会再次核对当前 Card 与健康记录。
- `Artifact Grant` 按 Artifact 精确版本派生，只传引用和 digest，不能加进未在 A2A delegation 中声明的对象。
- `federated_remote_receipt` 必须匹配父 Task Run 的环境摘要、`read_only` effect、全部 Artifact Grant 和 confirmed Evidence。超时没有终态 Receipt 时进入 `indeterminate`，要求 Adapter 轮询或人工审查；绝不假定成功。

Grant 与 Artifact Grant 可撤销。旧的 `craft_a2a_delegation_*` 为兼容而保留；新接入应使用 `craft_federated_*` 路径，不将旧的摘要协议入口当作权限授权。

## 2. Harness Topology

`HarnessTopologyKernel` 的强制规则：

- baseline 只能是 `[primary]`；因此默认不会多 Agent。
- candidate 最多增加两个设计轴、总 Agent 数最多五个，委派上下文固定为 `reference_only`、委派 effect 固定为只读。
- candidate 先是 `shadow_only`。只有已具备 `eligible_for_signoff` 的配对评测和 confirmed Evidence，才变为 `routing_eligible`。
- 发生质量、成本、环境或安全回归时可 suspend；选择器随即回到单 Agent baseline。

它并不自动启动 Agent。Host 仍使用已有 Expert Runtime、Work Coordinator、Campaign Runner 和 A2A Adapter 实际执行。

## 3. Runtime Readiness

`RuntimeReadinessKernel` 将“还缺部署什么”固定为版本化 Assessment：

- `read_only` 仅在已有 confirmed Evidence 时为 portable ready。
- `local_write` 还要求 Workspace recovery 与可验证的、禁网的 Platform Preflight。
- `external_write` / `destructive` 还要求 active Enterprise Adapter Binding；破坏性动作必须声明补偿或人工处置引用。
- Assessment 只报告 `ready` 或 blockers，并固定环境摘要；`deployment_claimed` 永远为 `false`。

这使 Windows、容器、企业 Broker 或真实远端 A2A 的未部署状态显式失败关闭，而不是因为代码中存在某个 Adapter 类就被误认为可用。

## MCP 面与非目标

- 默认 `craft-mcp` 只读 `federated_delegation_get`、`harness_topology_get`、`runtime_readiness_get`；不会暴露签发、消费或拓扑晋级。
- `craft-mcp-full` 提供显式治理动作，仍受 Profile、Evidence、审批和 effect 规则限制。

本版不提供远端 Token 透传、自动安装远端 Agent、默认多 Agent、跨组织信任市场、exactly-once 远程执行、真实 Sandbox/Broker 服务或自动业务发布。它们必须通过部署 Adapter 与真实脱敏 Case 逐项证明。
