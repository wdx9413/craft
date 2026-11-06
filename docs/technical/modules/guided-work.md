# Guided Work：从用户目标到受控启动

> 状态：v0.11.45 已实现 Workbench 可见流程。它是普通用户的轻量工作入口，不是新的 Agent、自动规划器或权限绕过通道。

Guided Work 将一次工作收敛为一个可恢复的 Brief：用户提供目标、资料**引用**和必须先回答的决策。Craft 为其建立普通 Task；资料不复制进 Craft 数据库，决策答案只保留脱敏摘要。这样 UI、MCP 与未来自主 Agent 可以共享相同的工作意图，而不会把原始 Prompt、私密资料或一次对话当作事实记录。

```text
Goal + material references + required decisions
                    │
                    ▼
            Guided Work Brief ──creates──> Task
                    │ required answers (digest only)
                    ▼
              ready_to_launch
                    │
                    ▼
 normal Work Launch ──> existing Host approval ──> Host Run / Trial / Outcome
```

`craft_guided_work_create` 对相同 `brief_id` 和相同目标、资料引用、决策定义保持幂等；同 ID 内容变化失败关闭。`craft_guided_work_decide` 只能回答已声明、尚未回答的决策；必要决策全部完成前，`craft_guided_work_launch_prepare` 拒绝创建 Launch。它随后调用普通 Work Launch 协议，因而不会增加文件、网络、工具或宿主权限，也不会替代现有的 Knowledge/Capability-bound Launch。

Brief 与 Task、Work Launch 的精确版本是可追溯血缘。Launch 一旦绑定，Brief 不能再被静默改绑；实际执行、验收与结果仍由既有 Host、Trial、Evidence 与 Outcome 协议记录。

## Workbench 流程

Workbench 的“引导工作”卡片将这条状态机落到普通用户界面：填写目标、逐行给出资料引用、逐行列出必须决定的问题；已保存的 Brief 显示目标、资料数、决策完成数与关联启动的当前结果。每个未回答的必要决策必须由用户逐项确认；只有 `ready_to_launch` 才会出现“用当前启动设置准备”。这个按钮仍然使用同页的 Host、工作目录、Sandbox 与说明，并继续走既有审批，而不是由页面直接启动进程。

本机 Web API 与 MCP 共用同一内核：

- `GET/POST /api/guided-work`
- `GET /api/guided-work/:briefId`
- `POST /api/guided-work/:briefId/decide`
- `POST /api/guided-work/:briefId/launch`

API 仍受 Workbench token、同源检查和 64 KiB JSON 上限保护。资料只保留引用；决策答案只记录摘要，因此界面不会把原始答案作为长期工作记忆显示或转交给宿主。
