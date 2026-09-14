# Component Plugin Architecture（v0.12.24）

## 产品装配

Craft 是面向人和 AI 的通用工作运行时。它提供两种互补分发形态：

```text
完整 Craft 插件
├── Craft Core：Verified Work Loop、Policy、State、Receipt、Acceptance、Eval
├── Craft Knowledge：知识来源、Evidence Wiki、知识版本与 Context 引用
├── Craft Memory：Memory Ledger、范围、有效期、撤销与 Context Resolution Receipt
├── Craft Capability：Skill/MCP/Workflow/Adapter 的发现、去重、健康与最小激活
├── Craft Skill Quality：Case、Trial、Grader、比较、晋级证据
├── Craft Workflow Evolution：脱敏执行观察、受限草案与模型调用契约
└── Host Bridge：连接当前宿主或独立执行器

独立组件插件
├── craft-knowledge
├── craft-memory
├── craft-capability
├── craft-skill-quality
└── craft-workflow-evolution
```

完整插件是组合根，不是第六套实现。五个组件与完整插件共享同一数据模型、服务内核和 MCP bundle，通过受限 MCP surface 决定当前宿主能看到什么。安装完整插件不等于激活全部能力；默认仍使用精简、按需描述的 syscall surface。完整插件不会把五个 sibling plugin 作为安装依赖再次下载；组件插件只是同一运行时的最小权限投影。

## Execution Host 不是第二个 Agent

`Execution Host` 指真正执行 Action Contract 的主体。它分为三种协议模式：

| 模式 | 例子 | 是否启动子进程 | 谁推动循环 |
|---|---|---:|---|
| `embedded` | 当前 Codex App、Claude、IDE | 否 | 当前宿主领取动作并回传 Receipt |
| `managed` | 显式选择的 Codex CLI、Claude CLI、本地 Worker | 是 | Craft 的独立运行器 |
| `remote` | MCP Task、A2A Agent、远程 Worker | 否 | 远端协议与租约 |

Codex 插件默认使用 `EmbeddedHostBridge`：当前 Codex 调 Craft 获取 Action Contract，使用自身文件、终端和 MCP 工具执行，再把 Receipt 交回 Craft。Craft 不反向控制 Codex App，也不默认拉起第二个 Codex CLI。

## 独立使用边界

- `craft-knowledge`：可独立检索、读取和治理知识；不会因此取得执行权限。
- `craft-memory`：可独立解析或提议记忆变更；不得保存凭据或跨范围装载。
- `craft-capability`：可独立扫描、去重、审计和推荐；发现不等于安装、激活、授权或调用。
- `craft-skill-quality`：可独立评测并产生晋级证据；不会自动发布 Skill。
- `craft-workflow-evolution`：接收至少两条独立、脱敏且有 Evidence 的执行观察，生成最多两个设计轴的 Workflow 草案请求；不会读取原始用户记录、执行草案或发布 Workflow。

不安装 Craft Core 时，这些组件仍能增强其他 Agent，但只提供局部、bounded 的结论。需要跨组件交付、执行恢复、策略控制、真实状态验收或受限演进时，由完整 Craft 对各组件 Receipt 重新校验并统一裁决。

## Host 与组件扩展

`craft-capability` 与 `craft-workflow-evolution` 的交接是单向的：前者发现并选择已登记的 Asset，后者只形成 `draft` Workflow。只有该草案通过既有 shadow/held-out Eval、Signoff 与 Canary 而成为精确版本的 `verified` Workflow，才可由能力发现/路由作为候选。这样演进记录不会直接污染发现结果或默认执行。

知识与记忆组件同样是可替换实现：关键词、向量或其他 Retrieval Adapter 都先作为候选策略，须通过召回、跨 scope 泄漏、成本与时延的单点评测，才能影响 Context Resolution；它们不能替代 Ledger、Source digest 或 Context Receipt 的事实层。

后续 Codex、Claude、Cursor、Gemini CLI、VS Code 等接入只实现薄 Host Bridge；Obsidian、Serena、kefu 等知识或记忆来源只实现 Source Adapter。协议和事实模型保持稳定，宿主与来源可以替换或补充，不能绕开 Policy、scope、digest、Receipt 和 Evidence。

本版本不包含新的 UI、远程插件市场、后台 Agent Worker，也不声称 Craft MCP 可以主动调用 Codex App 内部工具。
