# Delivery Control Loop

> 状态：v0.11.46 已实现机制闭环；不代表任何具体业务效果已经提升。

## 目的

这一模块把已有的 Host 回执、独立验收、交付观察、评测和安全预检连接为一个可恢复的最小闭环。它解决“任务跑完以后下一步是什么”的控制面问题，不替代模型规划、业务验收或宿主执行。

```text
Host receipt / Acceptance assessment
              ↓
      immutable WorkDelivery
              ↓
      DeliveryLoop next action
              ↓
Workbench / MCP: deliver, collect_acceptance, retry_or_handoff, human_handoff
              ↓
sanitized Case × exact environment/budget → evaluation aggregate → Signoff recommendation
```

## 已实现的十项协作能力

1. Host 终态自动生成交付循环投影。
2. 验收更新会刷新同一交付循环，而不是依赖模型口头汇报。
3. `ready_for_delivery`、`accepted`、`awaiting_acceptance`、`blocked`、`host_failed` 和 `rejected` 映射为有限下一动作。
4. 循环状态是摘要绑定、版本化记录；相同事实幂等，事实变化新增版本。
5. Work Launch 查询与 Workbench 都显示交付状态和下一动作。
6. 脱敏 Case 可批量汇总多个不可变 Delivery Comparison。
7. 聚合固定相同环境和预算指纹，输出 improved/equal/regressed 数量。
8. 只有足量、无回归且全部 held-out 的样本才会给出 `signoff_required`；它仍不晋级、不发布。
9. 本地平台 Probe 只记录实际 Node/平台健康，不会把检测到的工具冒充为隔离保证。
10. 安全 Work Launch 可选绑定平台预检；写入必须精确复验 active、verified、network-denied Profile，缺失或漂移失败关闭。

## 边界

- `DeliveryLoop` 不执行 retry、发布、删除或外部写入；它只返回下一步建议。
- `DeliveryEvaluationRun` 汇总已观察的比较，不运行模型、也不替代程序/模型/人工 Grader。
- `eligible_for_signoff` 的含义只是“可送入既有 Signoff Gate”，`promotion_eligible` 始终为 `false`。
- 不带平台 Profile 的普通 read-only 启动仍可便携运行；只有显式写入绑定才要求已验证且默认拒绝网络的边界。
- `platform_execution_probe` 是健康遥测，不是沙箱认证。真实隔离仍需要 Sandbox Profile、证据与部署环境验证。

## MCP 使用面

核心 MCP 暴露查询、交付循环刷新/读取、比较汇总及平台预检/Probe；`craft-mcp-full` 继续保留旧工具。MCP 只负责状态和证据，实际 Host 启动、工具启停与写入授权仍由宿主和既有安全协议决定。
