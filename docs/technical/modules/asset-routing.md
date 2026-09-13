# Asset Envelope、路由与跨模型可比性

> 状态：v0.12.1 实现统一信封、只读路由与跨模型比较。**路由只做选择，不激活、不发布、不执行。**

## 为什么要有统一信封

Craft 有三条资产血脉——能力、知识、工作流——各自有命名和各自的"健康"定义。作为独立功能没问题；一旦要为某个任务在它们之间做**选择**，就必须有一个共同形状。

信封是**描述性的**：说明资产是什么、允许触及什么。它不授予任何权限，激活与 effect 门禁仍在原处。

```text
kind · id · version · digest · source
trust      verified | candidate | unverified | revoked
health     healthy | degraded | blocked | unknown
effect_scope   read_only | local_write | external_write | destructive
cost_profile   { tokens, latency_ms }
policy · tags
stability  { core_invariants[], model_sensitive[] }
```

`digest` 是内容寻址的，所以两个内容相同的资产会显出是同一个资产。`assetRef` 输出 `kind:id@version`，这是其他对象应当保存的唯一字符串。

## 路由：两条真正起作用的规则

1. **信任与健康是硬闸。** candidate 或 blocked 的资产不会因为评分好而被静默使用。
2. **成本是预算，不是排序权重。** 任务剩余 token 付不起某个资产时，它被**拒绝并附带理由**，而不是先选上再在执行时失败。

其余按领域标签、必填标签、风险上限（高风险任务只给一个资产）过滤，最后按成本再按延迟排序。每一次拒绝都返回理由，因此"为什么没选它"永远可答。

无可用项时返回 `baseline`（最便宜的候选）而不是猜测，并把"未选择"作为显式理由。

## 跨模型可比性

Craft 的前提是机制稳定、模型可换。这个前提可被验证，本模块就是它的闸门。

- 资产声明 `core_invariants`（每个模型都必须成立）与 `model_sensitive`（预期随模型变化，绝不作为门禁）。
- 一个不变量在每个模型的每次试验中都成立 → **stable**。
- 只在部分模型成立 → 降级为 **model-sensitive 提示**，不再能门禁任何东西。
- 只试过一个模型 → `inconclusive`，而不是通过。诚实答案是"还没测"。
- 所有声明的不变量都没有模型满足 → `rejected`。

只有 `verified` 结论才允许把该资产当作跨模型可用的机制。这是 Craft 相对业界（多数 harness 是单模型评测）的差异化能力。

## 边界

- 路由是只读投影：不激活能力、不发布资产、不执行动作。
- 不变量来自声明，不由模型推断。
- 未验证：真实多模型评测（本机无网络、无密钥）。
