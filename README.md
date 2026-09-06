# Craft

[简体中文](README.md) | [English](README.en.md)

Craft 是面向 AI Agent 的本地优先能力目录、任务接续和可信工作流工具。它让 Codex、Claude 等宿主复用同一套 Skill 索引、任务状态、验证规则与恢复记录。

## 能做什么

- 注册多个外部 Skill 文件夹，并增量更新本地索引。
- 从上万个 Skill 中先检索少量候选，再加载真正需要的内容。
- 保存任务进度、决策、反馈与 Artifact 引用，供新会话接续。
- 组合程序验证、模型判断和人工审批。
- 控制本地写入、外部写入和破坏性操作的授权边界。
- 在可信 checkpoint 处恢复，同时保留原始失败历史。

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

默认安装到 `~/plugins/craft`。安装器会记录当前 Python 的绝对路径，避免 Codex 或 Claude 的 GUI 进程找不到 Python。

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

## 日志

Craft 默认把简洁 INFO 日志写到 stderr，不占用 MCP 的 stdout，因此不会破坏 STDIO JSON-RPC。日志不自动记录 Prompt、凭据或完整业务正文。

```powershell
$env:CRAFT_LOG_LEVEL = "WARNING"
```

macOS / Linux 使用 `export CRAFT_LOG_LEVEL=WARNING`。可选级别为 `DEBUG`、`INFO`、`WARNING`、`ERROR`。

## 文档

- [架构与可信控制面](docs/architecture.zh-CN.md)
- [Workflow 字段、状态与示例](skills/craft/references/workflow-runtime.md)
- [MCP 工具说明](skills/craft/references/tool-contract.md)

## 测试

```powershell
.venv\Scripts\python -m coverage run --branch -m unittest discover -s tests
.venv\Scripts\python -m coverage report
```

项目要求语句和分支覆盖率均为 100%。CI 覆盖 Windows、macOS、Linux 与 Python 3.11/3.13。

## 当前边界

Craft v0.1 仍是本地技术预览版，暂不包含远程 Skill Hub 同步、向量检索、图形界面、Workspace 文件快照和并行 Agent 调度。SQLite 是默认检索方式，Embedding Provider 将保持可选。
