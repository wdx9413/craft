# A2A Discovery：只读 Agent Card 目录

> 状态：v0.11.40 已实现。发现远程 Agent 不等于信任、授权或委派任务。

Craft 仅通过 HTTPS 获取 A2A 标准位置 `/.well-known/agent-card.json` 的公开 Card，并保存发现 URL、Agent 名称、服务端点、协议版本、Skill ID、内容摘要及发现时间。Card 始终记录为 `trusted: false`、`execution_authority: false`。

发现拒绝 HTTP、非 JSON 对象、非 HTTPS 服务端点、失败响应及疑似明文敏感赋值。相同 Card ID 必须拥有相同的精确身份摘要，否则视为漂移而失败关闭。

本版本不发送 A2A Task、不跟随交互 URL、不处理认证、不存储凭据，也不把 Card 上的 Skill 变成 Craft 可执行能力。后续委派必须另行通过能力认证、授权、资源契约与 Evidence 链。
