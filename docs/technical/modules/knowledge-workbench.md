# Knowledge Workbench

> 状态：v0.11.34 已实现的本机可见界面。它展示和操作本地知识记录；它不是自动知识采集、自动审核或自动发布系统。

Workbench 的“知识库”区使用一个有界只读投影显示 Claim、Wiki 页面、Context Bundle、矛盾关系、候选能力、评测记录和已绑定知识的 Work Launch。页面正文仍存为可编辑 Markdown；打开页面读取指定版本，刷新只把人工文件改动记录为新的审计版本，不会把内容自动标为可信。

操作者可以在界面中审核 Claim（`reviewed`、`disputed`、`superseded`、`expired`），查看 Bundle 的只读 Prompt 预览，并在启动工作时选择一个 Bundle。选择后 Workbench 先创建任务，再调用 Knowledge-bound Work Launch，而不是走普通 Launch 的绕过路径。

每次 Bundle 预览、准备、批准和重试均由服务端重新核对 Bundle、Claim 版本、审核状态、有效期、scope、Evidence 和摘要。UI 仅显示状态和提交人的明确操作；它不拥有批准、执行或信任判断权。若知识变动，启动会失败关闭。

本版本只监听 loopback，沿用 Workbench token 和同源检查。它没有远程同步、向量搜索、团队权限或自动将 Wiki 生成 Skill 的功能；这些都需保留独立评测与人工发布门禁。
