# DSH / Codex / Claude Code / Pi 插件生态对照与 Craft 子能力判断

日期：2026-11-11。性质：一手资料对照，不是 Craft 功能承诺。外部插件均为第三方内容，热度不等于安全、可信或适用于 Craft；本文不据此把任何外部插件升级为 Craft Knowledge。

## 一手来源与读取结果

| 生态 | 一手入口 | 读取到的事实 |
| --- | --- | --- |
| DSH（DeepSeek Harness） | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)、[architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) | “Everything is a Plugin”，基于 Cordis；profile/bundle 组合插件树；session/agent/capability 三类事件；插件可提供 tool、adapter、session log 甚至 agent loop。 |
| Codex | [Plugins · ChatGPT Learn](https://learn.chatgpt.com/docs/plugins) | Plugin 可含 Skill、MCP server、browser extension、Hook；ChatGPT 与 Codex 共用一个公共目录；本地/仓库 marketplace 可分发；Codex CLI 用 `/plugins` 浏览安装。 |
| Claude Code | [Anthropic's marketplaces](https://code.claude.com/docs/en/plugins/anthropic-marketplaces)、[Claude Marketplace](https://claude.com/marketplace/plugins) | official / community 两个 marketplace；插件由 Skill、agent、Hook、MCP/LSP server 组成；官方安装面板展示每次请求的 context cost 与调用时成本。 |
| Pi | [Extensions](https://pi.dev/docs/latest/extensions)、[Package Catalog](https://pi.dev/packages) | Extension 是 TypeScript 模块，运行在 Pi 进程内、拥有同等的系统权限；可注册 tool、命令、provider/MCP server，拦截 tool call、注入上下文、自定义 compaction 与 UI；npm/git 包分发。 |

热度参考只使用能追溯到一手仓库的类别信号，不把聚合站的 star/下载数当作 Craft 需求。可复核的类别包括：上下文压缩与上下文可视化、MCP/工具代理、LSP/诊断、子代理编排、权限与路径护栏、记忆与长期会话、用量/成本/状态行、计划与评审、浏览器/Web 数据、外部 SaaS 连接器。

## 对照 Craft：已有、可复用、真实缺口

| 生态热门类别 | Craft 当前对应 | 判断 |
| --- | --- | --- |
| 上下文压缩、长期会话 | `craft_runtime_truth_compact`、Compaction、Context Receipt、`craft_context_open` 的 bounded budget | 已有机制；不再造第二套压缩器。 |
| 上下文/用量可视化 | `craft_usage_report`、`craft_context_resolution_feedback`、Workbench 的 `task-context-usage` | 有数据但缺少 Host 侧一行的可复用投影；本轮补只读 statusline。 |
| MCP/工具代理、最小工具面 | `craft_context_tools_discover`、syscall surface、Activation Profile、Capability Kit | 已有；继续按任务分片，不新增一个通用 MCP 代理。 |
| LSP/代码智能、诊断 | Codebase 已能按 trusted `codebase-lsp.json` 启动语言服务器、拉 symbols/relations/diagnostics | 执行器已有，缺“语言服务是否就绪、该配什么”的只读视图；本轮补 readiness。 |
| 子代理/并行编排 | Expert Sub-agent、Stateful Compute Delegate、Verified Work Loop、Harness Topology | 已有受控只读子代理；默认仍单 Agent，不把并行当默认收益。 |
| 权限护栏、路径保护 | Execution Policy、Action Gate、OS security plan/verify、Datasec、Approval、Sandbox Adapter | 已有；本轮不新增权限边界。 |
| 记忆与长期项目上下文 | Memory Ledger、Knowledge Claim、Experience、Project Brain、Context Capsule | 已有，且强调来源/作用域/证据；不复制第三方“自动记住一切”。 |
| 计划、评审、todo | Work Control、Task Contract、Review Verification、Task Checkpoint、Procedure Graph | 已有；todo 更适合 Host UI 投影，不需第五个 Context 成员。 |
| 浏览器/Web 数据、SaaS 连接器 | `craft_web_fetch`、`craft_web_action_*`、Capability Connector、A2A | 连接器应作为独立 Capability Source 接入；不扩成 Craft 自带通用浏览器。 |
| 使用量/成本/状态行 | `craft_usage_report`、`craft_metrics_report`、Cost Receipt | 本轮补 statusline，把“估算/实测”分开。 |

## 本轮补充的子能力

| 子能力 | 为什么加 | 边界 |
| --- | --- | --- |
| `craft_context_usage_statusline` | Codex/Claude/Pi 的 statusline / context dashboard 是普遍需求；Craft 已有 receipts 与 feedback，但缺 Host 一行可读投影 | 只读、无正文；区分 host-reported 与 estimated；不改变 Context 选择或预算。 |
| `craft_lsp_readiness` | Claude 将 LSP server 作为插件；Pi 有 `pi-lens` 等编辑时诊断；Craft 已有 LSP 执行器但用户不知道如何就绪 | 只读；从不启动 server、不安装二进制、不允许仓库注册可执行文件；只接受用户管理 `codebase-lsp.json`。它刻意不使用 `craft_codebase_` 前缀，以免改变既有 Codebase 产品面。 |
| `craft_capability_iteration_gaps` | 需要一个统一“还缺什么”的答案，避免每次从散落文档或热度清单推断 | 只读；区分 runtime/evidence/authorization；不自动修。 |

## 不建议新增的子能力

- 不新增通用 MCP 代理：Codex、Claude、Pi、DSH 都有 MCP，但 Craft 的价值是发现 → 激活 → 授权 → 执行分离，重复代理会绕过 Activation Profile 与 Policy。
- 不新增自动记忆/自动“学会一切”：Memory/Knowledge/Experience 已存在；自动写入会破坏 Evidence、冲突、作用域与撤销边界。
- 不新增默认多 Agent：热门 subagent 插件多为高权限平行执行；Craft 只在受控只读诊断和既有 Work Loop 内扩展，默认单 Agent。
- 不新增全权限 Hook 运行时：Pi/DSH 扩展能改一切，但那不是 Craft 的可信边界；Craft 的 Hook 只做观察/补充/阻断，不能成为第二事实账本。
- 不默认加入 jailbreak、绕过计费、免费模型代理、桌面宠物、皮肤等插件：它们不服务 Craft 的受控工作与证据目标。
- 不新增第二套 compaction 或 UI 框架：现有 Compaction、Receipt、Workbench 投影足够；新能力优先做成 Host 可消费的只读投影。

## 限制

- 热度、star、下载量来自聚合站或目录页，可能变动，不是安全审查或 Craft 需求证明。
- DSH 为 developer preview，存在 breaking changes；Pi 扩展运行于同进程全权限；外部插件即使热门也不能绕过 Craft 的 provenance、权限、评测与回滚要求。
- 本文只增加只读投影与文档，不新增执行权、不自动安装外部插件、不把第三方内容写入 Knowledge。
