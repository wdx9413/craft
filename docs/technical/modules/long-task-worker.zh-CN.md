# Long Task Worker（v0.12.9）

长任务采用可持久化协议：

```text
running → suspend/release → waiting → wake → revalidate → fresh Host dispatch
                                      ↘ needs_replan
```

`craft_long_task_suspend` 保存 Session、Task Run、Host Run、等待条件和上下文摘要；不会保存 Prompt 正文，也不会尝试重新挂接已退出的 Host 进程。外部事件或人工操作通过 `wake` 唤醒，`resume` 重新检查 Session 版本和 Context Digest。漂移时失败关闭为 `needs_replan`。
