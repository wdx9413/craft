# Internal Host：Craft 自己跑循环

> 状态：v0.12.4 实现内建宿主驱动、六道熔断、平台化 Autonomous Runtime 契约与显式 dispatch 恢复入口，并提供基于平台 fetch 的模型传输；默认仍需用户配置 API Key。

## 为什么是"第三个 Host Driver"

Craft 的第二种形态是自己跑循环，而不是把工作交给 Codex 或 Claude。实现上它是与 `codex-cli`、`claude-code` **并列**的第三个 Host Driver，产出同样的 `internal_dispatch` / `internal_receipt` / 事件记录。

这一点很重要：如果自己跑是一套新机制，那么"自己跑"和"治理别人跑"就无法用同一套 harness 比较；做成同一个 driver 之后，两者只在执行后端上有差别。

## 熔断（外部检测，不靠模型自述）

实测证据：智能体几乎不会主动报告自己卡住（约 5%），死循环也不是边缘情况（6549 个仓库中确认 68 例）。所以每一道闸都必须是 Craft 拥有的显式上限，而不是 prompt 里的一句话。

| 闸 | 触发 |
| --- | --- |
| `step_limit` | 步数超过上限（默认 30） |
| `token_limit` | 累计 token 超过上限 |
| `wall_clock` | 墙钟超过上限（默认 30 分钟） |
| `no_progress` | 连续 N 步外部观测摘要无变化 |
| `repeated_action` | 同一 `hash(action + args)` 连续出现 |
| `budget_fuse` | 剩余预算进入熔断带（≤5%） |

无进展的判断依据**外部观测摘要**，不是模型自己的总结。终止状态必须由调用方携带明确的 verdict 关闭，模型说"我做完了"不能单独成为终态。

预算分档与业界一致：green（>50%）正常、yellow（20–50%）压缩、red（5–20%）降级、fuse（<5%）带部分结果中止。

## 动作白名单

循环可以调用的 Craft 操作是 facade 上的显式白名单，目前只限读与记录：`capability_search`、`knowledge_search`、`task_checkpoint`、`evidence_record`、`artifact_register`。

这是有意的权限边界：一个由 Craft 自己跑的循环，不应该能够调用受治理宿主需要审批才能做的操作。扩大它的权限永远是显式编辑这张表，而不是注册表变化的副作用。不在名单上的动作失败关闭。

## 边界

- 本版**不含网络客户端**，默认 transport 拒绝并指出缺少的环境变量。
- Host 侧执行仍由既有 Host Driver 负责；internal host 是通过模型网关驱动。
- 熔断是机制性的，但仍需要调用方在 `halted` 为真时立即停止。
- 未验证：真实模型下的循环行为（本机无网络、无密钥）。

## 自己跑的时候，Craft 就是宿主——包括历史

这一条容易被忽略，但它是自托管的定义性后果：交给 Codex 或 Claude 时，对话历史由**它们**持有，Craft 只拿到一个查询并只留 `query_digest`。而当 Craft 自己跑循环时，**没有别人持有历史**，所以它必须自己持有并自己压缩。

于是 `internal-host-driver.ts` 在每一轮构造模型请求之前做这件事：把 `internal_session` 里的 `messages` 按 `limits.max_context_tokens` 交给 `compactConversation`（估算器是 `estimateTokens`，与成本控制共用同一个度量），压缩结果写回 `internal_session`，同时落一条 `context_compaction`。

压缩策略是两段式，而不是"超出就丢"：

```text
保留 system（系统约束不能丢）
  + 从最近往前填到预算 65% 的 tail（最近的工作不能丢）
  → 中间被省略
  → 第一段：规则省略（确定性，不调模型）
  → 第二段：可选模型摘要；没有模型时回退成确定性、无内容、带 digest 的笔记
```

工具结果的溢出是**另一条**路径，不要与压缩混淆：单条过大的工具结果被截成"有说明的头部"，而不是把对话挤掉。

这也解释了 `history` 为什么不因为自托管而变成第四个可插拔成员：变的是**宿主是谁**，不是哪个成员的性质。让 Craft 托管**外部**宿主的历史才是一次需要写明理由的改动，见 [上下文的五个成员](context-members.md)。

## 相关模块

- [Model Gateway](model-gateway.md)：provider 声明与请求/响应归一化。
- [Tool Plane](tool-plane.md)：循环可寻址的 Craft 操作面。
