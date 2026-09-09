# Codex CLI Host Driver

v0.11.2 把 Codex 从“已登记的宿主类型”推进为真实可运行的 Host Driver。Craft 负责控制面，Codex CLI 负责 Agent 执行面。

## 执行协议

1. `prepare` 固定 Task 版本、工作目录、Sandbox、模型与 Prompt 摘要，但不持久化 Prompt 原文。
2. `execute` 要求调用方再次提供 Prompt，并校验摘要，避免准备后内容漂移。
3. 固定以参数数组启动 `codex exec --json --ephemeral`，不经过系统 Shell，也不接受任意可执行文件或危险的无沙箱参数。
4. `read-only` 可直接执行；`workspace-write` 必须消费与 Task、目标目录和请求摘要完全一致的一次性 Autonomy Authorization。
5. JSONL、标准错误、超时和输出大小都有边界；结果写入 `~/.craft_data/artifacts/codex`，数据库只保存结构化回执和文件 URI。

## 承诺边界

- Craft 不读取或复制 Codex 登录凭据，沿用宿主现有认证。
- Craft 不使用 `danger-full-access` 或绕过审批/沙箱参数。
- 当前驱动提供超时终止与失败回执；显式用户取消协议仍待补齐，也不等同于外部系统事务回滚。
- Prompt 目前由执行调用方短暂持有；长流程恢复只保存摘要，需要上层重新提供原文或未来接入加密 Secret/Blob Store。
