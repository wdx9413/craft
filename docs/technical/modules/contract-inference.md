# Contract Inference：动态契约推导

Contract Inference 用于把尚无正式 Skill、MCP Schema 或稳定 API 文档的工具，逐步转成可验证的动作契约。它不是让模型看一次请求后自动获得工具权限。

## 生命周期

```text
脱敏 Schema 观测（至少两次）
  → 一致性检查
  → non-executable Candidate
  → 人工接受/修订/拒绝
  → verified Sandbox Profile + passed Evidence-backed Trial
  → verified Contract（仍不自动激活）
```

观测支持 API、MCP 和 Computer Use，记录 endpoint、operation、输入/输出 JSON Schema、实际副作用、幂等与补偿观测、所需凭据句柄、Outcome 和 Evidence。只保存 Schema 和摘要，`raw_payload_stored=false`。

推导要求至少两个成功且结构一致的观测。幂等或补偿能力不一致时标记为 `unknown`，不乐观猜测。人工可以修订候选，但不能跳过 Sandbox 与 Trial 验证；验证完成后 `execution_authority` 仍为 `false`。

精确版本之间可以执行 Contract Diff，结果分为 equivalent、compatible 或 breaking；Schema、Effect、凭据要求变化，以及丢失已经证明的幂等/补偿能力均视为 breaking。发布还要求与 Reviewer 不同的独立 Publisher 和审批引用，生成 `verified/healthy` Capability Adapter。发布记录拥有精确 Asset Version；回滚只能撤回它仍然拥有的当前版本，不能覆盖后来发布者的更新。

## 当前边界

当前实现是确定性的元数据与晋级内核，不自动抓包，不让模型自行推断任意 JSON Schema，也不生成 Saga 补偿代码。真实探测由受控 Host 完成，敏感原文不得写入观测。已发布 Capability 在实际调用时仍必须经过 Activation Profile、Sandbox、Autonomy 和 Host Adapter；发布本身不等于某个 Host 已安装驱动。Canary 的真实流量采集与自动健康回退尚待接入。
