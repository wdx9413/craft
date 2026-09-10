# Knowledge Evaluation：检索质量门禁

v0.11.32 使用用户维护的固定 `Query → Expected Claim IDs` 案例评估知识层。

- 每次运行固定 case、时间、top-k 与阈值，输出逐例选中、命中和遗漏。
- 聚合计算 Recall、期望 Claim 的 Evidence Coverage，以及未审核 Claim 泄漏数。
- `eligible` 仅表示本次结果达到声明阈值；`insufficient` 也会保留结果。

评测不调用模型裁判，不自动改变 Context Compiler、默认路由、Skill 发布或 Workflow 执行。它是知识演进的证据输入，而不是自动自我进化的开关。
