---
name: craft-eval
description: 使用独立 Craft Eval 定义冻结评测合同，核验签名报告与精确任务效果记录。
---

# Craft Eval

先从当前 MCP 工具列表读取合同工具的参数。调用 `craft_evaluation_contract_define` 固定能力版本、输入输出、环境、预算和验收，再用 `craft_evaluation_contract_get` 读取已冻结版本。

独立执行器产生报告后，用 `craft_evaluation_contract_record` 验证签名及版本绑定。用 `craft_evaluation_contract_task_effect_record` 登记基线与候选的独立配对任务证据。报告缺失、签名错误、条件不符或收益不足时保留失败结果，不得代填通过。

合成样本必须标注为 fixture；它只能证明机制，不能证明真实任务收益。Eval 不替代 Experience 的发布门禁。工具不可用时报告不可用，不在其他所有者下复制合同或报告。
