# Knowledge 队列和中文检索修复证据

## 问题与可复现证据

`.100` 真实留出案例 `knowledge_case_10036920df48aaf041230f3e` 的运行 `knowledge_run_21b860546382144bd5cf2d1e` 召回率为 0。只读核对预期 Claim：已审核、未过期、项目范围一致，来源 active / verified。没有改动案例查询、预期标签或来源。

同一脱敏内容经旧规则生成 11 个整段词项，命中数为 0；已有 BM25 中文分词能命中同一 Claim。中文回归在旧实现返回 recall=0，在修复后返回 recall=1。该案例的标签仍为 model_candidate，需要独立审定，不能把词法命中作为事实或效果收益。

分类队列的两个回归同样先失败：前 8 条正文不可用时下一轮仍取 claim-01，claim-09 永远排不到；单轮预算放行一项后下一轮仍从 claim-01 开始，没有轮转到预算拒绝的 claim-02。

## 改动与边界

- `knowledge-classification-state.ts` 在既有状态文件中保留 last_claim_id，继续兼容旧格式；失败输入缓存和游标相互保留，身份、符号链接和坏状态仍校验。
- `knowledge-classification.ts` 从上次实际处理的位置之后轮转；排序中的记录被移除时按稳定 ID 继续；model_call_budget_exhausted 不计为已处理项；游标保存失败使本轮明确失败。正常 Worker 仍持能力级拥有者锁，游标写入为原子替换；读状态不加互斥锁。
- `wikiContextCompile` 复用已有 BM25 中文分词，与 KeywordRetrievalPort 使用同一个索引实现；保留未审核、过期、范围和预算过滤。每条候选正文只读一次供评分和渲染使用。没有改评测标签、来源资格或晋升门禁。

## 验证

主工作区分类及状态相关 38 项测试通过，两文件整体 481 行、340 分支、18 函数覆盖率 100%；中文检索、来源资格和 Wiki 相关 5 项测试通过。

从已发布 main `f37466d109f775465646e01ea8e27b874124f3f0` 的 Git archive 建立隔离候选。`craft-service.ts` 仅纳入 wikiContextCompile 这一处改动，其他未发布工作继续保留。持久项目夹具显式绑定测试项目目录，复用现有范围注册合同。

隔离候选 110 项相关测试通过；相对基线的增量 53 行、44 分支、4 函数全部覆盖。类型检查、七个公共和能力包构建、插件构建与打包、版本和目录检查、无 node_modules 的独立启动检查均通过。

真实发布和运行结果核验后追加。完整五能力目标仍未完成：真实独立标签、项目/跨项目晋升退出、作用域数据隔离、Memory 三级记忆、Experience 收益与回退、Context 成本及性能、Codebase 五语言固定仓库评测继续保留验收。

## 远端发布和真实验证

源码 main `8ccc7962425b6b56248ce2d29ac9b5138ba3f02a`（代码提交 `3668f6cb57e29dc2d8cd09255f7a6716edd9a671`，随后仅修正证据文件日期）；Marketplace main `6450af488dc1f52e9ee2796eb60dd0b06eea3958`。均已普通推送和远端读回。从该固定远端源码归档重建并经远端 Marketplace 安装 `.101`；安装的 MCP/Hook/Worker 与 Marketplace 哈希一致。MCP SHA-256：`ac950e9d58cf42a32d146b9031d4ebad9981af1304cc9c03204ccb034dcbb6a0`。

原样重跑已有案例：版本仍为 1，identity_digest 仍为 `sha256:72cbda9dec1a91265f3b322399114a0df05081c26248d53cf769ffef0c0aaaf1`；未修改查询、预期 Claim 或来源。新运行 `knowledge_run_lexical_replay_1792680552930`：recall=1、evidence_coverage=1、candidate_leaks=0，命中原预期 Claim。与旧运行 recall=0 对比可证明这一条案例的中文词法检索已修复；不能据一个模型候选标签案例宣称总体效果或独立准确率达标。provenance_eligible 仍 false，status 仍 insufficient，没有晋升。该次重跑不调用模型。

随后正常持 Knowledge 拥有者锁，运行远端固定版本的实际分类函数，最多三批检查、共享最多一次模型调用。实际首批对现有候选 `knowledge_claim_from_knowledge_fragment_0a5861905c2db1d7164e75c4` 完成 `gpt-6-luna` 证据审核：

- 业务输入估算 3871 token，CLI 实际 input_tokens=13950、output_tokens=129。业务估算不代表 Host 总输入成本。
- 返回 needs_evidence，Claim 保留 candidate，promoted=false。没有为生成正式产物而放松证据门禁。
- Trace `trace_92f4a13fc1c946259df8cd926306f635`：version=11、completed、9 个事件。通过精确 Trace 审计流取得真实事件 ID 后逐条只读回查，9 条事件均存在且序号连续；组件事件可使用自定义 ID，不能仅按 trace_id:sequence 推测所有事件 ID。
- 票据 `evaluation_model_ticket_b6fd433fd3f41f6258ea` completed，保留同一 Trace 和结果 digest。

再次启动新进程，用零模型预算核验持久队列：首项为上轮预算拒绝的 `knowledge_claim_from_knowledge_fragment_40eca7774f353a4f4216494f`，返回 model_call_budget_exhausted，未启动模型。持久 last_claim_id 保留在上轮已处理的 0a586... Claim，不把未执行项当作已执行。

真实首批因现有数据变化已包含一条可审核新候选，因此本轮真实记录没有复现“前 8 条全部不可处理”的完整旧队形；该特定饥饿情形由先红后绿的 9 条任务回归证明。真实新进程记录证明了持久游标恢复与预算未执行项的保留。显式单轮函数验证仍不能冒充长期后台收益证明。

运行日志及精确只读回查保存在 `/private/tmp/craft-knowledge-release-alpcav5c/`：`real-knowledge-pass.jsonl`、`real-queue-budget-check.jsonl`、`persisted-proof.json`、`installed-hashes.json`。
