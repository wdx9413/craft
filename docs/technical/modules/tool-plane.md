# Tool Plane：通用动词 + 资源注册表

> 状态：v0.12.4 实现 `syscall` 接入面与注册表，并将其作为默认低 token 工作面。它改变的是**工具如何被寻址**，不改变任何操作的语义、effect 或审批；本版新增平台能力仍通过同一资源/操作寻址。

## 问题

Craft 原先按操作逐个暴露 MCP 工具。宿主在会话开始时会收到**全部**工具 schema，无论本次是否会用到。实测：494 个工具 = 201,018 字符 ≈ 57.4k tokens，每轮都在付。

业界测量给出了同一结论：工具定义有约 6.6 倍的刚性冗余，比例从 12 个工具到 72 个工具几乎不变；单工具成本稳定在 ~468 tokens。**缩减描述字数收效很小，真正的杠杆是工具数量。**

## 结构

```text
syscall 面（固定 8 个动词）
  craft_describe  list/get/create/update/run/cancel/search
        ↓  resource + operation
Resource Registry（494 行，由既有工具表派生）
        ↓  每行指向原有的 craft_* 工具名
原有 handler（未改动）
```

- **动词固定，能力是数据。** 新增能力是注册表加一行，不是加一个工具。
- **地址唯一。** `(resource, operation)` 必须唯一，重复在构造时直接抛错；测试断言并集恰等于全部工具且不重复。
- **不复制实现。** syscall 面对每个操作都转调既有 handler，所以它不可能与具名工具产生行为分叉。
- **失败关闭。** 未知 `resource` / `operation` 返回错误并附带可用资源目录，不会静默放宽到全量。

## 渐进披露

`craft_describe` 无参数时返回资源目录（含资源数、操作数、每个资源的 effect）；带 `resource`（可选 `operation`）时返回该操作的精确入参、effect、风险、是否需要审批、超时、审计策略与角色。模型只在需要某个操作时才付出它的 schema 成本。

## 挂载面

| 面 | 内容 | 用途 |
| --- | --- | --- |
| `syscall` | 8 个动词 + 7 个路由 Skill 直接引用的具名工具（`craft_default_route*`、`craft_task_checkpoint`、`craft_evidence_record`、`craft_info`） | 默认工作面 |
| `core` | 原有 69 个具名工具 | 既有集成 |
| `governance` … `workflow` | 按域划分的 7 个可独立挂载面，并集恰等于非 core 工具 | 需要整域时 |
| `full` | 全部工具 | 管理场景 |

`syscall` 是**刻意**不参与域划分的：它按名字重新暴露一小部分工具，因此域并集断言把它排除在外。

## 边界

- 不改变任何操作的 effect、审批或证据语义。
- 不自动为宿主选择面（由部署方或适配器决定）。
- 面只约束**上下文开销**，不是授权边界；授权仍由 Activation Profile 与 effect 策略决定。
- 与 MCP 2026-07-28 修订版无关：该版本不处理 token 税，所以只能由服务端设计面。

## 相关

- 通用动词与类型分发（Harness MCP）：130+ 工具 → 11 工具，上下文占比 26% → 1.6%。
- 代码执行模式（Anthropic）：同一工作流 150k → 2k tokens。这是后续可选的下一步，用于把注册表暴露成可编程遍历的模块。
