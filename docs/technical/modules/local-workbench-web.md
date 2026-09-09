# Local Workbench Web

v0.11.0 提供首个可见工作台。运行 `craft serve` 后，Craft 只在 `127.0.0.1` 启动 HTTP 服务，并输出带 URL Fragment 会话令牌的本地地址。Fragment 不会随页面请求发送；页面只把令牌放入本机 API 的 Authorization Header。

v0.11.1 增加本地目标创建和任务详情。详情展示与任务精确关联的 Checkpoint、反馈、运行、Trial、Outcome、Evidence、Artifact、Lineage、等待与待处理状态；缺失引用被忽略而不是伪造。创建目标只写入 Craft 本地状态，不会启动模型、调用外部系统或隐式选择执行权限。

服务提供 Home 读取以及 Inbox 刷新/处置入口，直接复用内核。API 校验 Bearer Token 和 Origin，请求体上限 64 KiB，响应禁止缓存并设置 CSP、`nosniff` 和禁止嵌入策略。当前令牌随进程销毁，不落盘；没有 TLS、远程访问、用户账户、多人协作、实时推送、领域组件和自动打开浏览器。它不能暴露到局域网或公网。
