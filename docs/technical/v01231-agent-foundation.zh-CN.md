# v0.12.31 Agent 工作底座

## 验收标准

1. 旧 `kefu_llm_wiki` 只读发现，导入默认为 candidate，不复制数据库、MCP、Gate 或原始敏感正文。
2. Knowledge Claim 发布需要独立审核和 bounded/confirmed Evidence；来源变更、撤回和失败均留存 digest 审计记录。
3. Memory 新写入经过 Candidate → Review → Memory Ledger；Ledger 支持 scope、Evidence、TTL、冲突、supersede/revoke/expire，旧表仅兼容读取/绑定。
4. Workflow DAG 在保存前校验节点、依赖、循环、side effect，并可导出/导入带 digest 的 JSON；步骤 checkpoint 漂移时进入 `needs_replan`。
5. Task 状态通过 append-only event 和 projection 统一记录，带 revision、actor、reason、Evidence，并拒绝并发覆盖。
6. Studio、MCP、CLI/Skill 写入只能调用受控 Service/Kernel；Internal Host 持久化会话只保留脱敏摘要和 digest。
7. 本地适配器/失败注入可验证；生产适配器只提供契约，不标记为 production verified。

## 事实源与边界

SQLite `craft.db` 是控制面唯一事实源；Wiki Markdown 与 Workflow JSON 是受控投影，所有导出均带 digest。FTS 可删除后重建，不作为状态事实源。任何写操作都产生版本记录，撤回使用 dispute/revoke/tombstone 而非物理删除。

Memory 分为 `working`（默认 24 小时）、`episodic`（默认 30 天）、`preference` 和 `procedural`。会话结束只接受脱敏摘要与候选引用，不把聊天原文写进长期 Ledger。冲突双方保留，必须人工给出仲裁原因。

Workflow DAG 支持 action、condition、parallel、human_gate、retry、compensation、subworkflow 节点。`draft → candidate → verified → canary → routable` 的后续晋级仍受已有 Evaluation/Signoff/Canary 门禁；本版本的 DAG Kernel 不绕过该门禁。

## 运行验证

- `tests/v01231-agent-foundation.test.ts` 覆盖 Candidate/Conflict/TTL、DAG/Checkpoint/漂移和 Task Event/Projection/并发保护。
- `pnpm typecheck` 验证全量 TypeScript 类型。
- 生产远程 State Adapter、Secret Broker、对象存储、OIDC/JWKS 和分布式 Lease 仅保留契约与本地 conformance，不构成部署证明。
