# Capability Kit Runtime

## 目的

Capability Kit Runtime 负责治理“什么能力可以被安装、在哪个任务中被激活、以何种外部形态展示、何时必须失效”。它只扩展可变供给面，不允许扩展绕开 Craft 的事实与权限内核。

稳定内核仍然是 `Task / State / Policy / Receipt / Evidence / Outcome / Eval Gate`。Kit 不能直接写这些对象、不能读取或保存凭据、不能在安装时执行第三方代码，也不能把声明的 Hook 当成执行授权。

```text
Manifest -> Registry -> Conformance -> Task Activation
                                      |
                         bounded phase Contribution
                                      |
                         Skill / MCP / CLI / Plugin descriptor
```

## Manifest 与生命周期

每个 Manifest 固定 `id`、语义版本、Craft 兼容版本、精确依赖版本、提供能力、effect、数据范围、入口、允许参与的阶段、健康检查、评测套件和展示面。敏感字段或不支持的阶段会被拒绝。

生命周期为：`installed -> disabled | revoked`。依赖必须指向已安装的精确 Manifest 版本；停用或撤销会让自身及依赖 Kit 的活动记录进入 `needs_replan`。同一 Kit ID 与 Manifest 版本出现不同摘要会失败关闭。

Conformance 只检验 Manifest、依赖、Hook 与危险 effect 的机制一致性。通过结果是“本地供给机制可用”，不是业务质量、Host 真实执行、生产沙箱或组织审核证明。

## Hook 不是任意回调

Kit 只能声明并记录以下协议阶段的摘要化提议或回执：意图补充、澄清建议、计划建议、激活解析、预检、Adapter 执行、状态观察、验收、埋点和学习候选。Contribution 仅存提议摘要、键名和 Evidence 引用；原始业务内容和凭据不会写入 Craft。

`execute.adapter` 仍由已有 Host / Runtime Adapter、授权、Receipt 与再观察链负责。Kit 的 Activation 不会签发 `call_id`、凭据或写入权。

## 外部呈现与 MCP

一个 Kit 可声明 `skill`、`mcp`、`cli`、`plugin` 四种展示面，所有展示都返回同一 Kit ID、版本和 Manifest 摘要。默认 `craft-mcp` 仅支持读取 Kit、列举 Kit 和查看分发描述；`craft-mcp-full` 才公开安装、内置样例安装、激活、贡献、Conformance 和撤销。

CLI 提供：

```text
craft kit list
craft kit install-builtins
craft kit describe <kit-id>
craft kit conformance <kit-id>
```

## 内置样例与边界

`builtin.serena-project-knowledge` 声明受信任项目知识的发现/解析能力；`builtin.local-workspace` 声明文件与代码工作区的观察、预检和验收能力。它们只验证 Kit 生命周期和分发机制：Serena 的 LSP/记忆维护、真实 Host 调用、文件写入以及隔离仍分别属于既有 Adapter、Policy 和 Runtime 边界。

不做自动市场安装、自动执行模型生成脚本、默认多 Agent、远端 A2A 调度或把 Kit Conformance 误作质量 Gate。后续远端 Registry、签名发布和组织级审核必须接入同一 Manifest、生命周期和证据模型，而不是新增绕过路径。

## 验证

`tests/v01218-capability-platform.test.ts` 覆盖 Manifest/依赖、Conformance、Task Activation、阶段越权、贡献脱敏、禁用/撤销传播、Core/Full MCP 分面与 CLI。该测试使用脱敏本地 fixture，只证明机制正确；真实业务价值仍需通过现有 Campaign、Signoff 与 Canary 评测。
