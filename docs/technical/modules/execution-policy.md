# 沙箱与风险分级执行

## 当前策略与隔离实现

沙箱属于“执行与保障”的核心能力。`Execution Decision` 根据 effect、平台和声明信息返回执行层级；它是策略决定，不是运行环境已经隔离的证明。以下区分代码现状和目标，基线为 v0.10.2；新增预算、等待与 Fallback 协议没有扩大沙箱安全承诺。

| 条件 | 决策 | 含义 |
|---|---|---|
| `read_only` | `host_read_only` | 普通 Host 可自主执行；Windows 完整支持。 |
| 声明为 macOS/Linux 的本地生成代码写入 | `isolated_local` | 决策要求隔离；实际 helper 是否存在由 Adapter 再检查，缺失时抛错而非裸执行。 |
| 外部写入，或未进入上述隔离分支的本地写入 | `approval_required` | Craft 保留状态和审批点，不自主落地副作用。 |
| 无补偿的破坏性 effect，或需要未受信任 Broker 的凭据 | `blocked` | 失败关闭，不能降级成裸执行。 |

`LocalIsolatedAdapter` 当前调用 macOS `sandbox-exec` 或 Linux `bwrap`，检查命令名与工作目录白名单、拒绝显式声明的凭据请求，并配置网络拒绝参数。Windows 没有对应 helper；普通读/规划及审批状态仍可使用。

v0.10.2 新增宿主无关的 Sandbox Adapter Contract。Adapter 先以 `declared` Profile 描述后端类型、文件系统模式、网络模式/白名单、进程隔离、凭据代理、快照、取消和资源上限；声明本身不构成可信能力。只有精确版本的边界探针结果与 Evidence 完全匹配，才能生成新的 `verified` Profile 版本。执行前 `craft_sandbox_plan` 对所有模式、特性和资源需求做失败关闭匹配并签发精确版本 Ticket；`craft_sandbox_receipt` 校验 Adapter 身份、Profile 版本、观察边界和 Evidence，且 passed 回执不允许报告退化边界。

这套 Contract 允许本地进程、Docker、远程 Sandbox 或未来平台后端共享同一控制协议。当前包含有限本地适配与 Docker CLI 驱动，尚未包含 Cloudflare 等远程平台驱动。Profile 被验证只证明所引用 Probe 和 Evidence 观察到了声明边界，不等于获得通用安全认证。

v0.10.2 已加入首个 Docker CLI 驱动。`craft_docker_sandbox_probe` 只接受预装镜像，检查 Docker Server、镜像及加固容器能否启动，只产生诊断 Evidence，**不会验证 Profile**。只有 `craft_docker_sandbox_conformance` 通过禁网、只读根、Workspace 可写、环境无常见 Secret、超时取消和无残留容器的黑盒检查，才会把精确 Profile 推进为 `verified`。Conformance 镜像需提供 POSIX `sh` 及 `touch/ls/tr/env/grep/sleep` 等基础命令；不满足时失败关闭，不能降低检查标准。

执行请求先用 `craft_docker_sandbox_request_digest` 固定镜像与 argv，Ticket 必须保存同一摘要；业务 argv 不经过宿主 shell，并启用 `--network none`、只读根文件系统、`--cap-drop ALL`、`no-new-privileges`、临时 `/tmp`、独立 Workspace 挂载及内存/CPU/PID/超时限制。每次执行使用确定性且隔离的容器名；超时或输出洪泛后强制 `docker rm -f` 并查询残留，清理未证实时任务记为失败。输出有界并做基础 Secret 赋值脱敏，完成后进入统一 Sandbox Receipt。

Docker 驱动不会自动拉取镜像，也不声称 Docker Desktop、Linux Engine 或远程 daemon 在所有平台具有完全相同的内核隔离。Conformance 证明的是当前 Engine、镜像与参数下列出的边界检查通过，并不是渗透测试或平台认证；生产使用仍需固定镜像摘要、守护进程策略、只读镜像供应链和平台级安全验收。

代码检查发现以下尚未完成的保证，不能由 `network: denied` 回执或单元覆盖率替代真实平台验收：

- macOS profile 使用 `allow default`；写入分支没有默认拒绝目录外写入，不能把 workspace 的 allow 规则解释成完整文件写隔离，也未限制全部读取。
- Linux 当前仅构造 `bwrap --unshare-net -- ...`，尚未装配完整文件系统挂载与进程隔离配置；helper 存在不等于命令在目标环境可正常受控运行。
- 普通本地子进程仍可能继承宿主环境变量，因此不得承载凭据任务。受信任 HTTPS Egress Broker 已有首个本地实现：调用方只提交无敏感 Header 的请求，摘要与一次性 Authorization 精确匹配；Broker 在最后一跳读取 `env:` 句柄、钉住经检查的公网 DNS 地址、注入 Header、禁止自动重定向、限制响应并脱敏。它不是通用前向代理；Sandbox 当前通过离线 Inbox 桥接，而不是让容器直接持有网络或 Secret。

## 受信任 Egress Broker

`craft_egress_request_digest → craft_egress_authorize → craft_egress_execute` 构成三阶段协议。执行前再次检查 Credential Handle、短期 Lease、精确 URL 和请求摘要；Authorization 只消费一次。请求开始前先持久化 `pending`，网络结果不确定时标记 `indeterminate` 并禁止自动重试，避免 POST 等写操作重复发生。数据库只保存请求/响应摘要、HTTP 状态、解析地址摘要和 Evidence，不保存 Secret、请求正文或响应正文。

本地 Adapter 只允许 HTTPS 和有限 Method，拒绝调用方提供 Authorization、Cookie、Proxy Authorization 或 API Key Header；所有 DNS 答案必须是公网地址，并把选定地址传给 TLS 连接的 lookup 回调，Host/SNI 仍保持原域名。3xx 不跟随，防止授权跨 Host 漂移。

`craft_sandbox_egress_deliver` 将已签发且仍活动的 Sandbox Ticket、同 Task 的一次性 Egress Authorization 和安全 JSON 文件名绑定。Sandbox Profile 必须保持 `network=denied` 且使用 `workspace_overlay`；Broker 在宿主侧完成请求后，将脱敏响应封装成 `trust=untrusted_external_response`、`execution_authority=false` 的 JSON，只写入该 Ticket 哈希隔离的 `~/.craft_data/runtime/sandbox-inbox`。绑定先持久化为 pending；文件写入或请求结果不明时进入 indeterminate，不能自动重放。当前仍缺少企业代理、证书策略、DNS 策略扩展、流式大对象及响应内容类型解析；Inbox 文件进入规划上下文前仍须走不可信内容提取和审查。
- 命令/工作目录校验不等于命令全部文件访问受限；超时、输出上限、进程树取消和 CPU/内存/磁盘限制需要执行后端与集成测试补齐。

因此当前定位是隔离适配雏形，不能宣传为完整安全沙箱。依据：[策略](../../../src/execution-policy.ts)、[本地适配器](../../../src/isolated.ts)。

## 目标：分级执行后端

| 能力 | 设计要求 |
| --- | --- |
| 文件与进程 | 显式读写根、路径与链接边界、隔离工作区、受控子进程；真实攻击/越界用例验收 |
| 网络与凭据 | 默认拒绝或显式出口策略；代理网关控制域名/动作，短期最小权限凭据不进入模型上下文或日志 |
| 资源与取消 | 时长、并发、费用与资源上限；取消阻止后续派发并处理在途操作，不宣称已撤销发生过的副作用 |
| 后端适配 | 本地 OS、容器或远程执行器声明具体能力；Windows/macOS/Linux 采用相同契约，不强求同一种实现 |
| 证明边界 | 分别记录后端观察、Host 报告和独立检查；没有后端强制执行证据时不能提升保证等级 |

普通受信任只读工具不必启动沙箱；运行未知生成代码时，即使声明只读，也应根据实际执行权限选择隔离后端。审批表达授权，不修复隔离缺失。不要默认在同一动作外嵌套多个沙箱；按后端可验证能力选择。

## Shadow、快照与补偿

- 模拟/预览只能在支持的 Adapter 中运行，需记录模型、工具、模拟器及外部数据版本；模拟通过不证明真实调用成功。
- 当前只读 baseline/candidate Shadow Experiment 是评测对照，不是拦截全部 API 的虚拟环境。
- 文件恢复限于声明的快照范围；自有数据库可以设计事务或专用快照 Adapter，当前未实现通用数据库恢复。
- 外部 Saga 是补偿而非跨系统 ACID 回滚；可能失败、部分完成或需人工处理。发信、发布、付款等不能承诺无损撤销。
- 代理只控制经过它且无法绕行的流量；覆盖范围之外的宿主动作不能冒充已受 Craft 保护。

## 验收与优先级

首先补齐目录外读写、环境密钥、网络出口、子进程、取消/超时和资源上限的真实后端测试；任何不满足所需保证的后端都不能承载对应的自主动作。随后接入模拟、提交前重检与特定外部系统补偿。Windows 未接入等价后端前，明确展示缺失能力及可选执行位置。

关联：[Closed-loop Runtime](closed-loop-runtime.md) · [Runtime 与宿主接入](runtime-integration.md) · [事务与编译](transactional-runtime.md) · [共享工作空间](agent-native-workspace.md)
