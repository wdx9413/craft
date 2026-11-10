# Capability Materialization：能力内容按需落地

## 目标

Hub 搜索只同步轻量元数据。只有用户或规划器选定候选后，Transport Adapter 才把内容交给 Materialization 内核，并写入 `~/.craft_data/cache/hub-packages`。下载完成不等于安装成功，更不等于获得执行权限。

## 阶段

`signed catalog candidate → bounded package → quarantine → review → candidate asset → evaluation/promotion`

- 每包 1–200 个文件；单文件不超过 1 MiB，总包不超过 5 MiB。
- 路径必须是跨平台安全的相对路径，大小写折叠后也不能重复。
- 文件摘要组成规范化 Manifest，其总摘要必须与签名 Hub 目录完全一致。
- 包必须包含 `SKILL.md`、`capability.json` 或 `plugin.json` 描述符。
- 原生二进制和无效 `package.json` 是 Critical，直接拒绝；疑似凭据和 npm lifecycle scripts 是 High，必须经过额外安全审批。
- 文件只进入内容寻址的隔离缓存；数据库不保存正文。
- 审查通过后仅登记 `trust=candidate`、`execution_authority=false` 的 Capability Asset。Candidate Certification 可将其与 held-out Evaluation、逐 Trial Sandbox Receipt、Evidence、program Grade 和 Signoff 绑定，经独立批准后原子晋级 `verified`；真实使用仍需 Capability Planning 与 Autonomy。
- Source 禁用、Entry 撤销或摘要变化都会阻止候选登记。

## 当前边界

当前 MCP 接收 Adapter 已取得的 Base64 文件，不主动联网，也不解压第三方归档，从而避免把压缩炸弹和符号链接交给内核。后续 HTTP Transport 应限制响应体、固定证书/代理策略，并把归档解析放进已验证 Sandbox。当前扫描是确定性基础门禁，不替代恶意代码分析、依赖漏洞数据库或许可证审查。
