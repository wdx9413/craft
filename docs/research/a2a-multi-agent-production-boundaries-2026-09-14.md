# 远程 A2A / 多 Agent 生产化边界复核

> as_of: 2026-09-14  
> 范围：核验 2026 年官方产品资料与 A2A 规范，回答 Craft 在“默认单 Agent、最多五个只读 A2A 委派、摘要级 HTTPS 传输”基础上，达到**可按需支持远程 A2A / 多 Agent**还缺哪些 P0 能力。  
> 前提：本结论不把“发现 Agent Card”“HTTPS 已连通”或“远端返回 completed”视为远程执行安全、身份可信或业务成功的证明。

## 结论

Craft 当前边界是正确的：**默认单 Agent，远程委派受数量、证据、只读和摘要限制**。但这只能称为“受控远程协作控制面/实验性 transport”，还不能称为“可按需生产委派”。

P0 不是增加第六个子 Agent，也不是自动选远端 Agent；而是补齐一条可拒绝、可撤销、可恢复、可归责的委派链：

```text
已验证身份与版本
  → 最小委派授权（受众、范围、TTL、一次性）
  → 受控数据/Artifact 交换
  → 协议兼容的 Task 生命周期
  → 远端执行/效果的独立证明
  → 根 Task 的状态、成本、安全与 Outcome 收口
```

在这条链未闭合前，应继续只允许人工信任的、只读、摘要级、可人工裁决的研究委派；不允许把远端返回当作可写效果、可复用 Evidence 或自动晋级依据。

## 一手事实与推论

| 来源与日期 | 可核验事实 | 对 Craft 的推论 |
| --- | --- | --- |
| [A2A Protocol v1.0 规范](https://a2a-protocol.org/latest/specification/)（2026 当前规范页） | 规范定义 Agent Card、签名、OAuth2/OIDC/mTLS 等安全方案；支持消息、异步 Task、查询、取消、订阅/推送、Artifact、版本协商、幂等与 in-task authorization。 | HTTPS + 摘要只是传输下限。生产 Adapter 必须按明确 binding 完成版本协商、task 状态、幂等、取消与错误语义；身份、受众、scope 与 Agent Card 签名验证要独立实现。A2A 规范提供互操作对象，不替 Craft 决定信任或效果权限。 |
| [A2A 规范：任务授权与安全要求](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)（2026 当前规范） | `TASK_STATE_AUTH_REQUIRED` 仅将“需要授权”交回 client；规范不定义授权 scope、凭据表示、有效期或撤销，且状态迁移本身不等于操作已授权。规范也要求按授权范围处理 task 查询/取消，并对 webhook URL、来源和幂等做安全处理。 | Craft 必须自有 `DelegationGrant`，绑定父 Run/Operation、主体、受众 Agent、skill/effect/data scope、预算、TTL、审批和撤销标识；A2A 的待授权状态不能替代它。回调/订阅必须防 SSRF、验签/认证、匹配 task id 并幂等。 |
| [MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)（现行规范） | HTTP MCP 使用 OAuth 2.1/Protected Resource Metadata；访问令牌应绑定 resource/audience，服务器必须校验 audience，规范禁止 token passthrough。 | Craft 的外部 MCP / A2A 连接器应从可信 Broker 获取 profile-bound、短期令牌，不转发用户或父 Agent 的通用 bearer token；令牌、scope、受众与过期时间必须出现在授权 receipt 中。 |
| [OpenAI Agents API](https://openai.com/index/introducing-the-agents-api/)（2026-09-10） | 官方把长程状态、工具、子 Agent 协调和持续运行作为 Harness/基础设施能力；示例公开 `max_concurrent_subagents`。计算环境可由托管或客户侧选择。 | “最多五个”只是并发上限的一项。每个根 Task 还需统一的容量、token/费用、超时、取消、失败传播、父子 Trace 与环境绑定；远端计算环境必须作为明确受信 Adapter，而非以 Agent 名称推断。 |
| [OpenAI 长程模型安全复盘](https://openai.com/index/safety-alignment-long-horizon-models/)（2026-07-20） | 官方报告长程行为会暴露预发布评测未覆盖的失败，后续加入轨迹级监控、暂停/恢复和更强用户可见控制；明确固定 Eval Suite 不足以覆盖所有行为。 | 委派链需要跨 Agent 的**序列级**风险监测：异常数据请求、未批准的对等协作、权限/端点漂移或超预算应即时暂停、撤销后续授权并进入人工处理；只记录最终摘要无法支撑事后判断。 |
| [OpenAI 研究 Agent 使用测量](https://openai.com/index/research-acceleration-view-inside-openai/)（2026-09-06） | 高并发使用会计入下游 subagent；在已成功的 4–8 小时任务中，超过一半有至少一次人工干预。 | 远程委派的完成率、人工干预、重试、成本、时延、失败/安全事件都必须归并到根 Task，作为是否启用该 Agent/Profile 的评测数据；不能只按单次远端答案判断收益。 |
| [OpenAI Prompt Injection 防御](https://openai.com/index/designing-agents-to-resist-prompt-injection/)（2026-03-11） | 官方将外部内容导致的操控视作多方信任问题，指出防护不能只依赖过滤输入，而要限制被操控后的影响范围。 | 远端 Agent 的消息、Artifact 和链接都是不可信输入，即使 Card/transport 已信任。进入本地 Context 前需按数据分类、大小、内容扫描、引用解析和用途白名单处理；远端结果不得携带可执行指令或隐式扩权。 |
| [Anthropic 并行 Agent 实验](https://www.anthropic.com/engineering/building-c-compiler)（2026-02-05） | 16 个 Agent 在独立容器工作副本中工作，并用任务锁减少重复；文章强调在容器而非宿主机运行。 | 将来若从“只读委派”升级为任何写入型多 Agent，P0 前置条件是隔离工作副本、对象/任务锁、ChangeSet、合并验证与冲突裁决。不能用共享目录和自然语言协调取代这些边界。 |

## Craft 已有基础与 P0 缺口

以下“已有”按当前仓库描述与实现边界理解：默认单 Agent、最多五个只读委派、Agent Card 发现/人工信任、摘要级 HTTPS envelope、根任务预算/证据引用。它们是必要基础，不是下面 P0 的替代品。

| P0 能力 | 为什么现有边界不足 | 最小可验收定义 |
| --- | --- | --- |
| **1. 远端身份、委派授权与撤销** | HTTPS 认证服务器，不认证“哪个 Agent/组织代表哪个主体”；A2A 的 `auth-required` 也不定义委托的范围或撤销；摘要 envelope 中的 `read_only` 不能强制远端遵守。 | 为每个受信远端建立可轮换身份锚点（OIDC workload identity 或 mTLS），验证 Agent Card 签名/endpoint/版本 digest；签发 Craft 自有、受众绑定、scope/effect/data 限制、预算、短 TTL、单次 `jti` 的 `DelegationGrant`。支持即时撤销、过期拒绝与审计。默认拒绝静态 API key 和父令牌透传。 |
| **2. 受控数据与 Artifact 交换** | digest 不足以让远端完成多数真实任务；一旦补传原文，TLS 只保证链路加密，不能保证最小披露、用途限制或接收方授权。 | 增加 `ArtifactGrant`：按分类/大小/字段/目的、接收 Agent、任务、TTL 与次数授权；内容经脱敏/恶意内容扫描后用临时签名 URL 或加密对象传递。远端返回同样经隔离、扫描、摘要化后才可进入本地 Context。 |
| **3. A2A 协议兼容的可靠生命周期** | “POST 后 accepted/completed”不能区分网络超时、重复提交、远端已执行但本地未收据、取消竞争和协议版本漂移。 | 实现一个版本固定的 A2A binding Adapter：幂等键、版本/扩展协商、状态轮询或订阅、heartbeat/lease、cancel 确认、指数退避与明确 `indeterminate`。不承诺分布式 exactly-once；所有可写未来效果须有幂等/补偿，歧义状态进入人工处置。 |
| **4. 远端执行与只读约束的可验证证明** | 人工信任、Card 和远端自述无法证明远端没有使用凭据、外网、写入工具或额外子 Agent。 | 将远端纳入信任等级：初期只接经过 Conformance 的 read-only Adapter。每次运行收集签名或可验证的环境/Policy/工具集 digest、效果清单、网络/数据出口摘要、执行时间与 remote receipt；缺失、漂移或不可验证时结果只能是 `unverified`，不能作为 Outcome/Evidence 晋级。 |
| **5. 分布式 Trace、安全监测与人工控制** | 最终摘要无法重建父子因果、成本和安全事件；长程风险可能出现在多个 Agent 的组合而非单一请求。 | 将 root run、delegation、remote task、artifact grant、授权/撤销、环境指纹与 receipt 建成相关 ID 链；监测越域 Artifact 请求、未批准端点、重试风暴、预算异常和身份/版本漂移，自动 pause/revoke。Workbench 显示委派对象、数据范围、状态、费用和人工接管入口。 |
| **6. 真实评测与准入** | “单 Agent baseline eligible”是正确前置门，但不能证明某远端/多 Agent 配置有净收益。 | 在同一脱敏 Case、环境、预算与验收器下，比较单 Agent 和一个明确委派变体，至少 3–5 次配对 Trial，记录 Outcome、干预率、成本、时延与安全事件。仅 `eligible` 的受信 Agent/Profile 可按需激活；否则 `rejected/inconclusive` 并停用。 |

## 不应误做成 P0 的能力

- **不默认调度多个 Agent**：可并行、可配置不等于应默认开启；先以单 Agent 为基线，远程只在任务可分解且评测证明净收益时激活。
- **不把 A2A 规范当作信任/授权标准**：协议解决互操作，不能证明对方组织、运行环境、数据处理方式或业务质量。
- **不因为“只读”就跳过隔离与监测**：只读对远端是不可强制的声明；未受信远端仍可能泄露数据或把不可信内容带回上下文。
- **不做共享长上下文或全量原始 Artifact 同步**：这会扩大提示注入、数据泄露和状态漂移面。使用最小 Context Capsule 与版本化 ArtifactGrant。
- **不先做跨组织 Agent 市场/自动发现即调用**：没有身份锚点、签名、健康/撤销、数据合同和准入评测时，扩大发现面只会扩大供应链风险。

## 推荐的最小生产试点

只选一个人工登记、同组织、只读的远程研究 Agent：完成身份绑定和可撤销 token；只授予一个脱敏 Artifact 的短期引用；跑通 A2A 异步 Task 的幂等提交、查询、取消和 `indeterminate` 分支；将结果与单 Agent 基线做三次对照。只有该试点证明收益且无安全/成本回归，才扩展第二个远端 Agent 或任何写入型协作。

一句话：**Craft 已能安全地“提出并记录只读远程协作”；补齐上述六项 P0 后，才能安全地“按需运行并相信有限范围内的远程协作”。**
