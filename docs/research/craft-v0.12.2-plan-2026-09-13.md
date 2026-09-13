# Craft v0.12.2：可运行产品化大版本

> 目标：让 Craft 不再只是“安装后能发现治理能力”的插件，而是能从插件或 CLI 直接启动一条可审计、可续接、可评测的 Agent 工作闭环。

## 本版已落地的 P0

1. **真实模型传输**：`src/model-gateway.ts` 提供基于平台 `fetch` 的 OpenAI-compatible / Anthropic 传输，带环境变量凭证、超时、有限重试、响应大小上限、JSON 解析和脱敏错误；密钥不写入配置、SQLite、Receipt 或日志。
2. **自主执行入口**：`craft doctor` 检查 Node、配置、存储和凭证；`craft run --goal "..."` 创建 durable Task，使用 Internal Host Driver 运行模型循环，并返回 Dispatch、Receipt、循环预算和最终结果。
3. **默认安全边界**：Internal Host 仍只允许只读/记录型 syscall；模型输出不能直接执行 shell、写文件或发网络请求。需要外部效果时必须走已有 Host/Effect/Approval 路径。
4. **统一版本门禁**：`package.json` 是产品版本唯一来源，`src/service.ts`、Codex/Claude/WorkBuddy/DeepSeek 适配器和 README 由 `version:check` 校验；CI 仍独立固定 Node/pnpm 工具链，不把工具链版本伪装成产品版本。
5. **接入包同步**：WorkBuddy Expert/Connector、Codex、Claude、TraeWork 和 DeepSeek adapter 的版本/发布入口跟随 v0.12.2；Skill 只做路由，MCP 只按需加载，避免把全量工具塞入模型上下文。

## 仍需继续推进的 P1/P2

- 把模型循环的每一步 checkpoint 接入恢复队列，并在进程崩溃后提供 `craft run resume`。
- 将 Effect Policy-as-code 统一挂到 MCP、Internal Host 和所有外部 Host Adapter，补齐命令、路径、域名、凭证租约、幂等和补偿。
- 建立 Suite × Subject × Case × N 的真实 Eval Runner，再开放候选 Workflow/Skill 的 shadow、held-out、Signoff 和回滚。
- 把 Knowledge Context Bundle 的 digest、scope、TTL、Evidence 引用强制绑定到 `craft run` 与最终 Receipt。
- 增加 A2A transport、能力源签名/摘要/健康检查和插件安装回滚；A2A 负责 Agent 间通信，MCP 负责工具/资源连接，Craft 负责路由、效果、证据和评测治理。
- Workbench 先展示“目标—资料—决策—结果”真实运行状态，再扩展多人协作、OTel 导出和桌面 UI。

## 架构决策

Craft 的稳定内核是 `Route → Context Bundle → Effect Policy → Host/Model Driver → Receipt → Eval`。插件是分发层，Skill 是轻量程序/策略层，MCP 是 typed capability transport，A2A 是 agent transport；它们不能互相替代。默认只挂载 route/syscall 面，选中能力后再动态激活，既节省 token，也避免把未经验证的能力直接暴露给模型。

## 使用路径

```text
安装插件/解压专家包
        ↓
craft doctor
        ↓
craft init --mode agent --runtime direct-api ...
        ↓
设置 provider 对应的 API_KEY 环境变量
        ↓
craft run --goal "..."
        ↓
Task → Internal Dispatch → Model/Action Loop → Receipt → Workbench/MCP 查询
```

本版不是把所有垂直行业能力硬编码进核心；行业能力继续以可签名、可评测、可淘汰的资产形式接入。
