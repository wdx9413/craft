# Project Brain 与 Work Session（v0.12.9）

v0.12.9 把 Craft 的核心对象收敛成连续的项目工作系统：Project Brain 保存目标、资料引用、决策、任务、成果和候选经验；Work Session 将一次任务使用的知识、能力、Workflow、模型、Host 与验收合同固定成一个可复核上下文计划。

```text
项目
├─ 目标/约束
├─ 资料（URI + digest）
├─ 决策（选择/排除/理由）
├─ Work Session（知识/能力/Workflow/模型/Host）
├─ Trace / Work Launch
├─ 验收、Evidence、成果
└─ 候选 Experience（仍需评测与人工发布）
```

Project Brain 是用户视图投影，不复制 Markdown、Prompt 或业务正文；资料和知识只保存精确引用与摘要。Work Session 启动前不启动 Host，启动后绑定精确 Work Launch，恢复前重新检查任务和项目版本。任何漂移都进入 `needs_replan`。

MCP：`craft_project_brain_*`、`craft_work_session_*`。GUI/CLI/插件/Expert 都应调用同一组接口，而不是各自维护项目状态。
