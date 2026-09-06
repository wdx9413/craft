# Craft

[简体中文](README.md) | [English](README.en.md)

> 让 AI 不只“会做一次”，而是能够找到合适能力、接着上次继续、证明结果可信，并把成功方法沉淀下来。

Craft 是一套让 AI Agent 能发现合适能力、接续长期任务、验证结果并复用成功经验的通用工作系统。它从 Skill 索引开始，把任务状态、验证证据和可复用 Workflow 组织成用户自己的能力资产，并可通过 MCP、插件和 CLI 接入不同 Agent 应用。

## 为什么需要 Craft

今天的 Agent 很聪明，但真正长期使用时仍有几个断点：

- 安装几十、几百甚至上万个 Skill 后，不能每次全部塞进上下文。
- 会话结束后，进度、决定和失败原因容易散失。
- Agent 说“已经完成”不等于结果真的通过测试或人工验收。
- Codex、Claude 或其他平台各自保存能力，切换平台就要重新配置。
- 重复任务每次从零规划，成功方法没有自然演化成可复用 Workflow。

Craft 把这些问题收敛为一条闭环：

```text
发现能力 → 执行任务 → 留存状态与产物 → 验证结果 → 失败恢复 → 学习复用
```

## 核心理念

### 与 Agent 解耦的控制面

Craft 不绑定某一种模型、Agent Loop 或交互界面。接入方可以负责理解、规划和执行，Craft 独立管理能力发现、状态、权限、证据、检查点与审计。接入方可以是 Codex、Claude、其他 Agent 应用，也可以是用户自己开发的程序。

### 先检索，再加载

Craft 只扫描用户明确注册的 Skill 来源，并维护本地增量索引。任务到来时先用代码检索少量候选，再加载选中的 Skill，不把整个能力库交给模型。

### 不相信“我做完了”，要看证据

结果可以由程序、模型或人验收，但来源必须明确。测试通过属于 `program_verified`，模型判断属于 `model_judged`，人工批准属于 `human_approved`，它们不能互相冒充。

### Workflow 从真实工作中生长

Craft 不要求产品方预先写完所有行业模板。用户完成真实任务后，可以把有效步骤、约束、反馈和验收条件抽象成候选 Workflow，再经过重复运行逐步提升为可复用能力。

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
- Codex、Claude Code、MCP 和 Python CLI 接入。

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

## 文档

- [架构与可信控制面](docs/architecture.zh-CN.md)
- [Workflow 字段、状态与示例](skills/craft/references/workflow-runtime.md)
- [MCP 工具说明](skills/craft/references/tool-contract.md)

## 当前边界

Craft v0.1 仍是本地技术预览版，暂不包含远程 Skill Hub 同步、向量检索、图形界面、Workspace 文件快照和并行 Agent 调度。SQLite 是默认检索方式，Embedding Provider 将保持可选。
