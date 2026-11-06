# 分级自主权与审批控制面

Craft 将“Agent 能不能做某个动作”表示为可版本化、可审计、一次性消费的授权，而不是散落在 Prompt 或 Host UI 中的布尔开关。

## 四个等级

| 等级 | 含义 |
| --- | --- |
| `automatic` | 在精确 Policy、任务、动作、目标和请求摘要范围内自动执行 |
| `notify_only` | 可以执行，但消费授权前必须留下通知引用 |
| `human_approval` | 一名不同于执行过程的明确身份批准后执行 |
| `multi_sig` | 达到 Policy 声明的多人批准数后执行；任一拒绝即终止 |

动作分为读取、草稿、沙箱写入、外部写入、通信、Computer Use、破坏性和金融操作。破坏性与金融操作不能配置为自动或仅通知。

## 授权生命周期

```text
Versioned Policy
      ↓ exact task/action rule
Authorization Request ──pending──> Human Decision(s)
      │ automatic/notify                 │ quorum or deny
      └──────────────> Authorized <──────┘
                              ↓ exact match + TTL + idempotency
                         Consumed once
```

请求绑定 Policy 精确版本、Task、Action、Target 和 `sha256` 请求摘要，并带有效期。消费时逐字段复核；同一授权只能生成一条 Consumption，安全重试必须复用同一个幂等键。`notify_only` 还必须提交实际通知引用。

## 当前边界

当前版本提供 TypeScript Kernel、持久记录和完整 MCP 接口，可供 Codex、Claude、独立 CLI 或其他 Host 使用。Task 一旦配置唯一有效的 Autonomy Policy，External Effect 在进入 `executing` 前会把精确授权消费与 Effect 状态变化放进同一个 SQLite 事务；缺失授权、旧 Policy、错任务、错动作、错目标、错摘要和重复消费均失败关闭。未配置 Policy 的旧任务保持兼容。

Runtime Operation 也在创建时固定 `autonomy_action`、授权目标和请求摘要；`computer_use` 是独立于 `agent/workflow/grader` 的一等 Operation Kind。Task 配置 Policy 后，Runtime/Host Adapter 派发会在同一事务中消费授权并签发 Lease，未声明动作等同禁止。子 Operation 和诊断 Sub-agent 使用相同身份规则，不能从父任务旁路门禁。

当前 Computer Use 只建立跨 Host 的动作、授权和回执契约，尚未内置浏览器/桌面视觉驱动，也不宣称可以可靠处理验证码或任意 GUI。生产身份与页面实际状态仍须由 Adapter 证明。

审批记录不是身份认证本身。生产部署仍需由 Host/网关把 `actor` 绑定到可信登录身份，并负责组织角色、多人联签独立性和通知送达证明。
