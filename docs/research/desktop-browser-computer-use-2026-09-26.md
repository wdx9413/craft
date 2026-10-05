# 桌面浏览器与 Computer Use：官方边界调研

调研日期：2026-09-26。仅核对 OpenAI 当前官方文档；以下实现建议是对 Craft 的架构推断，不能当作已完成能力或私有宿主接口承诺。

## 官方产品事实

- 桌面内嵌浏览器可供 ChatGPT Work 与 Codex 开页、点击、输入、截图并验证页面；CLI/IDE 不含此内嵌浏览器。内嵌浏览器使用独立 profile，不自动共享常用浏览器登录态。Developer mode 可授权 CDP；内嵌浏览器不能自动上传文件。[Browser](https://learn.chatgpt.com/docs/browser)
- 浏览器扩展可在 Chrome、Edge、Brave、Opera、Vivaldi 使用已有登录态；接入需要桌面应用、对应插件/扩展和站点权限。可提及现有 tab；站点权限与浏览器扩展安装权限不同。[Browser extension](https://learn.chatgpt.com/docs/chrome-extension)
- Computer Use 在受支持地区的 macOS/Windows 桌面提供，需要启用插件 server/skill。macOS 另需屏幕录制和辅助功能权限；Windows 操作前台桌面，不能在用户继续操作同一桌面时后台执行。应用授权与 OS 权限独立；存在专用 MCP 时官方建议优先用结构化集成。[Computer Use](https://learn.chatgpt.com/docs/computer-use)

## 公开 API 与可接入边界

公开 Computer Use API 由应用提供执行环境：可以暴露 Playwright/PyAutoGUI 代码执行，也可消费结构化 computer actions。应用执行动作并返回截图，维护跨调用会话、权限、预算、取消与结果验证。模型会话恢复不会恢复浏览器登录态或运行时变量。官方支持沿用 function/MCP UI tools。[API Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)

这些页面没有承诺可从外部通过 Codex CLI/App Server 调用其桌面插件私有实现。因此不能把“已接入 Codex CLI”视为“获得 Codex 内嵌浏览器或任意 App 控制”。此结论是公开文档范围内的限制判断。

## 对 Craft 的建议（架构推断）

1. Workbench 承载用户可见的 tab、截图、操作状态、批准和接管；桌面宿主负责窗口、浏览器会话、OS 权限与生命周期。
2. 将浏览器和 OS 操作实现为明确的 Adapter/Capability，通过已有 Task、Policy、Activation、Receipt 契约执行。浏览器展示与 Agent 可操作浏览器应各自验证；WebView 存在不证明自动化已接通。
3. 首个低风险闭环采用独立浏览器 profile、固定 localhost 页面、结构化动作、前后截图和确定性页面断言。下一步再考虑现有 Chrome 扩展 bridge，以及平台分别实现的应用控制 bridge。
4. 权限粒度至少区分应用、站点、读取、交互、传输与不可逆动作；记录动作/目标/状态摘要及 Evidence 引用。网页、截图与应用文本均不能自行授予 effect 权限。
5. 恢复时重新获取真实 UI 状态；断线、超时或不明确结果进入 handoff/reconcile。现有 core 不能仅凭模型自然语言声明成功。

本次未操作任何用户应用、未修改运行时代码、未验证 Craft 桌面部署或跨平台控制能力。
