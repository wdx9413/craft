# Model Gateway：声明式模型接入

> 状态：v0.12.2 实现 Provider 目录、分层选择、请求渲染与响应解析，以及基于平台 fetch 的网络传输。API Key 只从用户环境变量读取，不落库。

## 原则：变量名单在库里，密钥在环境里

Provider 目录只保存端点、协议、模型分层与**环境变量名**。`credentialStatus` 报告某个变量"是否有值"，但从不读取或返回值。所以一个 provider 可以在没有任何密钥的情况下被声明、配置、验证和展示。

## 支持的模型族

| provider | 协议 | 基础地址 | 凭证环境变量 | 分层模型 |
| --- | --- | --- | --- | --- |
| `deepseek` | openai-compatible | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | deepseek-chat / deepseek-reasoner |
| `volcengine` | openai-compatible | `https://ark.cn-beijing.volces.com/api/v3` | `ARK_API_KEY` | doubao-lite / doubao-pro |
| `qwen` | openai-compatible | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | qwen-turbo / qwen-plus / qwen-max |
| `kimi` | openai-compatible | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | moonshot-v1-8k / 32k / 128k |
| `glm` | openai-compatible | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | glm-4-flash / air / plus |
| `minimax` | openai-compatible | `https://api.minimax.chat/v1` | `MINIMAX_API_KEY` | abab6.5s-chat / abab6.5-chat |
| `gpt` | openai-compatible | `https://api.openai.com/v1` | `OPENAI_API_KEY` | gpt-4o-mini / gpt-4o / gpt-4.1 |
| `claude` | **anthropic** | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | claude-haiku / sonnet / opus |

Anthropic 是唯一使用原生非 OpenAI 线格式的一家；其余都通过 OpenAI-compatible 端点暴露（含国内云）。新增一家是**加一行数据，不是加一条代码路径**。

## 分层与降级

`selectModel(spec, tier)` 从请求的层**向下**查找（frontier → standard → small）。缺层时退到更便宜的模型，绝不为任务静默升级到更贵的模型。这与 `token-budget.ts` 的确定性路由语义一致。

## 请求与响应

- `buildChatRequest` 是纯函数，产出 `{url, headers, body, prompt_tokens_estimate}`。OpenAI 兼容格式使用 `messages` + `Bearer $ENV_NAME` 占位；Anthropic 格式把 system 抽到独立字段并附 `anthropic-version`。
- `parseChatResponse` 归一化两种格式为 `{text, model, usage}`；缺失字段按 0 / null 处理，畸形载荷直接失败关闭。
- **没有任何 I/O。** 因此 8 家可以在无网络、无密钥的环境下被完整验证。

## Transport 接缝

```ts
interface ModelTransport {
  complete(spec: ModelProviderSpec, request: ChatRequest): Promise<ChatResult>;
}
```

默认 `unconfiguredTransport` 明确拒绝，并指出需要设置哪个环境变量——它不会假装在跑。部署方或测试注入真实实现。

## 边界

- 不含 API Key、不含网络客户端、不发起任何请求。
- 不替用户选择模型：选择由 tier、成本提示与 fallback 链决定，且只降级不升级。
- `cost_hint` 是相对价格排序提示，**不是**报价。
- `craft_model_provider_list` / `craft_model_provider_get` 返回的视图经过脱敏，永远不含密钥内容。
