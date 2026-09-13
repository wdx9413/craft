# Craft v0.12.3：低 token 默认面与可恢复自主入口

> 状态：已实现并进入发布验收。本文记录本版本真正交付的边界，不把部署依赖误写成产品能力。

## 目标

v0.12.3 收敛两个最影响真实使用的问题：默认接入暴露过多工具，导致上下文和选择成本随能力目录增长；自主运行入口缺少对“进程中断但状态仍为 running”的显式恢复动作。本版把默认能力面改成固定 syscall 路由面，并让宿主与 CLI 对恢复动作失败关闭、可审计。

## 已交付

### 1. 固定 syscall 默认面

- `craft-mcp` 默认使用 `syscall`，当前为 8 个通用动词加 7 个路由/治理直连工具，约 15 个工具。
- `resource + operation` 由既有注册表解析，handler 不复制，保持与具名工具相同的 effect、风险和审批语义。
- `craft-mcp-full` 继续保留，作为明确批准的管理/兼容入口；它不是默认工作面。
- `--surface` 和 `CRAFT_MCP_SURFACE` 仍可选择受支持的 domain/core/full/syscall 面，未知值失败关闭。
- WorkBuddy Connector、WorkBuddy Expert、TraeWork 和本地默认入口统一使用 syscall；Core/Full 配置仍可用于兼容和管理场景。

### 2. 显式 dispatch 恢复

- `craft run --resume <dispatch-id> [--goal <goal>]` 读取已有 task 与 dispatch。
- 已完成或已失败的 dispatch 仍保持幂等，不重复执行。
- `running` 状态必须带 `resume: true` 才允许重放；恢复会记录 `resumed_from` 和恢复时间。
- 恢复使用原任务目标（也允许显式提供同一目标），不会把未知目标或隐式上下文猜测为安全输入。

### 3. 多宿主与文档同步

- 包版本、Codex/Claude 元数据、DeepSeek Harness、WorkBuddy Expert/Connector、TraeWork 说明和测试基线统一到 v0.12.3。
- README、路线图、架构入口和技术模块页明确区分 syscall 默认面、Full 管理面与尚未交付的远程部署能力。
- 新增本计划文档，记录实际范围、非目标和后续收敛项。

## 非目标与诚实边界

本版没有把以下部署级能力伪装成已完成：真实容器/Windows 沙箱适配、远程 A2A transport、生产级 conversation checkpoint、自动 Effect Policy-as-code 编译、真实业务 Eval Runner、云端 MCP 服务、跨团队 OTel 导出、自动技能进化和远程能力市场审核。它们仍可建立在本版 syscall、Task/Receipt、Evidence、Policy 和 internal host 契约之上。

`--resume` 是可审计的有界重放入口，不等于从模型内部 token 状态继续生成；重放前仍需重新观察并接受宿主与策略门禁。这样可以避免把“数据库里仍是 running”误读成模型上下文仍然存在。

## 验收门禁

- `scripts/check-version.ts`：所有当前发布入口与 package 版本一致。
- `scripts/test.ts`：全量测试通过，lines/functions/branches 100%。
- `scripts/plugin-smoke.ts`：插件包能启动，默认 `tools/list` 为 syscall 小面且不暴露 Full 管理操作。
- `scripts/plugin-full-smoke.ts`：Full MCP 仍可发现并调用既有兼容面。
- `pnpm run pack:adapters`：WorkBuddy、TraeWork 和 DeepSeek 产物使用当前 dist，且 manifest、入口和版本一致。
- `git diff --check`：无空白错误；发布前推送提交与版本 tag 到远端。

## v0.12.4 之后的优先顺序

1. 把 dispatch checkpoint 从状态重放提升为可恢复的模型会话摘要，并要求重新观察与 Effect Policy 校验。
2. 提供真实 Eval Runner、业务 Case/held-out 集和能力候选晋级门禁。
3. 以 A2A discovery/transport 和远程 MCP registry 为部署适配层，不扩张默认工具面。
4. 将 Workbench 的目标—资料—决策—结果视图接到同一 Task/Receipt/Evidence 图，而不是另建一套 UI 状态。
