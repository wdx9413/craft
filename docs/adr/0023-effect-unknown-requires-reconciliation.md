# ADR-0023：effect_unknown 必须先 Reconcile

状态：Accepted（v0.12.35）

网络中断、Receipt 丢失或 Host 重启时，外部副作用可能已经发生。Craft 将 Attempt 标为 `effect_unknown`，恢复只能检查已有幂等键、取得 Receipt 或请求人工确认；系统不得自动再次提交。确认成功只形成运行事实，业务 Outcome 仍需独立 Acceptance。

