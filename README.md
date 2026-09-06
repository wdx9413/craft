# Craft

[简体中文](README.md) | [English](README.en.md)

> 让 Agent 找得到能力、选得对、做得完、验得过，并把有效经验积累下来。

Craft 是面向 AI Agent 的能力管理与任务运行系统。它把 Skill、Workflow、工具与服务连接等统一视为可发现、可组合、可验证的能力资产，并围绕真实任务管理一条完整闭环：发现、登记和索引能力，按任务检索、选择与组合，协调并接续执行，保存状态、产物和验证证据，通过评测与回归判断结果和能力版本是否可靠，最后把经过验证的方法沉淀为可复用 Workflow。

当前 v0.1 已落地本地 Skill 发现与管理、任务接续、混合验证、Workflow 运行、可信恢复、可复用 Case Suite 和跨版本评测对比，并新增跨宿主 Agent Profile、依赖编排、并发 Lease 与模型失败切换。把插件与 MCP 元数据纳入能力目录、自动执行评测与基于门槛的能力晋级仍属于后续阶段。

## 为什么需要 Craft

今天的 Agent 很聪明，但真正长期使用时仍有几个断点：

- 安装几十、几百甚至上万个 Skill 后，不能每次全部塞进上下文。
- 会话结束后，进度、决定和失败原因容易散失。
- Agent 说“已经完成”不等于结果真的通过测试或人工验收。
- Codex、Claude 或其他平台各自保存能力，切换平台就要重新配置。
- 重复任务每次从零规划，成功方法没有自然演化成可复用 Workflow。

Craft 把这些问题收敛为一条能力生命周期：

```text
发现 → 管理 → 匹配选择 → 组合执行 → 留存状态与证据 → 验证评测 → 学习复用
```

## 核心理念

### 与 Agent 解耦的控制面

Craft 不绑定某一种模型、Agent Loop 或交互界面。接入方可以负责理解、规划和执行，Craft 独立管理能力发现、状态、权限、证据、检查点与审计。接入方可以是 Codex、Claude、其他 Agent 应用，也可以是用户自己开发的程序。

### 先检索，再加载

Craft 只扫描用户明确注册的 Skill 来源，并维护本地增量索引。任务到来时先用代码检索少量候选，再加载选中的 Skill，不把整个能力库交给模型。

### 不相信“我做完了”，要看证据

结果可以由程序、模型或人验收，但来源必须明确。测试通过属于 `program_verified`，模型判断属于 `model_judged`，人工批准属于 `human_approved`，它们不能互相冒充。

### 长任务靠持久状态推进，不靠无限上下文

长任务容易在会话中断、上下文压缩或多次修复后丢失目标并逐渐跑偏。Craft 把目标、进度、决策、Evidence、Artifact 引用和待办保存到会话之外；通过有界循环尽早停止重复失败，并从最近的可信 checkpoint 派生新 Session。这样 Agent 可以换会话、换客户端后继续，而不必把全部历史重新塞回上下文。

### Workflow 从真实工作中生长

Craft 不要求产品方预先写完所有行业模板。用户完成真实任务后，可以把有效步骤、约束、反馈和验收条件抽象成候选 Workflow，再经过重复运行逐步提升为可复用能力。

### 评测贯穿能力生命周期

评测不只是最后生成一张分数表：执行时验证本次结果，复用前用代表性 Case 检查 Skill 或 Workflow 是否稳定，升级后进行回归比较，系统自身还要评测检索是否选对能力、恢复后能否继续以及不同接入端是否行为一致。评测提供可追溯的质量门槛，但不承诺 Agent 永不犯错。

## 希望解决的场景

| 场景 | Craft 保存什么 | 如何判断完成 |
|---|---|---|
| Agent 研发 | 代码、Case、调用链、测试报告 | 单测、覆盖率、兼容性和人工 Review |
| AI 视频 | 剧本、分镜、参考图、生成版本 | 规格检查、角色一致性、人工选片 |
| 销售 | 客户事实、跟进阶段、话术约束 | 字段核对、合规规则、发送审批 |
| 教育 | 学习目标、练习记录、反馈 | 答案校验、目标达成、教师确认 |
| 内容创作 | 资料、稿件版本、编辑要求 | 事实核验、结构评审、发布审批 |

这些场景可以共用同一个底层闭环，只替换领域 Skill、工具和验证规则。这是产品的适配方向，不代表 v0.1 已内置相应行业连接器或完整模板；当前首先使用真实研发任务验证通用机制。

## 当前已经具备

- 多 Skill 文件夹注册、真实路径解析和增量索引。
- 面向大规模能力库的候选检索与按需加载。
- 跨会话 Task、Checkpoint、Feedback 和 Workflow 版本。
- 程序验证、模型 Judge、人工审批的混合流程。
- `read_only`、`local_write`、`external_write`、`destructive` 四级副作用控制。
- 从可信 checkpoint 派生恢复，不覆盖原失败历史。
- 有版本的评测 Case Suite、不可变 Case 结果、聚合指标和同套件版本对比。
- 跨平台 Agent Profile、依赖 DAG、并发派发、Lease 去重和顺序 fallback。
- Codex、Claude Code、MCP 和 Python CLI 接入。

## 评测能力的当前边界

当前已经具备确定性执行验证、Agent/Model/Human 混合验收、来源分级、Workflow 版本与不可变运行记录；也可以保存带版本的 Case Suite，为 Capability、Skill、Workflow、工具、MCP、插件、Agent、模型、系统或组合创建 Eval Run，逐 Case 记录 verdict、score、metrics、evidence 和 provenance，并确定性聚合完成率、通过率、加权得分及版本差异。

当前仍由宿主 Agent、程序或人工执行 Case 并回填结果；自动 Runner、Grader 适配器、Dataset 导入、统计置信度、重复运行退化检测、晋级建议，以及跨接入端和长任务恢复专项评测尚待建设。因此它已经具备最小可复用评测闭环，但还不是完整的 Agent 评测平台。

所有运行数据默认保存在 `~/.craft_data`，不会写入当前业务项目。

## 环境要求

- Python 3.11+
- Windows、macOS 或 Linux
- 从 Codex Marketplace 启动 MCP 时需要 [`uv`](https://docs.astral.sh/uv/getting-started/installation/)

## 从源码开始使用

克隆仓库后，在项目根目录执行：

Windows：

```powershell
py -3 scripts/install_plugin.py
```

macOS / Linux：

```bash
python3 scripts/install_plugin.py
```

默认安装到 `~/plugins/craft`。

也可以只使用 CLI：

```powershell
py -3 -m venv .venv
.venv\Scripts\python -m pip install -e .
craft info
craft add-source D:\path\to\skills
craft search "诊断服务故障"
```

macOS / Linux 将 `.venv\Scripts\python` 换成 `.venv/bin/python`。

## 在 Codex 中使用

仓库包含 `.codex-plugin/plugin.json`、`.mcp.json` 和 `.agents/plugins/marketplace.json`。

当 `craft-agent-harness==0.1.0` 已发布到 PyPI 后：

1. 确认 `uvx --version` 可以执行。
2. 在 Codex 打开 `/plugins`，选择 **Add Marketplace**。
3. 来源填写 `https://github.com/wdx9413/craft`。
4. 稀疏路径留空；测试阶段选 `main`，正式使用建议选 Git Tag。
5. 安装 Craft，并开始一个新会话。

目前 PyPI 首次发布尚未完成；在此之前请使用上面的源码安装方式。

## 在 Claude Code 中使用

Craft 包含 `.claude-plugin/plugin.json`，并与 Codex 共用 MCP：

```bash
claude --plugin-dir ~/plugins/craft
```

随后使用 `/mcp` 检查连接，并调用 `/craft:craft`；也可以让 Claude 根据任务自动选择 Craft Skill。

## 常见使用流程

### 添加并搜索 Skill 库

让 Agent 调用：

```text
craft_source_add(path="你的 Skill 文件夹")
craft_capability_search(query="当前任务需要的能力")
craft_capability_get(asset_id="选中的能力 ID")
```

Source 可以是普通目录、symlink 或 Windows junction。删除 Source 只删除索引，不删除原文件。

### 保存并接续任务

```text
craft_task_open → craft_task_checkpoint → 新会话 craft_task_open(task_id=...)
```

### 运行可信 Workflow

```text
craft_workflow_plan
→ craft_workflow_start
→ Agent / Judge / Human 节点
→ craft_workflow_submit
→ passed / repair / approval / restore
```

`allow_execution=true` 只授权本地写入。外部写入和破坏性操作必须通过 `approved_side_effects` 单独授权。

### 比较能力或 Agent 版本

```text
craft_eval_suite_list / craft_eval_suite_save
→ craft_eval_run_start（每个被测版本一个 Run）
→ 执行 Case 并调用 craft_eval_result_submit
→ craft_eval_run_get / craft_eval_compare
```

当前由宿主 Agent、程序或人工执行 Case；Craft 保存不可变结果并计算可复算指标。

### 编排不同 Agent 和模型

```text
craft_agent_profile_save（角色、宿主、模型、权限）
→ craft_orchestration_plan_create（节点、依赖、候选 Profile）
→ craft_orchestration_dispatch（领取并行就绪节点）
→ Codex / Claude / API 宿主执行
→ craft_orchestration_submit（结果、证据、来源）
```

例如可以配置 Astra 负责架构与审查、Luna 负责实现和测试，也可以把 Claude、DeepSeek 或自建 API Profile 放入同一个计划。当前 MCP 返回结构化派发请求，由宿主调用自己的原生子 Agent；Craft 本身不冒充 Codex/Claude 的进程控制 API。

## 文档

- [架构与可信控制面](docs/architecture.zh-CN.md)
- [Workflow 字段、状态与示例](skills/craft/references/workflow-runtime.md)
- [评测 Case、结果与对比语义](skills/craft/references/evaluation-runtime.md)
- [多 Agent、模型路由与 Lease](skills/craft/references/multi-agent-runtime.md)
- [MCP 工具说明](skills/craft/references/tool-contract.md)

## 当前边界

Craft v0.1 仍是本地技术预览版，覆盖能力检索、长任务接续、验证、恢复、人工驱动的版本评测和宿主介导的多 Agent 编排，不是无人值守的后台执行平台。当前暂不包含远程 Skill Hub 同步、向量检索、图形界面、Workspace 文件快照、定时/后台调度、Lease 超时回收和宿主进程自动拉起。SQLite 是默认检索方式，Embedding Provider 将保持可选。
