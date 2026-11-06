# 桌面统一 AI 任务入口：一手来源核验

调研日期：2026-09-28。问题假设：Craft 要成为操作系统之上的通用任务入口，让用户从正在做的事直接委托任务，而不是先进入按模型和会话组织的聊天工作台。本文仅研究，不是界面方案承诺或实现验收。

证据等级：**官方文档可用**表示厂商已提供使用说明，不等于本机实测；**预览/实验**沿用来源原标注；**厂商宣称**不替代可重复验证；**推断**是本文对 Craft 的建议。所有账号、地区与平台可用性仍需部署时验证。

## 结论

值得组合的不是某一家布局，而是三个互补机制：Raycast 的低打扰唤起与上下文附件、Codex/Claude 的持续任务执行与结果交付、Windows 的任务状态可见性及隔离执行。统一入口必须统一任务身份、上下文、审批和成果；不必把所有应用重建到同一个窗口里。

“全局快捷键”“读取当前应用”“跨应用执行”是三份独立契约。截图不是完整文档，读权限不是写权限，看到任务完成文案也不是外部效果成功的证据。

## 六份核心证据

| 来源与状态 | 已核实的关键事实 | 对 Craft 的启示（推断） |
| --- | --- | --- |
| [OpenAI Appshots](https://learn.chatgpt.com/docs/appshots)，官方文档可用 | 全局热键捕获前台窗口的图像和可访问文本，作为附件进入任务；可选当前/新任务。部分应用只有可见截图，不能取得完整正文。 | 唤起时携带可检查、可移除的上下文卡，注明应用、窗口、时间和采集范围；不要隐式等同全文读取。 |
| [OpenAI Computer Use](https://learn.chatgpt.com/docs/computer-use)，受支持地区及配置限制 | Codex/Work 经插件操作 macOS/Windows 应用；应用授权与 OS 权限分开，文件/命令仍走任务权限。优先专用插件/MCP；Windows 使用前台，macOS 支持限定后台任务；用户可停止或接管。 | 执行路由与入口解耦；结构化集成优先、界面控制兜底；按平台明确“会不会占用你的电脑”。 |
| [Claude Cowork computer use](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)，Pro/Max beta | 顺序优先连接器、浏览器、屏幕操作；首次访问应用请求许可。macOS 15+ 默认后台窗口；桌面控制需要机器醒着、客户端开启，直接操作应用且没有应用间沙箱。 | 把可用执行路径及依赖呈现为任务能力，不让用户先选模型；有权限提示仍不意味着隔离安全。 |
| [Raycast Screen Awareness](https://manual.raycast.com/ai/screen-awareness)，官方文档可用、Pro | 热键从任何位置附带当前窗口；采集文本、选区、焦点控件、截图等可部分成功。附件卡可检查实际包含了什么；浏览器正文需要伴随扩展。 | 上下文应是来源明确、允许降级的结构化输入，不是一个不可见的大截图包。 |
| [Raycast AI Extensions](https://manual.raycast.com/ai/ai-extensions)，官方文档可用、Pro | 可在 Root Search/Quick AI/Chat 调用扩展工具，同一提示可组合多个扩展；执行中显示工具调用，待批准时暂停并展示操作卡，shell 可查看实际命令。 | 同一个任务入口可以覆盖快操作与多步任务；审批应绑定实际动作、目标和参数，而非只有模型生成的解释。 |
| [Windows Copilot Actions rollout](https://blogs.windows.com/windows-insider/2025/11/17/copilot-on-windows-copilot-actions-begins-rolling-out-to-windows-insiders/)，2025-11-17 实验性 Insider 发布说明 | 在与用户交互会话分开的 Agent Workspace 中操作桌面/网页及本地文件；可查看进展与动作、随时接管。来源明确复杂界面可能失败且初期用例有限。 | 长任务可以有独立执行空间，但入口仍可很轻；从少量可验证任务开始，不承诺任意应用稳定自治。 |

微软这一发布说明证明的是当时的 Insider 灰度，而非 2026-09-28 已普遍可用；本次未取得将其提升为 GA 的一手证据。

## 补充核验：交付、入口与同名歧义

- **Codex 命名与入口**：原 `/codex/app/features` 现重定向到 ChatGPT desktop 文档。本会话仍标为 Codex；本文按官方页面明确区分 Codex/Work/ChatGPT，不能把三者快捷键混写。官方命令页单列 Appshots 全局快捷键，Quick chat 标为 ChatGPT-only；不能据此声称 Codex 所有命令都是 OS 全局入口。[Commands](https://learn.chatgpt.com/docs/reference/commands)
- **Claude 成果与持续任务**：当前 Cowork 入门页描述云端隔离执行、任务可持续运行、会话内预览/下载产物、期间可纠偏；访问本地文件、浏览器和电脑仍依赖桌面客户端在线。文档还提示 Chat/Cowork 合并正在逐步推出，不应把旧 UI 分区当固定产品边界。[Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
- **Raycast 结果回到工作处**：Quick AI 可把结果粘贴到原先聚焦的应用，也可携带历史和附件转入完整 AI Chat。因此“轻入口”和“复杂任务视图”可以渐进展开，不必创建两套任务。[Quick AI](https://manual.raycast.com/ai/quick-ai)
- **区分配置名称与执行能力**：Raycast 明确 Agents 是旧 Presets 更名，主要固定角色、模型和工具配置；这个名称本身不能证明后台长任务、独立执行环境或自动恢复能力。[Agents](https://manual.raycast.com/ai/agents) 但当前官方产品页另行明确宣称 Automations 可定时运行重复任务，因此也不能反向断言 Raycast 没有自动任务能力。本次未实测调度、离线行为或失败恢复。[Raycast AI](https://www.raycast.com/core-features/ai)
- **Windows 系统可见性**：2025-11-18 官方材料将 Ask Copilot/taskbar agents 标为 preview，描述任务栏入口、状态标记与悬停进展卡；这是设计参照，不是所有 Windows 用户已有的能力。[Windows at the frontier of work](https://blogs.windows.com/windowsexperience/2025/11/18/ignite-2025-windows-at-the-frontier-of-work/)
- **Muse 尚不下结论**：检索出现 Meta Muse、Agent Muse、Muse Gateway 等同名产品；用户未给链接，不能认定所指对象。Meta 官方[下载页](https://ai.meta.com/muse/download/)与[生产力页](https://ai.meta.com/muse/productivity/)搜索摘要提到 Mac、跨设备委托及浏览器接管，但本次打开没有提取到正文，不纳入已核实能力矩阵。应先确认官网/截图，再研究权限与执行路径，不能把营销描述当实测。

## Craft 应借鉴的产品契约（推断，非已实现）

1. **轻入口承接意图**：全局唤起后首先显示“你要完成什么”与本次引用的窗口/选区/文件；不强迫先选仓库、Provider、Agent 或聊天模式。允许不带当前窗口启动，避免误采敏感内容。
2. **一份任务贯穿大小界面**：简单改写就地交付；多步工作展开为任务详情。收起入口不丢执行，重新唤起能看见需要输入、运行中、可验收的任务。运行状态和业务验收结果分开建模，不以 UI 状态替代既有结果契约。
3. **上下文有边界和新鲜度**：显示来自哪里、包含什么、缺失什么、何时读取；执行前核对当前目标，窗口切换或会话恢复后重新观察。屏幕内容只是证据，不得授予权限。
4. **按效果授权并可接管**：读应用、改文件、提交表单/发送消息分别判断；高影响动作展示实际目标、内容和后果，明确仅本次或持续授权。暂停、取消、人工操作后的恢复不能重复提交。
5. **成果优先于聊天记录**：完成页先给文件、可预览成果、实际改动或外部回执，再给摘要和过程。失败时给最后证实状态与下一步；不能让“已处理”文案替代读取结果、文件断言或接收端证据。

## 不应照抄的边界

- 不复制“中央聊天页 + 左侧所有会话”作为统一入口的定义；任务详情可保留，但不应强迫每次离开当前工作场景。
- 不因为竞争产品支持 Always allow/自动审查，就默认给 Craft 任意应用、凭证或不可逆动作的全权授权。
- 不把所有执行都降为鼠标点击；也不因为接入模型或 Codex CLI，就宣称继承其私有桌面控制、Appshots 或插件宿主能力。
- 不把“后台运行”跨平台一概而论；本机前台控制、后台窗口、隔离桌面、云端任务是不同安全与可用性模型。
- 不从宣传的跨应用示例推导可靠性、无人在场安全性、可恢复性或外部结果正确性。

## 建议后续验证（未执行）

用三条端到端验收取代功能打勾：从选中文本发起并准确回填；从当前业务页面只读取得证据并交付文件；跨两个已授权应用完成草稿、在发送前暂停并支持人工接管。每条同时验证拒绝授权、上下文切换、网络中断与重复提交保护。

本次只新增本研究文件，未安装产品、未调用付费模型、未操作用户应用、未修改生产代码、未提交或推送。依据 research skill 采用独立后台研究及一手引用；OpenAI Docs 仅作为官方资料核验路径。Craft Knowledge 搜索无命中；项目限定 Context Receipt 为 `context_resolution_3df037db8b2c4b349de2a16e568d3c3d`，未返回可复用条目；独立 Experience 工具当前未暴露，不以此声称经验库为空或已经完成经验沉淀。
