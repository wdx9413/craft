# N1 验收报告

> as_of: 2026-09-12
> 代码基线: v0.11.62（工作树，未 bump）
> 验收标准来源: `docs/research/industry-agent-runtime-next-2026-09-11.md:109`
> 驱动脚本: `.workbuddy-ai/tools/n1-acceptance.mjs`（可重跑）
> 原始证据: `.workbuddy-ai/n1-verify/evidence.json`

## 结论

**N1 六项验收标准全部通过：40/40 断言，0 失败。** 结论基于 Craft 的**真实入口**——打包后的 MCP server（`dist/plugin/craft-mcp-full.cjs`）与 CLI 维护 worker（`dist/src/cli.js worker tick`）——而非进程内直接调 service。

验收过程中发现并修复了 **2 个真实缺陷**（回执与观测脱钩、人工原因被覆盖），均补测试、覆盖率门禁仍为 100%/100%/100%。

**但必须如实标注两条边界**（详见 §5）：

1. Host 二进制是**替身**（`codex.exe` = node.exe 副本 + `exec` 入口脚本），不是真实 Codex CLI。Craft 侧的 spawn、JSONL 解析、receipt 落盘、失败归因走的是**真实代码路径**；被替掉的是"模型真的干活"这一段。
2. "视频/文件任务"只验证了 `file_artifact` 确定性判据机制，**没有跑真实视频任务**（本机无 ffprobe、不生成视频）。

所以准确表述是：**N1 的治理机制已完整验收；N1 的端到端真实生产力仍未验收。**

---

## 一、验收环境

| 项 | 值 |
| --- | --- |
| 数据目录（隔离） | `.workbuddy-ai/n1-verify/data`（`CRAFT_DATA_DIR`） |
| 工作区 A | `.workbuddy-ai/n1-verify/ws`，`include_paths = [note.txt, out.txt]` |
| 工作区 B | `.workbuddy-ai/n1-verify/ws2`，`include_paths = [note.txt]` |
| Host 替身 | `.workbuddy-ai/n1-verify/bin/codex.exe`（node.exe 副本，84 MB）+ 工作区内 `exec` 入口脚本 |
| MCP 入口 | `dist/plugin/craft-mcp-full.cjs`（485 工具） |
| CLI 入口 | `dist/src/cli.js worker tick` |
| 运行环境 | Windows 10 + Node 22.22.2（本机 `engines >= 23` 未满足，CI 用 24） |

**替身工作原理**：`spawn("codex", ["exec","--json",...,"--cd",<ws>,"-"])` 时，Node 把第一个非选项参数当主模块解析，所以工作区里的 `exec` 文件被执行。它按 `src/codex-driver.ts` 期望的 JSONL 形状输出，并按 `N1_CODEX_MODE` 分三种行为：`ok`（写成果 + exit 0）、`slow`（先睡 8s，用于让漂移落在执行中）、`fail`（只写 stderr + exit 1）。

> 说明：Node 22 的 `spawn(shell:false)` 拒绝 `.cmd`/`.bat`（CVE-2024-27980 后的行为，显式路径报 `EINVAL`、走 PATH 报 `ENOENT`），因此替身必须是真正的 `.exe`。跨卷（C: → D:）无法建硬链接，`fs.linkSync` 报 `EXDEV`，只能复制。

---

## 二、逐项验收

### 验收 1：研发任务闭环 —— 机制链路 ✅

| 断言 | 观测值 |
| --- | --- |
| prepare 建立 loop + launch + host_run | `work_launch_724ff27b…` / `host_run_f6d3d9cb…` |
| 刚 launch 时**不得**判为交付完成 | `status=running`，`action=wait_for_host` |
| Host 真实执行并产出 completed receipt | `status=completed`，`event_count=1`，`receipt_codex_dispatch_work_launch_724ff27b…` |
| 宿主确实写入了声明的文件成果 | `out.txt = "n1 artifact\n"` |
| **Host 成功 ≠ 交付完成** | 进入 `status=awaiting_acceptance`，`action=collect_acceptance` |
| 验收通过后才推进 | `status=ready_for_delivery`，`action=deliver` |

**最关键的一条**是第 5 行：Host 退出码 0、receipt 落盘之后，Craft 并没有把它当交付完成，而是卡在 `awaiting_acceptance` 等程序判据。这正是 N1 原文"不得把进程完成当交付完成"的字面要求。

### 验收 2：文件成果的确定性验收 ✅（机制）/ ⚠️（域内）

| 断言 | 观测值 |
| --- | --- |
| 内建 file-artifact 判据生成 job | `acceptance_job_acceptance_work_launch_724ff27b…_artifact` |
| 未租约不得直接提交回执 | 拒绝：`Acceptance evaluation lease does not match` |
| CLI `worker tick` 退出码 0 | `status=0` |
| 内建适配器实际租到并回报 | `claimed=1`，`reports=1` |
| 判据结论 passed 且回执含真实 sha256 | `result=passed`，`evidence_acceptance_job_…` |
| 计划级评估 passed 且记录 Outcome | `assessment=passed`，`verdict=passed` |
| 判据携带证据而非模型结论 | `checks=1`，`evidence_ids` 非空 |

判据执行走的是产品自身的 `runBuiltinAcceptanceTicks` → `evaluateFileArtifact`：真读文件、真算 sha256、真比 `expected_sha256`。**没有任何模型参与判断。**

> ⚠️ 视频域（`builtin.video-delivery` / `media_probe`）用的是同一条机制，但本机无 ffprobe、也不生成视频，**未跑真实视频任务**。

### 验收 3：Host 中断 / 不可用 ✅

| 断言 | 观测值 |
| --- | --- |
| 宿主进程失败被如实记为 failed | `status=failed` |
| 失败进入 recovery，**绝不** ready_for_delivery | `status=recovery`，`action=retry_or_handoff` |
| 回执链中从未出现交付完成态 | `statuses=["recovery"]` |
| 交付观测为 host_failed | `status=host_failed` |
| 未确认原 runner 停止时**拒绝**回收 | 拒绝：`Recovery requires confirmed_original_runner_stopped=true` |
| 确认后可回收为 **interrupted**（而非 completed） | `count=2`，`statuses=interrupted,interrupted` |
| 回收后 loop 仍为 needs_replan | `lifecycle=needs_replan` |

`host_run_recover` 的两段式设计（必须显式确认原 runner 已停止）在这里得到正向验证：Craft 不会因为进程"看起来结束了"就替它下结论。

### 验收 4：输入漂移 ✅

| 断言 | 观测值 |
| --- | --- |
| 宿主执行中状态为 running | `status=running` |
| 工作区在宿主终结前变化 → needs_replan | `status=needs_replan`，`reason=workspace_changed_without_terminal_receipt` |
| 漂移后 resume 被拒绝 | `Verified Work Loop requires a fresh prepare after input or workspace drift` |
| 环境输入漂移 → needs_replan | `status=needs_replan`，`reason=task_run_drift` |
| 环境漂移后 resume 被拒绝 | 同上 |

两类漂移都覆盖：**工作区内容漂移**（宿主还在跑，输入被改）与**契约输入漂移**（environment/budget 摘要变化）。两者都拒绝复用旧事实，都要求重新 prepare。

### 验收 5：人工修改 ✅

| 断言 | 观测值 |
| --- | --- |
| 记为 workspace_change + HumanStateEvent | `workspace_change_7cdaed89…` / `human_state_event_work_loop_decision_n1-human-change_…` |
| 生成 work_loop_invalidation | `status=needs_replan`，`reason=human_state_event` |
| loop lifecycle 转 needs_replan 且**保留人工原因** | `reason=human_change` |
| 人工修改后 resume 被拒绝 | 要求重新 prepare |

### 验收 6：审批门禁与审批过期 ✅

| 断言 | 观测值 |
| --- | --- |
| `workspace-write` 被扣在 awaiting_approval | `status=awaiting_approval`，`approval_required=true` |
| **未审批前没有启动任何 Host 进程** | `run_id=undefined` |
| 门禁态为 awaiting_approval / review_work_launch / human | 一致 |
| 过期审批被拒绝 | `Autonomy request expired` |
| 过期授权不可被消费 | `Autonomy authorization expired` |
| 过期授权未被消耗，仍可用于合法复核 | `status=authorized` |
| 显式审批后才启动 Host 并绑定授权 | `started=true`，`authorization=launch_authorization_work_launch_99eb8ee9…` |

"未审批前 `run_id=undefined`"是这一项的核心：写入型任务的授权不是文档承诺，而是**代码里 Host 根本没被拉起**。

---

## 三、验收中发现并修复的缺陷

### D1（严重）：回执与观测脱钩 —— 审计链会说谎

**现象**：`craft_verified_work_loop_advance` 第二次调用返回了**第一次的旧回执**。

**根因**（`src/verified-work-loop.ts:30` 旧代码）：

```ts
const receiptId = `work_loop_receipt_${saved.id}_${snapshot.version}_${state.version}`;
```

回执 ID 用**记录版本号**做身份。但版本号在多次观测间会重复：新建的 `state_snapshot` 记录版本总是 1，而 `task_run_state` 在内容未变时走幂等路径也保持版本 1。于是两次**不同**的观测算出同一个回执 ID，第二次直接 `find` 到旧回执返回。

**实测证据**（漂移场景）：

```text
LOOP lifecycle=needs_replan reason=workspace_changed_without_terminal_receipt
     latest_snap=state_snapshot_n1-ws2_1ad4b22ea48ea933
receipts: work_loop_receipt_n1-drift-ws_1_1
          {status:"running", reason:null,
           snap:"state_snapshot_n1-ws2_ddae77abc7891c87"}
```

loop 已经是 `needs_replan`、最新快照是 `…1ad4b22e…`，而**唯一的回执**却说 `running`、且指向**另一个**快照 `…ddae77ab…`。**审计链既不覆盖最新快照，也不反映终态。**

**影响**：回执是 N1"可验证"承诺的载体。回执与观测脱钩，意味着任何读回执链的宿主/审计者都可能拿到与 loop 实际状态相矛盾的记录。

**修复**：回执默认 ID 改为由**观测本身**内容寻址：

```ts
const observation = { task_run_state_id: state.id, snapshot_id: snapshot.id, status, reason };
const receiptId = `work_loop_receipt_${saved.id}_${digest(observation).slice(-16)}`;
```

- 同一观测重放 → 同一 ID → 保持幂等；
- 新快照 / 新状态 / 新原因 → 必然新 ID → **不可能**复用旧回执。

### D2（轻）：人工修改的原因被覆盖

**现象**：`decide(human_change)` 明确写入 `needs_replan_reason = "human_change"`，但紧接着的内部 `advance` 又把它覆盖成 `workspace_changed_without_terminal_receipt`。

**根因**：`advance` 无条件重算原因，而 `human_change` 必然伴随工作区变化，所以 `human_change` 这个原因**在实践中永远无法保留**——作者显式写入它的意图被完全抵消。

**修复**：把"已处于 needs_replan"视为**首个原因优先**：

```ts
const priorReason = loop.lifecycle === "needs_replan" ? String(loop.needs_replan_reason) : null;
const reason = status === "needs_replan"
  ? (priorReason ?? (changed ? "workspace_changed_without_terminal_receipt" : "task_run_drift"))
  : null;
```

人工/显式决策是更具体、更可归因的原因，不应被派生原因覆盖。

### 修复的验证

| 项 | 结果 |
| --- | --- |
| 新增测试 | `tests/verified-work-loop.test.ts` +1（回执绑定观测 + 原因优先） |
| 全量测试 | **342/342 通过**（原 341） |
| 覆盖率门禁 | lines / functions / branches **均 100.00**，未新增任何 ignore 指令 |
| `tsc -p tsconfig.build.json` | exit 0 |
| N1 验收重跑 | **40/40 通过**（D1、D2 对应断言由 FAIL 转 PASS） |

---

## 四、可复现

```bash
# 1. 编译 + 打包
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node node_modules/esbuild/bin/esbuild bin/craft-mcp.ts --bundle --platform=node --format=cjs --target=node23 --outfile=dist/plugin/craft-mcp.cjs
node node_modules/esbuild/bin/esbuild bin/craft-mcp-full.ts --bundle --platform=node --format=cjs --target=node23 --outfile=dist/plugin/craft-mcp-full.cjs

# 2. 跑 N1 验收（自动重建隔离数据目录与工作区）
node .workbuddy-ai/tools/n1-acceptance.mjs
# 期望输出: === N1 acceptance: 40/40 passed ===
```

脚本自带 6 个场景（研发闭环 / Host 失败 / 漂移与中断 / 人工修改 / 审批门禁），每个场景一个独立的 MCP 进程，env 随场景切换（`ok` / `fail` / `slow`）。

---

## 五、诚实边界（未验证风险）

1. **Host 是替身，不是真实 Codex CLI。** Craft 侧代码路径（`executeCodex` 的 spawn、argv、JSONL 解析、`invalid_jsonl_lines` 判定、receipt 落盘、`exitCode !== 0 → failed`）全部真实执行；被替换的是"模型真的干活"这一段。**真实 Codex CLI 的 JSONL 事件形状是否与本替身一致，未验证。**
2. **没有真实研发任务。** 验收 1 用的是"写一个 out.txt"的最小任务，验证的是**机制闭环**，不是"能不能真做出一个产品功能"。
3. **视频域未跑真实任务。** 只验证了 `file_artifact` 判据机制（`builtin.video-delivery` / `media_probe` 复用同一条链路），本机无 ffprobe、不生成视频。
4. **仅在 Node 22.22.2 验证。** 项目 `engines >= 23`，CI 用 24，未在 CI 上跑。
5. **未验证并发。** 每个场景单进程串行；多 Host 并发写同一 workspace 的行为未覆盖。
6. **84 MB 磁盘占用**（Host 替身）。跨卷无法硬链接，只能复制。
7. **版本号未 bump。** 代码仍是 `0.11.62`；bump 是发布动作，涉及约 45 处，建议与 commit 一并执行。

---

## 六、N1 之后

按 `industry-agent-runtime-next-2026-09-11.md:152` 的顺序，**N1 完成后的下一步是 N2（真实 Eval）**。

但需要老板先拍一个前提：**N1 现在验的是机制，不是生产力。** 要让 N1 从"机制验收"走到"生产力验收"，必须解决真实 Host 接入——而本机没有 Codex CLI / Claude Code，也没有网络装不了。可选的路径：

| 选项 | 代价 | 得到什么 |
| --- | --- | --- |
| 先做 N2（真实 Eval） | 无需真实 Host，可本机做 | held-out 评测闭环，但仍不证明生产力 |
| 先接真实 Host | 需要网络 + 安装 Codex CLI | N1 端到端真实性 |
| 先收窄工具面落地（把 v0.11.63 的 `--surface` 挂进 `mcp.json`） | 一次配置变更 | 立刻降低每次会话固定成本 |
