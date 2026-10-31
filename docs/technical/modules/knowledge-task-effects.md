# Knowledge 独立任务效果核验

Craft 负责证据准入和知识晋级，craft-eval 负责执行与统计。检索命中、来源语义复核、任务效果和最终晋级是四个不同步骤。普通评测比较仍只返回诊断结果。

## 使用流程

1. 准备一个当前候选 Claim、有效 Source、可信来源 Evidence 和独立支持。记录精确 Claim 版本及内容摘要。
2. 保存 21～200 个留出案例，每个来自不同的原生会话。至少 20 个正例及 1 个负例。案例 scope 必须与 Claim 相同；负例的 `expected_claim_ids=[]`，仍必须绑定精确 `candidate_claim_refs`。
3. 每个案例提供 `task_contract`，由受管审定器同时核对任务、独立结果证据、Claim 标签、检查标准和安全检查。没有受管审定记录的自报检查不合格。检查过松或证据不足时应拒绝。
4. 执行 `craft_knowledge_evaluation_run(mode="candidate_shadow")`，记录返回的检索运行 ID；它必须已通过来源独立性、精度及召回门槛。
5. 调用高级 Knowledge 工具 `craft_knowledge_task_effect_context(retrieval_run_id)`，取得精确的候选 `Subject.context` 和案例顺序。基准 Subject 省略 context；候选 Subject 原样使用返回值。
6. 通过工作台评测入口执行两次独立运行。同一 Suite、Runtime、代码和原生引擎；Subject 仅允许 id/version/context 不同。Suite 的 case id、prompt、checks、safety_checks 必须逐项对应审定案例。
7. 调用 `craft_knowledge_task_effect_assess(retrieval_run_id, baseline_id, candidate_id)`。它重新校验受控输入、执行计划、报告、回执、依赖及统计，记录 `eligible` 或 `insufficient`。
8. 效果合格后，再执行原有 `craft_knowledge_auto_review`。来源、独立支持、策略和 Claim 版本仍须有效；效果核验本身不直接改为 reviewed。

这两个工具只加入高级 `component-knowledge` 入口，不扩张日常工具列表。工作台 HTTP 使用同样逻辑，并沿用本地 token/同源限制：

- `GET /api/workbench/evaluations/knowledge-context?retrieval_run_id=...`
- `POST /api/workbench/evaluations/knowledge-assess`，JSON 为 `retrieval_run_id`、`baseline_id`、`candidate_id`。

## 任务合同与预算

`task_contract` 示例：

```json
{
  "checks": [
    {"id": "answer", "kind": "json_equals", "path": "outputs/answer.json", "key": "valid", "equals": true}
  ],
  "safety_checks": [
    {"id": "safe-exit", "kind": "exit_code", "equals": 0}
  ]
}
```

示例只说明字段，不是任何真实业务的充分判据。审定器必须根据任务的独立结果证据判断检查是否适用。每组 1～32 项，仅接受有界的退出码、文件存在、JSON 值和输出包含/不包含检查；任务不能仅检查退出码，不接受任意脚本或模型自评作为此合同的准入检查。

Suite 必须声明二元任务通过率及必需的时延护栏，例如：

```json
{
  "primary": {"id": "task-pass", "kind": "binary_pass_rate", "direction": "higher_is_better"},
  "guardrails": [{"id": "duration", "metric": "duration_ms", "comparator": "lte", "threshold": 30000, "required": true}]
}
```

当前策略每个独立任务只接受一次试验，最长 120 秒；必须观察到 1～32768 输入 token、1～8192 输出 token。它们是本地核验上限，不是账户余额或实际美元预算。额外声明的护栏必须全部通过，未观测也不能通过。

正向任务收益需要完整、不同的任务运行，单侧检验 p≤0.05，配对通过率差的 95% 区间下界大于 0；负例不得失败，任务安全检查必须全部通过。只对一个精确 Claim 作归因，多 Claim 的总体增益不能直接算到其中某一条。

## 证据边界

- 执行文件在运行前后按字节摘要核对，环境只记录摘要。禁用自定义引擎 wrapper 参数与 Subject/Host 环境覆盖来取得正式效果资格；普通诊断评测仍可使用这些配置。
- 请求模型与实际模型分开核对。必须有一致的实际模型标识及完成轨迹；当前 Codex JSONL 如果不提供实际模型标识，就不能取得此资格，不能用请求别名替代。
- 两侧实际执行副本的文件摘要及输入回执必须相同或只包含指定的知识干预。上下文回执证明提交字节，不单独证明知识有效。
- 报告、冻结配置、执行计划、Source、案例、审定和 Evidence 均绑定到本次核验。依赖版本或内容变化会使旧效果回执失效。
- 记录是可信本地服务签发的审核回执，不是远程签名或对抗本机数据目录所有者的防篡改机制。结论受指定代码、模型、环境、任务和判据约束，不外推到其他版本、平台或在线流量。
- 同一检索运行只保存一个不可变核验；同一绑定重试复用，绑定变化须新建检索运行，不覆盖旧证据。

策略单元测试使用明确标注的模拟执行记录；读取失效测试可模拟可信签发器的回执。这些夹具不是原生模型效果数据。真实知识效果验收仍必须按以上步骤采集独立任务。
