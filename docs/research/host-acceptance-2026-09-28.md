# 多 Host 接入验收：2026-09-28

本报告以“Skill + MCP 是可移植入口，Hook 是可选增强”为验收假设。目标是定位实际可用的 Host、复用已有验证入口，并清楚区分协议 fixture 与真实会话。第一阶段只读探测；随后依据用户“全部执行”的授权，执行了临时工作区内的真实 Host 只读验收，结果见末节。没有修改用户全局配置或部署远程服务。

## 结论

无需 Hook 即可使用四组件，但三个条件必须分别证明：客户端确实加载当前包、会话实际调用目标工具、工具结果被纳入具体任务并产生可核验结果。离线脚本只能证明前两者中的协议实现部分，不能替代 Host 会话证据。研究 Agent 工具面中的旧版 Experience 已挂载，但未暴露 `craft_procedure_plan`，该采样不能证明新组合流程可用，也不能代表主任务工具面。

仓库已有安装器、实际 stdio 测试和 HTTPS 部署验收，不需要再造一套以客户端自报 JSON 为“真实 Host 通过”的脚本。本轮新增的是这份验收报告；后续自动化应消费 Host 原生调用日志，并保留其来源、版本和任务边界。代码中的 `host_session_verified: false` 必须保留，除非存在独立来源核验。

## 本机只读探测结果

| Host | 已观察事实 | 尚未证明 |
| --- | --- | --- |
| Codex | `codex --version` 为 `0.151.0`；`codex mcp list --json` 中四组件均 enabled | 配置项不等于运行时挂载；研究 Agent 的工具面有 Memory/Experience，Knowledge 未出现，Experience 无 `craft_procedure_plan`；主任务另行采样未发现 Memory/Knowledge，不能相互代替 |
| Claude Code | `claude --version` 为 `2.1.220`；`claude mcp --help` 可用 | 本次检查的 `~/.claude.json` 全局及本项目配置无 Craft 项；没有检查全部插件来源，不能断言完全未安装 |
| Cursor CLI | `agent --version` 为 `2026.03.30-a5d3e17`；`agent mcp --help` 支持 `list-tools` | 用户 `~/.cursor/mcp.json` 的 `mcpServers` 为空，本项目配置不存在；没有真实会话 |
| Cursor launcher | `cursor` 命令存在，但 `cursor --version` 返回 1 | 不将命令存在计作 IDE 可用 |
| VS Code / Trae CN / WorkBuddy | `/Applications` 中有对应应用 | 未启动应用，不能证明配置、登录、MCP 工具面或模型使用 |
| Gemini / OpenCode / Copilot CLI | 当前 PATH 的只读命令查找未找到 | 不等于整机不存在，也不否定其他运行环境 |

探测仅输出版本、名称和 enabled 标记，没有输出配置中的环境变量、地址、凭证或完整用户配置。工具清单来自研究 Agent 自己的 `ALL_TOOLS`，采样范围必须保留；主任务再次检索未发现 Memory/Knowledge，因此不能把本研究 Agent 的 Memory 可见性推广到主任务或其他 Host。下文新建 Codex CLI 会话的证明也仅属于记录的 session ID。

## 现有实现与验证边界

| 入口 | 可证明的内容 | 不可据此宣称 |
| --- | --- | --- |
| [组件 stdio conformance](../../scripts/smoke/component-conformance.ts) | 真实 bundle 的 initialize、tools/list、参数 schema、四组件工作流调用；临时独立数据目录 | 某 IDE 已挂载、模型理解 Skill、真实项目效果 |
| [通用安装器](../../../craft-common-use/init.mjs) / [可移植性测试](../../../craft-common-use/tests/portability.test.mjs) | 多客户端配置方言、保留用户配置、失败回滚、Skill 完整目录、实际工具探测 | 运行探测器的 Node 进程就是目标 Host |
| [Readiness](../../core/component-readiness.ts) / [测试](../../tests/component-standalone-readiness.test.ts) | 当前 release、可见工具面、已有执行回执的过滤和缺失诊断 | readiness 请求本身是上下文检索；历史 hook 回执证明当前模型已用结果 |
| [HTTPS 验收](../../deploy/components/acceptance.mjs) / [部署说明](../../deploy/components/README.md) | 有真实配置后检验 HTTPS、鉴权与服务器响应 | 已部署、真实 IdP 已接通、客户端 OAuth discovery 已实现 |

通用安装器目前列出的客户端为 Cursor、Gemini、VS Code、OpenCode、Claude、Cline、Qoder、Trae、WorkBuddy、DSH。Codex 走已有 plugin 路径，不能把 `--agent codex` 写进通用安装器命令。

## 可以立即执行的离线验证

以下命令不调用收费模型。测试会在临时目录写入 fixture，不能将它们写入用户真实 Knowledge/Memory/Experience 数据域。

```sh
# 在 craft 仓库运行；先确保 dist/plugin 是本次待验收构建。
node scripts/smoke/component-conformance.ts dist/plugin/craft-mcp.cjs
node --test tests/component-standalone-readiness.test.ts tests/host-ecosystem-adapters.test.ts

# 在 craft-common-use 仓库运行。
node init.mjs --list
node init.mjs --agent all --product experience --scope project --dry-run
node --test tests/portability.test.mjs
```

本轮子任务实际执行了 `--list`、`--help` 与只读 Host 探测；上面的测试是可执行复验入口，不把尚未在本子任务重跑的测试计为新通过证据。主任务可统一构建后运行，避免把并行修改中的中间构建作为最终验收包。

## 真实 Host 验收矩阵

每个 Host 都应固定：Host 名称/版本、原生 session 标识、包摘要、组件、scope、工作区 revision，以及原生工具调用记录位置。记录请求参数摘要与响应摘要，避免复制对话正文和凭证。跨 Host 复验使用相同构建、相同用例与独立数据目录。

| 阶段 | 必须观察到的证据 | 失败如何解释 |
| --- | --- | --- |
| 配置加载 | Host 管理界面或原生命令展示目标 Craft server | 未配置/未批准，不归因于模型 |
| 工具发现 | 会话中的完整目标工具名；Experience 包含 `craft_procedure_plan` 及本次新增运行工具 | 工具缺失先查旧包、进程缓存与工具禁用 |
| 实际调用 | 原生工具请求/响应成功，带当前会话上下文 | 仅 `tools/list` 不算业务调用 |
| 任务闭环 | Review 入口与需求开发入口分别执行；中断恢复、子出口验收、前置证据失效拒绝 | 计划生成不等于执行成功；根步骤通过不代替子出口验收 |
| 内容隔离 | 相同关键字在另一个 scope 无未授权命中 | 工具挂载通过但权限验收失败 |
| 无 Hook | Host 未加载 Hook 时仍按 Skill 调 MCP 完成上述用例 | Hook 统计不应作为基础能力可用性的前置条件 |

具体 Host 入口：

- **Codex**：本机 `codex mcp --help` 已确认 `list/get`；当前会话工具清单是挂载证据。更新包后在新任务检查 `/mcp` 及实际工具，再调用对应业务工具。不要用 CLI 配置清单替代 Desktop 会话检查。
- **Claude Code**：官方支持 `claude mcp list`、`claude mcp get <name>` 和会话 `/mcp`。命令会对已批准服务做健康检查；若只想检查一个 Craft 服务，应使用精确 `get`，避免无意启动其他服务。CLI 健康状态仍不证明模型使用。[官方 MCP 文档](https://code.claude.com/docs/en/mcp)
- **Cursor**：`agent mcp list-tools craft-experience` 可验证已配置服务的工具面；它本身不会完成任务。当前没有 Craft 配置，不能直接声称这个步骤通过，也不能未经安装步骤跳过失败。正式会话再检查工具调用记录。[官方 CLI MCP 文档](https://prod.cursor.com/docs/cli/mcp)
- **VS Code**：命令面板 `MCP: List Servers` 检查具体服务和日志，再确认聊天内目标工具可用。配置文件、禁用状态、Agent Host 进程有各自作用域，必须在实际使用的会话验证。[官方 MCP 管理文档](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- **Trae / WorkBuddy**：复用仓库 [Host adapter](../technical/modules/host-ecosystem-adapters.md) 与通用安装器；本轮未打开这两个 Host，不把应用存在或 adapter fixture 作为真实会话通过证据。桌面 stdio 与云端 HTTPS 分别验收。

为避免凭空制造证明，不新增接受 `host_session_verified: true` 自报字段便放行的验收器。真实 Host 验收材料应由操作者从对应 Host 的原生会话导出，并与本次 bundle 摘要、scope、输入和结果对应；人工整理的摘要只作为索引，不能替代原始调用记录。

## 交付与仍需外部环境的部分

本地协议测试、配置模板、隔离运行数据、无 Hook 路径都可在源码仓库完成。多 Host 的模型行为验收需要各 Host 已登录并具备可用模型会话；已实际尝试的结果见下节。远程继续交付可部署配置和验收脚本，暂不上线；真实身份系统、TLS、容器运行和目标客户端登录应在对应环境验收。

## 实际 Host 运行结果

2026-09-28 在临时工作区分别复制当前 Experience Skill，使用明确的本地 `node dist/plugin/craft-mcp.cjs --product experience` 配置和独立 `CRAFT_DATA_DIR`。每个进程限制 45 秒，仅请求 readiness 与指定 scenario 的 patterns 查询。没有安装插件或修改全局配置；CLI 自身的会话缓存属于正常运行产物。首轮 Codex/Cursor 因沙箱拒绝写缓存而失败，经工具正常权限审核后重跑，未修改登录或绕过网络限制。

| Host | 实际结果 | 验收范围 |
| --- | --- | --- |
| Codex CLI | 退出码 0，24.10 秒；原生事件显示两次 MCP 调用 completed；`readiness.state=independent_observations_required`、`patterns.observations=[]` | 已证明禁用 Hook 后真实模型会话能发现并调用本地 Experience MCP；未证明新 Invocation 执行闭环 |
| Claude Code | 真实 session 初始化返回 `mcp_servers: pending`，随后 `authentication_failed` / `Not logged in`；退出码 1；API token 与费用均为 0 | 登录阻塞，未发生业务工具调用；不能计为 MCP 挂载通过 |
| Cursor CLI | 权限审核后退出码 1，明确 `Authentication required` | 登录阻塞，未发生业务工具调用 |

Codex 运行使用 `--ignore-user-config --ephemeral --sandbox read-only --disable hooks --disable plugins --disable apps --disable multi_agent --disable multi_agent_v2 --disable memories`，MCP 配置仅通过进程参数传入。Claude 使用 `--strict-mcp-config`、`disableAllHooks=true`、`--permission-mode dontAsk`、只读工具白名单和 `$0.10` 预算；Cursor 使用 `--mode ask --sandbox enabled`。所有测试输入均是合成 scenario，没有读取用户项目正文。

Codex 成功会话 ID：`01a0e3c3-2f34-7033-a6a2-bbd25438ff67`。本轮 bundle SHA-256：`6b229c02e6acef6d315d2ecc3efc8196fe6c1ae88b8c9bc2a3cc6d0a83efc7a1`。该次提示只允许两个 MCP 调用，模型明确没有读取 Skill 文件，因此本次证明标记为 **真实 Host + 无 Hook MCP 调用通过，Skill 使用仍待补证**，不把复制 Skill 等同于使用 Skill。

脱敏原生流与退出状态保存在：

```text
# 首轮三 Host；含 Claude authentication_failed 的原生 session/result 事件。
/var/folders/d4/gddpyrsn1nsgv8f711vhf9hr0000ks/T/craft-real-host-20260928-5u67j1bw/results.json
/var/folders/d4/gddpyrsn1nsgv8f711vhf9hr0000ks/T/craft-real-host-20260928-5u67j1bw/claude/stdout.redacted.log

# 权限审核后的 Codex 成功 / Cursor 登录阻塞。
/var/folders/d4/gddpyrsn1nsgv8f711vhf9hr0000ks/T/craft-real-host-20260928-m6jwiuva/results.json
/var/folders/d4/gddpyrsn1nsgv8f711vhf9hr0000ks/T/craft-real-host-20260928-m6jwiuva/codex/stdout.redacted.log
/var/folders/d4/gddpyrsn1nsgv8f711vhf9hr0000ks/T/craft-real-host-20260928-m6jwiuva/cursor/stderr.redacted.log
```

这些原生日志是工具调用来源证明；临时目录可能被系统清理。本报告只保存证据索引与非敏感摘要，未复制认证材料。Claude/Cursor 需在已有正常登录状态下复验，不能用 Node 协议 fixture 替代未完成的真实会话。

### 最新构建的 Skill + MCP 无 Hook 补证

在主任务重建执行接口后，再进行一次有 45 秒上限的真实 Codex 验收。运行前固定 bundle 副本，SHA-256 为 `fa7952c237abafaa6057bcc42f1328c732e3cf38b5d45ecc2d72ba77fac3b966`。会话 ID 为 `01a0e3c7-37e0-75b3-92a7-467a58038db5`，退出码 0，耗时 41.11 秒，未超时。

原生事件证明：

1. 仅执行一次只读 shell 命令 `sed -n '1,240p' .agents/skills/craft-experience/SKILL.md`，退出码 0，响应包含完整 Skill 内容。模型随后明确应用其“readiness 仅是预检，不能把缺失记录当作存在”的约束。
2. `craft_component_readiness_get(component="experience")` 成功，空数据域状态为 `independent_observations_required`。
3. `craft_procedure_list(scope="project:host-acceptance")` 成功，返回空列表，证明字符串 scope 经真实 Host 的 MCP 参数路径可用。
4. 新工具 `craft_procedure_invocation_get(invocation_id="acceptance-nonexistent", scope="project:host-acceptance")` 返回预期工具错误 `Unknown procedure_invocation: acceptance-nonexistent`。这是有意的缺失记录反例，证明新增工具已经挂载并抵达正确内核；不将它记为一个已执行成功的 Invocation。

该次同样显式禁用 Hook、插件和 Memory 功能，使用独立临时 Craft 数据域；没有创建 observation、Procedure、Invocation 或通过 Gate 的 fixture。现在可以确认 **Codex 真实会话已读取 Experience Skill，并在无 Hook 情况下调用最新 MCP 的日常与 Invocation 查询接口**。它仍不证明全部六个 Invocation 方法的真实任务闭环，也不覆盖 Claude/Cursor 的登录阻塞。

这次运行最初因本地 Skill 内容发送范围不明被自动审核拒绝；完整只读核查确认它是 Git 跟踪的产品分发说明，只有工具名、流程规则和通用路径，没有凭证或业务内容后，对原命令提交具体风险证据重审，获批执行。没有绕过拒绝或修改安全策略，目前没有遗留的审批阻塞。

```text
/var/folders/d4/gddpyrsn1nsgv8f711vhf9hr0000ks/T/craft-real-host-20260928-oou6h9ju/results.json
/var/folders/d4/gddpyrsn1nsgv8f711vhf9hr0000ks/T/craft-real-host-20260928-oou6h9ju/codex/stdout.redacted.log
/var/folders/d4/gddpyrsn1nsgv8f711vhf9hr0000ks/T/craft-real-host-20260928-oou6h9ju/codex/stderr.redacted.log
```
