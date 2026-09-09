# Capability Canary：能力灰度与运行证据

Capability Canary 用真实运行样本回答“新能力是否比当前能力更可靠”，而不是把发布成功当作质量证明。

- 绑定一个 active Contract Publication、精确 baseline/candidate Capability 版本。
- 使用稳定 routing key 做粘性分流，候选比例限制在 1%–50%。
- 每个样本记录 arm、成功/失败、成本、时延、是否发生人工修正以及 Evidence。
- baseline 与 candidate 都达到最小样本数后，才计算失败率差、成本比、时延比和人工修正率差。
- 任一指标越界即把 Canary 标记为 `halted`，新请求全部回到 baseline，并设置 `rollback_recommended=true`。
- 没有退化时进入 `ready_for_promotion`；Canary 本身不自动扩大流量，也不直接执行回滚。

回滚仍走 Contract Publication 的精确版本所有权检查；如它会影响外部系统，还必须走 Autonomy Policy。当前内核不声称统计显著性，最小样本和阈值由领域 Eval Policy 决定。

