# 四组件无 Hook 与多宿主接入：实施记录

日期：2026-09-27。基于[研究报告](craft-components-hookless-review-2026-09-27.md)实施。用户确认远程部分交付“可部署配置与验收脚本，暂不上线”。仓库开始时已有大量未提交变更；本次未提交、推送或修改实际宿主安装配置。

## 实施与证据

| 研究项 | 本轮实现/沿用能力 | 验收 |
|---|---|---|
| P0：独立工具缺口 | K packet、M gate/scope/revoke、E resolve/gate/scope、Codebase workspace/bootstrap/refresh | `component-hookless.test.ts`，真实 stdio conformance |
| P0：Schema/Host 漂移 | per-tool overrides、daily MCP 边界验证，数组/布尔/成员参数一致，支持有界 Host 标识 | 类型检查、strict MCP 反例、插件/协议回归 |
| P0：作用域与组件隔离 | search 默认 reviewed + scope；候选诊断显式；挂载产品绑定 Context member | 跨 scope、候选、失效、成员越界测试 |
| P0：错误验证证据 | Hook verifier 最后结果、编辑使旧验证失效、严格 turn identity、bounded 证据；显式 verification receipt 记录时间/revision/contract/producer/digest | 非测试命令、失败后重跑、编辑后失效、缺 turn、矛盾 receipt 测试 |
| P1：Knowledge 检索与 freshness | 共用中文/标识符词项；审阅绑定 source digest；保留 source revision ingestion 的 stale 规则 | 真实 ingest → packet → Host review → search → 修改源 → 排除 |
| P1：Memory 解释/反馈/并发 | receipt 解释召回阶段计数；统一 exact-receipt feedback；撤销使用现有 store CAS | stale expected_version、重复撤销、反馈隔离、scope/TTL 测试 |
| P1：Experience 评估/回退 | 保留既有 baseline/evaluation 内核和有序门禁；补显式验证契约、scoped recall；canary 失败停止路由 | 真实 MCP candidate → 四阶段 gate → recall → canary failure → 不再召回 |
| P1：Codebase 可插拔与 freshness | normalized import、LSP DocumentSymbol 转换器、文件 digest/span/预算校验、changed-path checkpoint refresh | Java/Python/Go fixtures、UTF-16/CRLF、越界/错 digest/stale；完整 Codebase 覆盖门禁 |
| P1：总预算/诊断/兼容测试 | 聚合成员共用预算；readiness 暴露验证等级；真实 stdio conformance 输出 artifact digest | oversized contributor 反例、4 个产品隔离流程 |
| P2：多宿主与标准分发 | 原有安装器增加 5 适配，共 10 个；config dialect、真实调用探针、每目标回滚；pack 生成 root plugin.json/mcp.json | 安装器 fixture、子进程错误/超时/错误 schema、源码/marketplace/common-use 同步校验 |
| P2：远程模板 | HTTPS + introspection seam + 服务端固定租户路由 + 独立数据目录；Compose/Dockerfile/验收脚本 | 本机 HTTPS/CLI 启停、匿名/错误身份拒绝、跨租户相同 scope 隔离 |

产品使用说明：[hookless-components](../technical/modules/hookless-components.md)。远程交付：[部署说明](../../deploy/components/README.md)。标准 portable 核心与 common-use 不要求宿主 Hook；原生 Codex/Claude 兼容 manifests 保留可选 Hook。服务器内部 HookPlane 未移除。

## 运行证据

- 受影响 Runtime/远程测试：134 tests，134 pass。
- 协议/插件补充回归：25 tests，25 pass（与上一组存在部分重叠，不相加宣称独立用例总数）。
- 安装器测试：6 tests，6 pass，涵盖 10 个配置方言、探针与回滚。
- Codebase 整模块门禁：行/分支/函数均 100%。
- 按本轮编辑前工作树快照计算，Runtime + 远程实现增量：377/377 行、331/331 分支。安装器增量：127/127 行、103/103 分支。此口径不把其他并行任务的改动计入本轮，也不等同全仓覆盖率。
- 安装器成功、返回失败和抛异常三条路径均已测试。清理后统一返回结果，最终增量行/分支均为 100%。
- `tsc --noEmit`、layer audit、surface audit、plugin package check、4 个组件打包 smoke、`git diff --check` 已通过。
- 真实 stdio conformance 共 55 次工具调用：Knowledge 17、Memory 9、Experience 21、Codebase 8。证据包括 exact review packet、候选隔离、记忆撤销、经验回退和代码刷新；输出明确 `host_session_verified:false`。

完整构建产物/coverage 证据保存在本地测试输出；源代码版本未单独递增，产物应以 conformance 输出的 SHA-256 与 release.json 比较，不能仅靠版本号判断当前客户端是否已加载新包。

## 明确边界

1. 未在全部 10 个真实编程工具内逐一验收。这里只能确认适配配置、MCP 子进程和 fixture 工作流，不能声称宿主授权/当前会话挂载全部成功。
2. 多语言入口与 LSP 符号转换已实现，没有捆绑所有语言服务器或 SCIP protobuf 解析器。调用关系由受信任分析器导出；内置 TS/JS regex 仍标为 heuristic/partial。
3. `verification`、Hook observation 和反馈不自动升级为独立事实。真实模型效果对比仍需固定 Host/model/checkpoint/budget 运行既有评测系统，未声称成功率提升。
4. remote 模板把租户定义为共同信任的数据空间，未实现租户内部逐用户 ACL 或交互 OAuth 登录。真实身份服务需按其 introspection 响应接入。
5. Docker 守护进程不可用，未构建容器；真实 IdP 和远程客户端未接入、未上线。本机 HTTPS/租户测试不替代这些验收。
6. 支持 MCP 2025-03-26/06-18/11-25；未在本轮扩大到 2026-07-28 协议实现。没有以未来协议支持作为 Skill + tools 基线的依赖。

全仓 coverage inventory 额外检查仍显示已有大量未纳管文件；本轮新增的 LSP 与 retrieval-terms 已纳入各自门禁。这项全仓治理债务与本轮增量覆盖是不同结论，未把它报为通过。

当前对话结束时实际调用 Memory scoped resolve，receipt `context_resolution_3867ef3efed24989b1a0cd34c92722fa`。Knowledge/Experience MCP 仍未挂载，按已加载 Skill 使用不可用回退；没有把 readiness 或 fixture 测试当作真实组件写入，没有写长期记忆。当前宿主缓存尚未更新为本轮产物。
