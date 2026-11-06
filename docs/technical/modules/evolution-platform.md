# 可验证执行与演进平台

> 状态：v0.11.55 已实现机制验收。它连接现有 Fabric、工作区事务、交付评测与候选路由；v0.11.56 的长任务接力和显式 Campaign Runner 见 [Managed Run 与 Evaluation Lab](managed-run-evaluation-lab.md)。两者都不声称已经证明任一业务领域的质量提升。

## 目标

本模块把四件原本分散但必须连续的事情收敛起来：

```text
Execution Fabric
  -> scoped Managed Write / Host Receipt / State re-observation
  -> observed Delivery
  -> Eval Campaign Report
  -> Signoff + evidence-backed Canary
  -> Adaptive Harness Recommendation
```

模型或 Host 的“完成”只是一条输入事实。只有文件状态、独立 Acceptance 和 Delivery 均被观察后，结果才进入 Campaign；只有 held-out 对照、Signoff 和非回归 Canary 证据齐全，候选才可被推荐。

## 受控本地写入

`ManagedWriteKernel` 只覆盖一个 `workspace-write` Execution Fabric 的已声明 Workspace 路径：启动前创建基线 Checkpoint 和 `workspace_transaction`；Host 成功终态后创建提交 Checkpoint；失败、取消或中断转为 `rollback_pending`；恢复必须由人带 `approved=true` 显式触发。记录只保存 Fabric、Run、路径范围、摘要和 Checkpoint 引用。

它**不**覆盖外部 API、数据库、网络写入或未声明路径，也不把 Host 自带沙箱宣称为跨平台安全隔离。外部 effect 仍需专用 Adapter、可观察结果和补偿/人工处置。

## Campaign 与报告

`EvalCampaign` 计划 `held_out Case × baseline/candidate Harness × N Trial`，不会暗中启动模型或 Host。Slot 只能绑定已有的 Task Run；`EvalCampaignReport` 从已观察的 Work Delivery 形成无正文的 pair 表和交付率/改进率/回归率。报告明确 `business_quality_claim=false`：它证明机制和对照数据完整性，不替代叙事、美学或业务结果的独立验收。

同环境、同预算、重复、held-out 的 Benchmark 仍是 Candidate 的唯一晋级入口；任一缺失都应为 `collecting` 或 `inconclusive`，而非被补成通过。

## 候选路由

Candidate 必须先完成：held-out eligible Evaluation → passed Signoff → Canary。Canary Sample 若想用于路由结论，必须引用已登记 Evidence；发现回归立即得到精确 baseline 回滚引用。足量、带证据且未回归的 Sample 经 reviewer 明确结论后，Candidate 才进入 `routing_eligible`。

`AdaptiveHarnessKernel` 只根据任务词项与候选的显式适用词选择这样的 Candidate；没有匹配或没有合格候选时，返回调用方声明的最小 baseline Harness。Recommendation 不启动 Host、不扩大权限、不自动修改 Skill/Workflow。

## 验收边界

- 内置脱敏研发与文件/媒体 Case 只验证状态、写入恢复和评测机制。
- 业务质量、收益、人工返工时间和模型成本需要后续导入脱敏真实 Case 再证明。
- 不默认多 Agent、不执行模型生成脚本、不自动发布候选，也不把行业标签作为事实源。
