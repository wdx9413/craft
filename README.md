# Craft

[中文](README.md) | [English](README.en.md)

Craft 是一套通用 Agent Harness：管理可复用能力，保存长任务状态与证据，并把经过验证的做法沉淀为可再次执行的 Workflow。它可以独立使用，也可以通过 MCP 或插件向 Codex、Claude Code、DeepSeek Harness 及其他 Agent 应用提供能力。

Craft 不绑定某个模型、Agent 或行业。研发排障、AI 视频分镜、销售跟进、教学设计和内容生产都使用同一组基础对象：能力、任务、证据、产物、工作流与评测；具体场景通过自己的 Skill 和 Workflow 扩展。

## 核心理念

- 发现而不是全量注入：只索引用户选择的能力目录，先用元数据和文本检索返回少量候选，需要时再读取完整内容。即使能力库很大，也不会把全部 Skill 塞进模型上下文。
- 长任务可以恢复：目标、进度、待办、决策、反馈、产物和证据保存在用户目录，换 Agent 或换会话仍能继续。
- 验证方式显式化：确定性条件交给程序门禁，主观质量交给模型或人；结果记录来源和置信度。
- Workflow 来自真实使用：用户可把成功路径保存为版本化模板，再经过回放和评测逐步提升，而不是依赖平台预置全部行业流程。
- 数据属于用户：默认写入 `~/.craft_data`，不污染业务项目。API Key 只保存环境变量名，不保存密钥值。

## 当前版本已经实现

- 多能力目录管理、真实路径解析、目录引用/符号链接处理和增量扫描。
- Skill frontmatter 解析、SQLite FTS 候选检索和按需读取；搜索结果不携带完整正文。
- 持久化任务、Checkpoint、显式反馈、Artifact 与 Evidence。
- 版本化 Workflow、输入替换、路径边界、敏感信息脱敏和副作用授权。
- 确定性命令、文件/JSON 断言、覆盖率门禁，以及结构化执行回执。
- 版本化评测集与 Agent Profile 基础数据模型。
- MCP 服务，以及 Codex、Claude Code、DeepSeek Harness 和通用 MCP Host 接入。
- Windows、macOS、Linux 共用 TypeScript/Node.js 运行时；不依赖 Python。

向量检索不是必需依赖。短期本地库优先使用零配置检索；未来可选接入兼容 OpenAI Embeddings 协议的服务，并与关键词结果融合。

## 安装

要求 Node.js 24 或更高版本。用户不需要安装 Python。

从 GitHub 安装 CLI：

```bash
npm install -g github:wdx9413/craft
craft init
```

开发者使用 pnpm：

```bash
git clone https://github.com/wdx9413/craft.git
cd craft
pnpm install --frozen-lockfile
pnpm test
```

## 三种使用方式

1. Agent（规划形态）：未来由 Craft 直接承载对话和模型工具循环；当前版本只提供配置与持久化底座，尚不能替代 Codex 或 Claude Code。
2. Supervisor（规划形态）：未来由 Craft 调度 Codex、Claude Code 或其他 Host；当前版本已有可并发领取、依赖阻断和失败换路的编排状态机，但还没有自动 Host Driver。
3. Provider（当前可用）：Craft 通过 MCP/插件提供能力发现、任务延续、Workflow、证据与基础编排能力。

首次运行 `craft init` 会选择模式。配置、SQLite 数据库、索引、日志和备份都位于 `~/.craft_data`；也可用 `CRAFT_DATA_DIR` 指定另一目录。

## 接入 Codex

在 Codex 插件市场添加 Git 来源：

- 仓库：`https://github.com/wdx9413/craft`
- 分支/Tag：建议固定发布 Tag；开发时可用 `main`
- 稀疏路径：`.`（插件清单位于仓库根目录）

插件会读取根目录的 `.codex-plugin/plugin.json` 和 `.mcp.json`。也可以只把 `skills/craft` 作为普通 Skill 安装，但这样不会自动获得 MCP 数据层。

从 v0.2.1 起，插件 MCP 使用仓库内随版本发布的单文件 bundle；Codex 把插件复制到缓存目录后无需再执行 `npm install`，也不会依赖源码仓库的 `node_modules`。升级旧版本后请重新安装插件，并在新会话中验证 `craft_info`。

## 接入 Claude Code

仓库根目录包含 `.claude-plugin/plugin.json`。把该 Git 仓库作为插件源安装；如果宿主只支持 MCP，则使用下方通用配置。

## 通用 MCP

全局安装后，MCP Host 的配置为：

```json
{
  "mcpServers": {
    "craft": { "command": "craft-mcp", "args": [] }
  }
}
```

当前工具使用 `craft_` 前缀，例如 `craft_source_add`、`craft_capability_search`、`craft_task_checkpoint`、`craft_workflow_run` 和 `craft_evidence_record`，避免与宿主或其他 MCP 冲突。

## 数据目录

```text
~/.craft_data/
├─ config/config.json       # 模式、Host 与模型端点配置
├─ db/craft.db              # 任务、Workflow、证据、评测等版本化数据
├─ index/                   # 可重建的能力索引
├─ logs/                    # 脱敏日志
├─ backups/                 # 备份
├─ cache/                   # 可删除缓存
└─ runtime/                 # 临时运行状态
```

Craft 只索引能力来源，不移动或修改来源文件。删除 Source 只删除本地索引记录。

## 验证

```bash
pnpm run typecheck
pnpm test
```

测试命令同时强制行、函数和分支覆盖率为 100%。覆盖率是测试工具确定性计算的结果，不由模型自报。

更详细的边界与数据模型见 [中文架构说明](docs/architecture.zh-CN.md)。
