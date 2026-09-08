# Craft 架构

[简体中文](architecture.zh-CN.md) | [English](architecture.en.md)

## 产品边界

Craft 是通用 Agent Harness，不属于某个模型或 Agent 产品。Codex、Claude Code、DeepSeek Harness、桌面端或自建程序都可以成为 Craft 的 Host 或 Client。

Craft Core 管理六类稳定对象：

- Capability：可检索的能力资产。当前扫描 `SKILL.md`，未来扩展插件与 MCP 元数据。
- Task / Checkpoint：跨会话任务状态和可信接续点。
- Artifact / Evidence：产物引用、明确主张、来源与置信度。
- Workflow / Run：版本化步骤、输入、权限和执行回执。
- Evaluation Suite：可复用评测用例定义。
- Agent Profile / Orchestration Plan：模型角色、宿主路由与依赖图。

## 运行结构

```text
Codex / Claude / DSH / CLI / future desktop
                     │
              Plugin or MCP
                     │
       Craft TypeScript application service
          ┌──────────┼──────────┐
       Catalog    Workflow   Orchestration
          └──────────┼──────────┘
              SQLite + ~/.craft_data
```

运行时统一使用 TypeScript 和 Node.js 23+。SQLite 使用 Node 内置驱动；在不带 FTS5 的运行时自动降级为关键词检索。

## 能力发现

Source 同时保存用户输入路径和解析后的真实路径。扫描器跟随目录链接并用真实路径避免循环；同一真实来源不会重复注册。增量扫描先比较大小和修改时间，变化时才读取正文并计算摘要。

本地关键词召回使用 SQLite FTS，查询时不再反序列化全部 Skill 正文。检索先返回最多 20 个候选卡片且不携带正文，Client 选择后才用 `craft_capability_get` 读取完整内容。这里节省的是模型上下文和重复查询成本；首次扫描仍需读取来源文件。未来 Hub 使用清单增量同步，向量检索作为可选召回器，与关键词结果融合。

## Workflow 与验证

节点声明 `read_only`、`local_write`、`external_write` 或 `destructive`。本次调用没有明确批准的副作用不会执行。路径必须位于指定项目根目录内，命令输出默认脱敏并截断。

确定性验证包括命令退出码、文件存在、JSON 字段和值、覆盖率报告阈值。它们由程序计算；模型不能用一句“已经 100%”覆盖程序结果。主观判断与人工审批后续通过 Judge/Human Adapter 扩展，并保留来源。

## 多 Agent 编排

Plan 是带依赖的有向无环图。Node 指定角色、目标、候选 Agent Profile 和副作用级别。`dispatch` 只领取依赖已通过且并发容量允许的节点；失败时可以切换到下一个 Profile，最终失败会阻塞下游。`submit` 必须引用有效 Lease 并声明 provenance。

v0.6.0 起，Plan 创建时会锁定每个候选 Agent Profile 的精确版本。需要进入评测历史的编排使用 Orchestration Trial：Dispatch、失败换路、Submit、Artifact、Evidence 和成本自动写入 Trace；Plan 到达终态时自动生成回执与 Outcome。普通 Plan 仍可用于不需要评测留痕的临时协调。

Craft 不绕过 Host 的 Sandbox、审批或并发限制，也不直接假定 Codex/Claude 的内部任务 API。插件负责把 Lease 翻译成宿主原生执行，再把真实结果交回 Craft。

## 从执行经验中改进 Harness

Craft 后续不会把“学习”简化成不断增长的对话摘要，而会把一次执行明确记录为 `Task → Trial → Trace → Outcome`。Harness 配置按六个可诊断面组织：上下文装配、工具与检索、生成预算、编排方式、记忆策略、输出验证。每次变更都应保存配置版本、差异、成本、证据和失败归因。

经验分为两层：具体 Case 的完整执行记录，以及由多个 Case 归纳出的可复用模式。候选 Workflow 或 Harness 配置必须通过独立评测集后才能晋级，并保留版本、适用条件和回滚路径。排序优先保证正确性，再比较 token、耗时和费用；模型判断可以参与诊断，但不能替代确定性证据或人工审批。

v0.6.0 已进一步实现 Orchestration Trial 自动归档和 Agent Profile 路由版本锁定。重复采样与统计置信度、Lease TTL/Heartbeat、自动 Host Driver、自动执行模型/业务 Grader、自动 Harness 搜索、双层经验库和按 Case 自适应装配仍是路线设计。

## 存储与跨平台

默认根目录是 `~/.craft_data`，可用 `CRAFT_DATA_DIR` 覆盖。配置写入 `config/`，版本化状态写入 `db/craft.db`，其余目录用于可重建索引、日志、备份、缓存和运行时文件。业务项目仅作为读取或明确授权的 Workflow 工作目录，不存放 Craft 内部数据。

所有业务实体按 `(kind, id, version)` 保存；事件流按 Stream 单调递增。写入使用 SQLite 事务和 WAL，配置使用同目录原子替换。

## 当前边界

当前版本已提供 Provider 模式的完整 MCP 路径、能力目录、任务/证据、确定性 Workflow、Experience/Eval Kernel 第一层和基础多 Agent 路由。Codex 与 Claude 插件使用不依赖 `node_modules` 的单文件 MCP bundle。独立 Agent 的模型循环、Agent IR Compiler、Capability Kit Registry、向量 Provider、远程 Hub、桌面端、自动 Grader、自适应 Harness 搜索、Lease TTL/Heartbeat、预算和补偿事务是后续增量，不应在文档中被描述成已完成。
