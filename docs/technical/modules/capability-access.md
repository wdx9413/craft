# Capability Access：上下文、能力选择与短期调用票据

## 职责

`CapabilityAccessKernel` 收敛两条容易混淆、但必须分开的能力路径：

```text
Capability Source → Logical Capability → Logical Activation Plan → read-only Context

Capability Asset / Connector Asset → Activation Profile → Call or Connector Ticket → Host
```

- 第一条路径只把已索引的本地 Skill 正文作为受限只读上下文，不授予调用或写入权。
- 第二条路径只从受治理的 Capability Asset 中选择当前 Task 最小可用集，并用短期票据绑定精确版本和 Profile。
- Kernel 不发现、安装、启动或执行 Host；这些副作用仍由 Host 或 Connector 的显式管理流程负责。

## 对外稳定接口

`CraftService` 仅作兼容转发，既有 MCP/CLI 契约不变：

| 操作 | 产物 | 关键保证 |
| --- | --- | --- |
| `logicalActivationPlan` | Logical Activation Plan | 仅接受 `read_only`，固定来源摘要与可选 Context Profile 版本 |
| `logicalActivationAudit` / `Resolve` | Audit / Resolution | 重选、摘要漂移或缺失时不加载正文 |
| `assetSave` | Capability Asset | 校验类型、trust、health、effect 与无敏感来源描述 |
| `accessPlan` | Activation Profile + Tool Selection Receipt | 优先最小、可信、健康、effect 匹配的 Asset；记录过滤和排序依据 |
| `callIssue` / `callConsume` | Capability Call Receipt | 绑定 Profile，单次消费且会过期；Connector Asset 必须走 Connector Ticket |

## 非目标

- 不把搜索命中当成授权。
- 不把 Activation Profile 当成完整上下文正文。
- 不将票据消费视为 Host 执行成功；后者仍需要 Host Receipt、状态重新观察和 Acceptance。
- 不替代 `CapabilityConnectorKernel` 的外部来源批准、版本钉扎和 Connector Ticket 校验。

## 验证

覆盖场景见 `tests/capability-access.test.ts`、`tests/capability-activation.test.ts`、`tests/capability-connector.test.ts`：不安全或失效 Asset 不能进入 Profile；内容漂移不可解析；票据不能跨 Profile、过期或重复消费；Connector 不能绕过专用 Ticket。
