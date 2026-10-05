# 四组件的无宿主 Hook 接入

默认聚合产品 `craft-context` 与四个子产品共用 Craft Runtime，通过 Skill + MCP 显式调用。宿主 Hook 是可选事件输入；服务器内部 HookPlane、作用域、证据、状态转换校验继续生效。服务器不能强制模型每轮调用，也不能观测绕过 Craft 的宿主工具。

## 分发与数据空间

- 支持 Agent Plugins 1.0 的客户端：加载 `plugins/craft-*/plugin.json`，标准 MCP 配置为根目录 `mcp.json`。标准核心只有 Skill 和 MCP，没有 Hook 组件。根据 [Agent Plugins 规范](https://agent-plugins.org/specification)生成，客户端是否实现标准仍需现场验收。
- 原生 Codex/Claude 兼容 manifests 保留原来的 Hook 引用；选择这些兼容包意味着选择可选增强。现有用户配置不会被本次代码修改。
- 普通 MCP 客户端：使用同级 `craft-common-use/init.mjs`。支持 Cursor、Gemini CLI、VS Code workspace、OpenCode、Claude Code project，以及原有 Cline、Qoder、Trae、WorkBuddy、DSH。它安装 Skill 和 stdio MCP，不安装 Hook。
- 新 portable 包沿用 Runtime 默认数据目录或显式 `CRAFT_DATA_DIR`。旧包可能将数据放在 `${PLUGIN_DATA}/data`，其历史数据不自动迁移。共同的项目 identity 不等于共同数据库。需要跨宿主共享时，显式配置同一个受信任本地 `CRAFT_DATA_DIR` 或同一远程租户；跨机器使用既有 bundle export/verify/import_plan/import_apply，不能复制运行中的 SQLite/WAL。

安装器先合并配置并保留其他服务，冲突要求 `--force`。卸载只删除仍匹配本安装器的 MCP entry；修改后的 Skill 不会删除。每个宿主的安装失败会恢复其配置和 Skill；`--agent all` 各目标独立，不是跨宿主事务。`--dry-run` 不启动探针。

## 最短使用流程

| 产品 | 第一次使用 | 后续操作 | 结果边界 |
|---|---|---|---|
| Knowledge | bootstrap/register → scope identity resolve → scoped search | source ingest → exact review packet → host review → resolve | reviewed 默认可检索，candidate 只能显式诊断；源 revision/digest 变化重新验证 |
| Memory | scope identity resolve → scoped resolve | 明确同意 capture → conflict/review/materialize → correction/revoke | 拒绝旧 `expected_version`；撤销保留审计历史，不是物理删除 |
| Experience | scope identity resolve → routeable procedure resolve | evidence/observe → draft/submit → create → shadow/held_out/signoff/canary | 候选不进入 Context；canary 失败退出路由；Host 上报不自动成为独立验证 |
| Codebase | repository_ensure(project_root) 自动识别和增量索引 | symbol/callers/impact/context_slice；修改后 refresh | 只分析当前仓库允许路径的 checkpoint；工作目录 drift 单独显示，调用关系是静态候选 |

每个独立 K/M/E 产品在服务端绑定自己的成员；不能靠传入 `members` 越过产品边界。Context 的条数/字符预算由所有成员共同消耗。中文查询通过统一词项划分进入检索；无需引入新数据库。

`craft_context_resolution_feedback` 记录 exact receipt 的 helpful/irrelevant/incorrect/stale 反馈及可选 Evidence；不自动改变知识、记忆或程序状态。Memory receipt 的 explanation 提供经过作用域优先级、时间策略、查询和预算后的计数；不枚举其他作用域中的条目。

## 结果真实性

`craft_experience_observe.verification` 可携带 `contract_ref / workspace_revision / producer / started_at / completed_at / exit_code / evidence_digest`。服务器拒绝倒序时间和 exit code/outcome 矛盾，但保存为 `host_attested`、`independently_verified:false`。独立执行证据仍须由已有受控执行器/CI验证链提供。

可选 Hook 仅把已识别的测试命令记为 verification；版本查询和安装不算验证。同一 verifier 以最后结果为准，编辑后旧结果失效，缺 turn_id 不用 session 假装独立任务。模型断言、Hook 观察、独立执行器结果不是同一证据等级。

## 多语言分析适配

`craft_codebase_analysis_import` 接受 `craft-static-analysis-v1`：

```json
{
  "format": "craft-static-analysis-v1",
  "analyzer": "your-language-server",
  "analyzer_version": "pinned-version",
  "nodes": [{"id":"symbol_a","kind":"symbol","path":"a.py","name":"run","language":"python","source_digest":"checkpoint-file-sha256","span":{"start_offset":0,"end_offset":3}}],
  "edges": []
}
```

每条节点必须属于所选最新 checkpoint，digest 和 UTF-16 offset 必须匹配。仅存路径、符号、span、digest 和关系，限制 2 MB/10,000 nodes/20,000 edges。结果标记 `adapter_reported/partial`。LSP 的 Java/Python/Go 符号标准化 fixture 已验证，关系边需显式提供。默认 TS/JS 已使用 TypeScript checker；Python 的真实 Jedi 分析及 MCP 导入验收见 [Codebase](craft-codebase.md)。Java/Go 尚未完成真实语言服务器接入验收。

已有 LSP DocumentSymbol 导出可用 `node scripts/codebase/normalize-lsp.ts lsp-documents.json` 转换。输入为 `{analyzer,analyzer_version,documents:[{path,language,content,source_digest,symbols}]}`，其中 symbols 为 LSP DocumentSymbol 数组。输出可直接作为 analysis 提交。它支持嵌套符号、CRLF 与 UTF-16，不启动语言服务器、不制造调用关系。AST/SCIP 生产方可以直接输出上述规范；没有捆绑 Java/Python/Go 语言服务器或 SCIP protobuf 解析器。

## 验收与升级

```sh
node scripts/smoke/component-conformance.ts dist/plugin/craft-mcp.cjs
node --test tests/component-hookless.test.ts tests/codebase-lsp-adapter.test.ts
```

conformance 在隔离数据目录中运行真实 stdio initialize/list/call，覆盖 Knowledge ingest/review/freshness、Memory recall/revoke、Experience gate/rollback 和 Codebase 首跑/刷新，输出 bundle SHA-256、协商协议与验证等级。支持的 MCP 协议仍为 2025-03-26、2025-06-18、2025-11-25；不宣称实现 2026-07-28。

安装器探针只达到 `tool_call_verified`；conformance 达到 fixture `workflow_verified`。二者都报告 `host_session_verified:false`。宿主会话验收还需在目标工具里确认 Skill 被发现、MCP 被信任、当前会话工具可见，再实际完成一个限定 scope 的调用。

效果评测继续使用已有 Knowledge evaluation、retrieval adapter evaluation、Experience gate 与工程评测执行器。固定 repository/checkpoint、Host/model、预算和验收命令再做 baseline/candidate paired trials。本地合同测试不证明模型任务成功率提高。

默认聚合入口及五产品四种分发方式见 [Craft Context](craft-context.md)。
