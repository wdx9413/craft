# 组件插件架构

## 一条 Runtime，多种分发方式

Craft 的事实模型、Policy、Evidence 和评测账本只有一份。**Runtime 是产品实现，MCP 是公开协议，Plugin 是宿主安装包，Skill 是调用策略。**四者不是四套产品；插件也不复制业务逻辑。

```text
Craft Runtime
  ├── MCP：任意 MCP Host 的稳定公开入口
  ├── CLI / SDK：同一 Runtime 的本地或程序入口
  └── Plugin：Skill + MCP 配置 + 已打包 bundle
```

任何发布形态都必须指向同一 `CRAFT_DATA_DIR`/`data_space_id` 才共享事实。Plugin 不能绕过 MCP/Runtime 的 Policy、Receipt 或评测门禁。

```text
craft（默认完整运行时）
├── Craft Core：Work Loop、Policy、State、Receipt、Acceptance
├── Craft Context：KnowledgeSource、MemoryLedger、Context Resolution Receipt
├── Craft Capability：Skill / MCP / Workflow / Adapter 的发现与最小激活计划
├── Craft Quality：Subject、Case、Trial、Grader、比较与晋级证据
├── Workflow Evolution：只产生受限 Candidate 草案
└── Host Bridge：连接当前宿主或显式执行器

正式 MCP 产品
├── full：完整 Craft 的紧凑 syscall 面
├── context：Knowledge + Memory 的组合入口
├── knowledge：独立知识治理
├── memory：独立记忆治理
├── capability：能力发现与最小激活
├── quality：通用质量评测
├── evolution：受限 Candidate 草案
└── admin：完整原始工具面，仅显式管理场景
```

完整 `craft` 是默认安装入口；它已包含所有上述能力，使用小型 syscall 面按需到达底层操作。`craft-context`、`craft-knowledge`、`craft-memory`、`craft-capability` 与 `craft-quality` 是正式的单域产品投影，不是降级实现。通常一个 Host 选择 `craft` 或一组不重叠单域产品，避免重复注入工具。

## MCP-first 入口

安装 Runtime 后，任何 Host 都可直接启动同一个可执行文件：

```text
craft-mcp --product full
craft-mcp --product context
craft-mcp --product knowledge
craft-mcp --product memory
craft-mcp --product capability
craft-mcp --product quality
craft-mcp --product evolution
craft-mcp --product admin
```

`--product` 是稳定的产品契约。底层 `--surface` 和 `CRAFT_MCP_SURFACE` 只为已有集成保留；显式产品与 surface 同时出现且不一致时启动失败，绝不静默扩宽工具面。命令行显式参数优先于继承环境变量，避免宿主遗留环境误改 Plugin 产品面。

## 三个独立产品

### Craft Context

`craft-context` 是知识与记忆的组合入口，而不是把两种概念混为一谈：

```text
外部或内置知识来源
  → KnowledgeSource（scope、digest、trust、只读/提议边界）
  → MemoryLedger（工作、情景、偏好、程序记忆）
  → Context Resolution（最小 scope 与预算）
  → Context Resolution Receipt
```

它向 Host 提供可复现的上下文，绝不提供执行权。推荐的独立使用顺序是：

1. 读取 `craft_info`，确认目标组件的 `data_space_id`；不同 ID 不应假定能共用 Ledger 或 Receipt。
2. 仅 bootstrap 或登记当前 scope 所需的 `KnowledgeSource`。
3. 解析最小 Context，并返回带版本、预算和排除原因的 Receipt。
4. 仅在明确批准后写入 durable Memory；修正通过 supersede 或 revoke 留下历史，而不是覆盖事实。

`craft-knowledge` 和 `craft-memory` 是一等的单域产品：前者适合知识库、Wiki 与 Evidence 治理，后者适合偏好、项目决策、会话收尾与可撤销工作记忆。`craft-context` 只是它们的组合入口，因此普通用户不必先判断“上下文究竟属于知识还是记忆”。

### Craft Capability

`craft-capability` 管理外部 Skill、MCP、Workflow、Adapter 等 Capability Asset 的发现、逻辑去重、健康与推荐。发现、激活、授权、调用仍是四件不同的事；该组件不能直接安装、启动或调用外部工具。

### Craft Quality

`craft-quality` 评测一个固定版本的 **Subject**，而不是只评 Skill。Subject 可以是 Skill、MCP/Host Adapter、Capability Kit、Workflow、Harness、检索策略、Turn Policy 或实际交付。

```text
冻结 Subject + Case + 环境 + 预算 + Grader
  → 重复 Trial / Outcome
  → baseline 与 candidate 比较
  → eligible | rejected | inconclusive
```

质量模块不发现能力、不创建 Candidate、不发布也不激活。不同 Subject 的检查实现可以不同：例如 MCP/Adapter 需要协议 conformance 和受控 fixture，检索器需要召回/泄漏/时延/成本，Workflow 需要真实 Outcome；但它们使用同一比较与准入语义。`craft-skill-quality` 是完全等价的兼容别名。

## Candidate 与 Workflow Evolution

Candidate 是主运行时的受限演进链，而不是可独立完成发布的插件：

```text
脱敏 Observation + Evidence
  → Candidate / Workflow draft（最多两个设计轴）
  → Craft Quality 的 shadow / held-out 评测
  → Signoff → Canary → 精确回滚
```

`craft-experience` 是正式的 Evolution 产品投影，但它只能走到 draft。需要完整闭环时，应使用 `full`，或由 Host 明确组合 `evolution`、`quality` 和完整 Craft 的 Signoff/Canary 能力。Capability 只能发现已经成为 `verified` 的精确 Workflow 版本。

## 数据空间与 Host

所有插件默认使用同一用户的 `~/.craft_data`；Host 若设置不同的 `CRAFT_DATA_DIR`，它们就是不同数据空间。每个 surface 都能通过 `craft_info.data_space_id` 比较该事实。不同数据空间之间不得默认为 Receipt、Memory、Evidence 或 Candidate 可互认。

`Execution Host` 是实际请求模型、调用工具或运行命令的主体：当前 Codex App、Claude 或 IDE 属于 `embedded`，不会由 Craft 默认再启动一个 CLI。Craft 在这些 Host 中提供控制、事实、质量与受限演进；它不反向接管宿主应用。

## 验收边界

- 每个 MCP 产品必须在空数据空间完成 `initialize`、`tools/list`，且 Context/Knowledge/Memory/Capability/Quality/Evolution 工具面不包含 Verified Work Loop。
- `craft-context` 必须能 bootstrap 来源、保存有 scope 的 bounded Memory，并产生 Context Resolution Receipt。
- `craft-quality` 与兼容名必须暴露完全一致的质量工具面。
- 主插件与直接 MCP 的 `full` 产品必须按 syscall 使用全部能力，无需安装 sibling；插件只声明 Skill、MCP 配置和 bundle。
- 这些投影是最小 MCP 暴露，不是独立安全沙箱；执行隔离仍由显式 Runtime/Sandbox Adapter 负责。
