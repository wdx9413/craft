# Craft

[中文](README.md) | [English](README.en.md)

## 简版产品介绍

Craft 是面向 AI Agent 工作的能力管理与验证系统。它让 Agent 能从大量能力中找到合适的一小部分，跨会话持续完成长任务，用证据而不是自述确认结果，并把成功路径沉淀为可评测、可回滚的 Workflow。

Craft 的核心对象和协议不绑定某个模型或行业。它既能通过 MCP、插件或 Adapter 为 Codex、Claude Code、DeepSeek Harness 等宿主提供能力，也能作为未来独立 Agent 和 Supervisor 产品的基础。研发、AI 视频、销售、教育和内容创作可以共享同一套任务、产物、证据、工作流和评测内核，再用各自的 Skill、Validator 和领域 Kit 扩展。

## 核心理念

- 发现而不是全量注入：只索引用户选择的能力目录，先用元数据和文本检索返回少量候选，需要时再读取完整内容。即使能力库很大，也不会把全部 Skill 塞进模型上下文。
- 长任务可以恢复：目标、进度、待办、决策、反馈、产物和证据保存在用户目录，换 Agent 或换会话仍能继续。
- 验证方式显式化：程序、模型、人工和业务结果使用不同 Grader；Signoff Policy 决定一个精确版本是否达到复用标准。
- Workflow 来自真实使用：用户可把成功路径保存为版本化模板，再经过回放和评测逐步提升，而不是依赖平台预置全部行业流程。
- 数据属于用户：默认写入 `~/.craft_data`，不污染业务项目。API Key 只保存环境变量名，不保存密钥值。

## 当前版本已经实现

- 多能力目录管理、真实路径解析、目录引用/符号链接处理和增量扫描。
- Skill frontmatter 解析、SQLite FTS 候选检索和按需读取；搜索结果不携带完整正文。
- 持久化任务、Checkpoint、显式反馈、Artifact 与 Evidence。
- 版本化 Workflow、输入替换、路径边界、敏感信息脱敏和副作用授权。
- 确定性命令、文件/JSON 断言、覆盖率门禁，以及结构化执行回执。
- 版本化评测集与 Agent Profile 基础数据模型。
- 六维 Harness Configuration、不可变 Trial/Outcome、只追加 Trace、Workflow 自动取证闭环，以及 held-out Eval 驱动的晋级与回滚。
- 版本化 Grader、多来源 Grade 和 Signoff Policy；模型判断不会被记录成程序证明。
- 同评测集版本对比：在 Suite 精确版本、分区、Subject 类型和 Case 集合一致时，聚合比较 Workflow、Agent Profile 或 Harness Configuration 的质量、成本、耗时与失败类型。
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

当前工具使用 `craft_` 前缀，例如 `craft_source_add`、`craft_capability_search`、`craft_task_checkpoint`、`craft_workflow_trial_run`、`craft_evaluation_run_aggregate` 和 `craft_evaluation_compare`，避免与宿主或其他 MCP 冲突。

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

产品定义、路线和模块化技术方案见 [Craft 文档中心](docs/README.md)；当前实现边界见 [中文架构说明](docs/architecture.zh-CN.md)。
