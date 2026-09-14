# Uncertainty Policy 只升级求证强度

Craft 使用 Core Safety Floor → Global Default → Project → Task/Case 的规则层级处理不确定性，越具体的配置只能收窄行为或提高要求。当证据不足、指标落入灰区或评审冲突时，Policy 可以继续采证、请求人工、弃权、保持旧状态、拒绝或阻塞，并可在预算内增加确定性检查、已批准模型、独立 Evaluator、只读 Expert/Sub-agent 或 Trial；它永不自动扩大 effect、数据范围、凭据权限和自主等级，也不自动发布 Candidate。人工 Adjudication 追加但不覆盖证据，且不能绕过 Core Safety Floor。
