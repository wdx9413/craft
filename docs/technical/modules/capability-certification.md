# Capability Certification：候选能力认证与晋级

## 目的

Materialization 只证明内容来自已信任目录且通过基础审查，不证明能力有效。Certification 将 candidate 与真实 held-out 评测、沙箱运行回执、程序 Grade 和 Signoff 绑定，避免“下载成功”或“模型自评通过”直接变成可信能力。

## 认证条件

- 固定 Materialization、Capability Asset、Sandbox Profile 的精确版本。
- Source 与 Catalog Entry 仍 active，内容摘要未变化。
- Evaluation Run 必须是该 Capability Asset 精确版本的 `held_out + passed`。
- 每个 Trial 必须有一一对应且不可复用的 passed Sandbox Receipt；Task、Profile 版本和 Evidence 必须一致。
- 每个 Trial 的 Outcome 必须 passed 且带 Evidence。
- Signoff 必须属于同一 Evaluation 和资产版本。
- 每个 Trial 至少有一个带 Evidence 的 passed program Grade；模型或人工判断不能冒充程序证明。
- Materialization reviewer、certifier、promoter 分离。

## 晋级

认证先产生 `eligible` 记录且不授予执行权。独立批准晋级时，Craft 再检查资产、Materialization、Source、Entry 和摘要没有漂移，然后在一个事务中：

1. 将 Capability Asset 从 `candidate` 变成 `verified`；
2. 将 Materialization 标记为 `certified`；
3. 将 Certification 标记为 `promoted`。

即使成为 verified，Capability 仍须经过任务级 Capability Planning、Sandbox、Budget 和 Autonomy；认证不是执行令牌。

## 当前边界

当前内核消费既有 Trial、Receipt、Grade 与 Signoff，不替 Host 自动运行评测。不同领域应提供自己的 held-out Suite 和确定性/人工验收器；不能把软件测试作为视频、销售或教育任务的通用专业标准。

