---
name: craft-notes
description: 使用 Craft Context 的 Notes 能力积累、确认、查询或撤销设备、目录和文件笔记。
---

# Craft Notes

先确认目标设备、项目和路径。通过当前 MCP 工具列表核对参数，不把目录笔记扩大为其他项目的规则。Notes 与 Memory、Knowledge、Experience 分开保存；它只记录设备、目录和文件位置上的局部上下文，不保存通用偏好、项目规则或聊天总结。Notes 是 Craft Context 中独立归属的数据能力，不是单独安装的 Host 插件。

正常积累时，在一个已完成的任务实际使用了目录后，用准确的 Host `session_id`、`task_id`、绝对路径和 `outcome: "completed"` 调用 `craft_notes_observe_directory`。同一目录在 30 天内达到 3 个不同任务且跨 2 个 Host 会话后，只生成候选，仍须用户确认才进入默认召回。只有任务实际引用过的文件才调用 `craft_notes_observe_file`，并提供真实 `artifact_ref` 或确认过的 Codebase 引用；不要为了增加数量批量记录路径。

首次使用时，用 `craft_notes_location_list_devices` 检查是否已有活动设备。没有时，调用 `craft_notes_create_device` 前必须有用户提供的设备标识和 Device Note；不得猜测设备身份或替用户编造 Note。设备存在后按目标调用 `craft_notes_observe_directory` 或 `craft_notes_observe_file`。候选需要用户确认后调用 `craft_notes_confirm`，通过 `craft_notes_resolve` 核对实际可见正文。修改生成新版本，撤销调用 `craft_notes_revoke`，随后再次 resolve 确认不再返回。

当前 Craft Context 工具面没有 Notes 写入口时，明确报告版本尚不支持 Notes 积累。不要把笔记写入 Memory、Knowledge 或 Experience 作为替代。笔记不是经过评测的 Experience 规程。
