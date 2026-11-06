# 0.12.100 CLI 通知兼容修复

`.99` 真实 CLI 诊断发现：本机 0.163.0 将技能目录超预算通知编码为 `item.completed` / `error`，并不识别 `tools.view_image` 配置。官方配置文档虽列出后者，仍须以安装版本的实际行为核验。

修复使用本机 `codex features list` 明确支持的 `features.view_image=false`；只允许完整匹配已观察到的技能目录省略通知，并要求事件为 `item.completed`、项目类型为 `error`。未知配置、其他错误、工具活动、未知事件、超时、输出超限和非终结响应仍失败。没有移除安全规则或放宽工具门禁。

13 项传输相关测试通过，传输整文件 130 行、108 个分支、10 个函数均 100% 覆盖。包含真实通知格式、附加错误文本、缺少/非文本消息、事件类型不匹配、未知配置错误和工具活动负例。发布包及真实重试结果核验后追加。

参考：[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。本机差异及真实失败来源见 [0.12.99 证据](learning-chain-0.12.99-evidence-2026-10-22.md)。

隔离候选回归：204 项相关测试通过、失败 0；类型检查、公共包和插件构建、发布版本与打包检查通过；独立 bundle 可在无 node_modules 时启动。

## 远端发布与真实核验

- 源码 main：`ded24ea71329206cb0c2c65750abd8b0732a4d78`；Marketplace main：`fbdf24981523125a1e8547e8f66efc4ed675530f`。均普通推送并读回；从固定远端归档重建，安装来源仍是远端 Marketplace。
- 已安装 `.100` 的 MCP/Hook/Worker 哈希分别与 Marketplace 一致。MCP SHA-256：`ab5b5549332f44491c17e4505d510847f48fbc70f6cafee4a6df1ef24bd0084c`。当前会话附带 MCP 仍不能据此宣称已刷新；真实核验通过新进程完成。
- 第一次 `.100` 有界核验在模型调用前失败，原诊断仅保留通用错误码，原因未确定；没有把它算作成功或断言为超时。补采每个 MCP 方法耗时后，下一次核验成功。
- 实际 `gpt-6-luna` 调用的业务输入估算为 811 token，CLI usage 为 input_tokens=11521、output_tokens=227。唯一的技能目录预算通知被精确识别；无未知配置通知、无工具事件。这个实际输入量仍高于业务材料估算，不能称 Host 总 token 已被 8192 限制。

真实产物已只读回查中央 SQLite 的精确 ID 和最新版本，未使用 Store.open 作只读诊断：

| 记录 | ID | 核验结果 |
|---|---|---|
| 来源任务 | `codex_task_c6ba7d405b5732c0f72ba2f5b8357636` | 现有留出任务；非本轮编造 |
| 模型 Trace | `trace_a05a41e44c86403b8f1bc7af568bd9de` | version=6、completed；4 个事件，含 model.request、model.completed、案例候选和终结事件 |
| 案例 | `knowledge_case_10036920df48aaf041230f3e` | version=1、real_session、held_out、model_labeled；保留来源任务/会话和 Evidence 引用 |
| 评测运行 | `knowledge_run_21b860546382144bd5cf2d1e` | version=1、insufficient；recall=0、evidence_coverage=0、candidate_leaks=0、provenance_eligible=false |

任务处理状态在 Trace 成功终结后保存 processed，并绑定同一 Trace ID。真实方法耗时：Claim list 45ms、审核包 16ms、Profile ensure 128ms、Evidence 保存 58ms、案例保存 27ms、评测运行 1921ms；这是一次样本，不是 P95/P99 或大库并发达标证据。

执行的是远端源码的实际留出函数、连接已安装远端 MCP，并持正常 Knowledge 锁；最多检查 8 个现有任务、最多一次模型调用。它证明调用到评测记录的真实链路；前面的三阶段 Worker 单轮结果另见 `.99` 证据。不能把显式单轮函数核验冒充长期后台调度。

## 仍未通过的门禁与下一项依据

本例标签由模型选择，独立审定尚未完成，不能用于自动晋升。评测还显示未召回预期 Claim，需检查检索、作用域和标签适配，不能先修改答案令指标变绿。尚无效果收益或正式晋升证据。

只读源码核对还发现：`knowledge-classification.ts` 将待分类 Claim 按 ID 排序后固定取前 8 条，未做轮转。`.99` 真实分类前 8 条大多为 already_resolved、unchanged_failed_input 或正文不可用，因此后续待审 Claim 存在饥饿风险。留出队列已有轮转修复，但分类队列尚需对应修复及“前一批不可处理、后续合格项仍能调用”的回归与真实验证。

范围存储、Memory/Experience 的真实三级生命周期、Context 带材料成本与并发、Codebase 五语言统一评测仍按完整目标验收，不因这个案例生成而算完成。未解决的问题继续保留。

本轮日志及只读回查：`/private/tmp/craft-cli-release-aijiy_47/real-held-out-timed.jsonl`、`real-persisted-records.json`、`installed-hashes.json`。这些是本地运行证据，不是打包进产品的数据。
