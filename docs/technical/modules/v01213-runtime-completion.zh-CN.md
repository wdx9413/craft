# v0.12.13 Runtime Completion

> 状态：本地内核已实现并有单元测试；外部 OS 服务、云端 Provider、远程 Registry、A2A 身份和生产沙箱仍须部署 Adapter 证明。

v0.12.13 把 v0.12.12 的 Verified Autonomous Work 从“可记录动作”推进到“有边界的本地动作执行与独立验收”。

## 已实现

- `ActionGatewayKernel`：仅允许声明工作区内的读写；路径逃逸失败关闭；写入要求 `local_write` 和显式 approval；Shell、浏览器、MCP 远程调用明确要求外部 Adapter。
- `AcceptanceGateKernel`：Host 完成不能直接形成成功 Outcome；只有带 Artifact 和 Evidence 的独立 Acceptance Gate 才能创建 verified Outcome。
- `DurableWorkerKernel`：Worker 状态、Job lease、bounded tick 和过期 lease recovery 可持久化；进程托管和桌面通知仍由 OS Adapter 负责。
- `ProviderRouterKernel`：保存首选 Provider、fallback 顺序、预算摘要和实际使用回执；具体协议、流式传输和密钥仍由 Model/Host Adapter 负责。
- `A2AProtocolKernel`：提供摘要化 `message/send`、`message/stream`、`tasks/list` 入口；不保存远端原始内容，也不自动授予远程执行权。
- CLI `run`：创建 Context Manifest、Verified Work 和 Acceptance Gate；Host 成功后进入 `needs_review`，不会直接写入 passed Outcome。

## 边界

这不是 OS 级沙箱、完整远程 Worker、A2A 生产身份系统或官方 MCP Registry 服务。生产部署必须额外提供隔离、Secret Broker、OAuth、远程对象存储、通知和回执证据。

## 验收主链

```text
Goal → Context Manifest → Model/Host
     → Action Gateway → Receipt → Reobserve
     → Acceptance Gate → Delivery → Outcome → Trace
```

旧版本记录仍可读取；未通过 Gate 的 Host 结果只能作为 bounded Evidence 或 needs-review 状态存在。
