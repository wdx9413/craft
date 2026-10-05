# 多入口 Procedure 与子流程

用户要求复用完整研发流程、只做 Code Review、选择交付边界或组合子流程时，先读取本契约。以用户任务选择命名 Entry 和目标 Exit；入口不代表之前的工作已完成，出口不代表验收已通过。

## 使用顺序

1. 在当前 scope 解析 Experience Context，再用 `craft_procedure_get` 读取候选引用的 `entrypoints`、`exits`、当前版本与 definition digest。没有足够材料时说明缺少哪些输入或前置 Evidence。多个入口都适用时让用户选择工作范围，禁止从任意内部 Step 跳入。
2. 对已 routeable 的组合 Workflow 调用 `craft_procedure_plan`。输入是 Artifact 引用，前置条件是已记录的 Evidence ID。输出给出选中步骤、子调用边界、输入输出映射和每层验收契约。计划是只读投影，`execution_authorized: false`、`acceptance_status: not_evaluated`。
3. 由当前 Host 将计划绑定到 Task/Policy，在每个步骤实际执行前验证当前引用与权限。子调用完成且其出口验收通过后，再把声明的输出映射回父流程；失败时沿既有失败处置停止或 Handoff。子流程/根流程版本变化或撤销时重新规划。
4. 用真实产物和独立验收分别检查每个子出口与最终出口。`review_complete` 可以交付 findings；它不代表修改已完成或允许发布。执行与 Acceptance 由既有 Host/Runtime 负责，这个工具不执行命令、不产生 Outcome、不安装调度器。

## 提交契约

在正常的 Observation → draft 路径后，`craft_experience_procedure_submit` 的线性 `steps` 可携带 `composition`。顶层 `inputs` 保留旧兼容契约；组合流程的材料要求以各 Entry 的 `required_inputs` 为准。

```json
{
  "inputs": [],
  "steps": [
    {"id":"implement","type":"instruction","instruction":"实现需求并准备变更材料","side_effect":"local_write","requires":["requirement"],"provides":["diff"]},
    {"id":"review","type":"instruction","instruction":"审查变更并输出含问题清单的报告","side_effect":"read_only","requires":["diff"],"provides":["report"]},
    {"id":"deliver","type":"instruction","instruction":"整理测试和审查交付证据","side_effect":"read_only","requires":["report"],"provides":["delivery"]}
  ],
  "composition": {
    "entries": [
      {"id":"develop","title":"完整需求开发","required_inputs":["requirement"],"preconditions":["requirement-approved"],"routes":[
        {"exit_id":"review_complete","step_ids":["implement","review"]},
        {"exit_id":"delivery_ready","step_ids":["implement","review","deliver"]}
      ]},
      {"id":"review","title":"Code Review","required_inputs":["diff"],"preconditions":[],"routes":[
        {"exit_id":"review_complete","step_ids":["review"]}
      ]}
    ],
    "exits": [
      {"id":"review_complete","title":"审查完成","required_outputs":["report"],"acceptance_ref":"acceptance:review-report"},
      {"id":"delivery_ready","title":"交付材料就绪","required_outputs":["delivery"],"acceptance_ref":"acceptance:delivery"}
    ]
  }
}
```

提交时同时提供 draft 返回的 `request_id`，以及 `workflow_id`、`name`、`description`。该组合只创建 Candidate，响应 `workflow: null`；它不会生成一个可以绕过 Entry 的旧 Workflow 记录。旧的非组合 Workflow/Graph 路径保持兼容。

每个 Step 必须有独立 `id`、`type`、`side_effect`、`requires`、`provides`。标识及引用不接受首尾空格，Step ID 不含 `/`，避免调用类型伪装和展开路径冲突。所有 Route 必须先取得所需材料再消费，禁止覆盖已有材料、重复 Step、不可达 Step/Exit。选定路径默认顺序执行；独立只读步骤可显式声明有界 parallel_groups，恢复合同见 [执行指引](invocation.md)。执行中条件分支、回环或跨副作用补偿仍使用 Graph 定义和证据要求。Graph 不会被静默展开为线性步骤。

## 子流程调用

把父流程的 review Step 改为 `type: procedure_call`，保留 `requires`、`provides`、`side_effect`，增加：

- `procedure_id`、`procedure_version`：从已 routeable 子 Procedure 最新记录取得的精确 ID 和记录版本。
- `definition_digest`：同一记录的 checked JSON 摘要，必须与内容一致。
- `entry_id`、`exit_id`：子流程的合法入口和目标出口。
- `input_bindings`：子入口输入名 → 父流程材料名，例如 `{"diff":"diff"}`。
- `output_bindings`：父流程新增材料名 → 子出口公开输出名，例如 `{"report":"report"}`。

子流程也必须有 composition。调用的 `requires` 必须等于输入映射使用的父材料集合，`provides` 必须等于输出映射的父材料集合。仅允许读取子出口公开输出。跨 scope、未晋级/已撤销、版本漂移、摘要不符、递归、超过 8 层或展开超过 100 Step 都会拒绝。

子步骤 effect 必须同时属于调用者允许集合、所有祖先 Procedure 允许集合，以及当前 Call 的 `read_only + side_effect` 范围。需要写入的子流程不能隐藏在只读 Call 中。Audience/Tenant 延用 Scope Envelope；调用参数是 Host 提供的访问元数据，不是新的身份系统。

## 前置证据、晋级和计划

前置条件 Evidence 要求 confidence 为 `bounded` 或 `confirmed`，metadata 含匹配的 `scope` 与 `condition_ref`。绑定只校验证据引用，不独立证明世界状态；Host 仍须核实证据时效及与当前任务的关联。

每个晋级 stage 的通过 Evidence 必须覆盖**全部已声明 Entry → Exit**。每条 Evidence metadata：

```json
{"procedure_definition_digest":"实际定义摘要","entry_id":"review","exit_id":"review_complete","stage":"shadow","status":"passed"}
```

`shadow → held_out → signoff → canary` 各自收集真实独立证据；错误或不完整覆盖不能晋级。失败 Gate 会停止路由并清空本轮晋级记录；重新放行必须按顺序完成四阶段。重做较早阶段会使下游通过记录失效。示例不是可用于晋级的真实 Evidence。

Gate 支持 `expected_version` 防止基于过期状态提交。相同 `gate_id`/请求的重试只返回当前状态，不增加版本、不重新应用历史成功结论；新一轮评测使用新的 Evidence 和 Gate ID。记录 Gate 与 Procedure 状态变更在同一个数据库事务中完成。

`craft_procedure_plan` 调用示意（替换为真实引用）：

```json
{
  "procedure_id":"实际 Procedure ID",
  "procedure_version":5,
  "scope":"project:实际 canonical scope ID",
  "entry_id":"review",
  "exit_id":"review_complete",
  "input_refs":{"diff":"artifact:实际变更材料引用"},
  "allowed_effects":["read_only"],
  "precondition_evidence":{}
}
```

完整开发改用 `develop`，传 `requirement` 引用、`requirement-approved` 对应 Evidence ID，并按 Task 许可传 effect。根 Procedure 的公共前置条件与 Entry 的前置条件都必须满足。输入键严格匹配入口，计划不会保存原始业务正文。

计划保留子调用结构与各层 Acceptance；Host 不能只平铺叶子步骤后跳过子验收。已有 Automation API 拒绝组合 Procedure，要求显式选择 Entry/Exit 的 Host 计划；本功能不等于无人值守多入口 Runtime。
