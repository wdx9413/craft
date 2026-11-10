# Provenance 与对象级 Lineage

## 目标

Craft 的血缘图回答“这个成果从哪里来、经过什么转换、由谁生成、证据是什么、哪些结果受它影响”。它适用于文档段落、表格单元格、视频分镜、销售线索、课程对象、代码产物等领域对象，不把某一种研发对象当作默认模型。

## 当前实现

`LineageKernel` 记录不可变的派生声明：

```text
精确版本 Sources
  ── Actor + 可选 Transform 精确版本 + Evidence ──>
精确版本 Output
```

- Source、Output 和 Transform 只保存类型、ID、版本及可选 Locator，不复制业务正文。
- 支持 Work Object、Artifact、Evidence、Memory、Trial/Outcome、Workflow、Capability、Speculative Candidate 与 External Effect。
- Work Object 必须属于同一 Workspace；带 Task 的记录不能跨 Task 混接。
- 同一精确 Output 只允许一个派生声明；相同声明幂等返回，不同声明拒绝覆盖。
- 新边加入前检查有向环，避免成果成为自己的间接来源。
- `trace` 可按最大深度查询上游来源或下游消费者，并明确返回是否截断。
- `verify` 检查输入、输出、转换器和 Evidence 是否仍可解析；精确历史版本仍保留，但存在新版本时报告 stale issue。

## 承诺边界

Lineage 证明 Craft 记录了哪些引用和证据，不自动证明外部数据真实，也不把模型生成声明升级为程序证明。Locator 只是对象内定位符，其语义由领域 Kit 解释；未来 Canvas 可以据此呈现段落、单元格或镜头级来源。

当前需要 Host/Workflow 显式记录血缘，尚未自动拦截所有编辑器和第三方系统的数据流。跨设备同步与组织级访问控制也仍需独立实现。

关联：[Agent-Native Workspace](agent-native-workspace.md) · [Experience / Eval](experience-eval.md) · [控制面护栏](control-plane-guardrails.md)
