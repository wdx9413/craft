const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
/**
 * The provider families Craft declares support for. Each row is a data
 * declaration: adding a vendor is a row, not a code path.
 *
 * Anthropic is the one native non-OpenAI wire format in this list; every other
 * vendor exposes an OpenAI-compatible surface, including the Chinese clouds.
 */
export const PROVIDER_CATALOG = [
    { provider: "deepseek", label: "DeepSeek", protocol: "openai-compatible", base_url: "https://api.deepseek.com/v1",
        api_key_env: "DEEPSEEK_API_KEY", chat_path: "/chat/completions",
        models: { small: "deepseek-chat", standard: "deepseek-chat", frontier: "deepseek-reasoner" }, cost_hint: 1, supports_tools: true },
    { provider: "volcengine", label: "火山引擎方舟", protocol: "openai-compatible", base_url: "https://ark.cn-beijing.volces.com/api/v3",
        api_key_env: "ARK_API_KEY", chat_path: "/chat/completions",
        models: { small: "doubao-lite", standard: "doubao-pro", frontier: "doubao-pro-32k" }, cost_hint: 2, supports_tools: true },
    { provider: "qwen", label: "通义千问", protocol: "openai-compatible", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key_env: "DASHSCOPE_API_KEY", chat_path: "/chat/completions",
        models: { small: "qwen-turbo", standard: "qwen-plus", frontier: "qwen-max" }, cost_hint: 2, supports_tools: true },
    { provider: "kimi", label: "Kimi (Moonshot)", protocol: "openai-compatible", base_url: "https://api.moonshot.cn/v1",
        api_key_env: "MOONSHOT_API_KEY", chat_path: "/chat/completions",
        models: { small: "moonshot-v1-8k", standard: "moonshot-v1-32k", frontier: "moonshot-v1-128k" }, cost_hint: 2, supports_tools: true },
    { provider: "glm", label: "智谱 GLM", protocol: "openai-compatible", base_url: "https://open.bigmodel.cn/api/paas/v4",
        api_key_env: "ZHIPU_API_KEY", chat_path: "/chat/completions",
        models: { small: "glm-4-flash", standard: "glm-4-air", frontier: "glm-4-plus" }, cost_hint: 1, supports_tools: true },
    { provider: "minimax", label: "MiniMax", protocol: "openai-compatible", base_url: "https://api.minimax.chat/v1",
        api_key_env: "MINIMAX_API_KEY", chat_path: "/text/chatcompletion_v2",
        models: { standard: "abab6.5s-chat", frontier: "abab6.5-chat" }, cost_hint: 2, supports_tools: false },
    { provider: "gpt", label: "OpenAI GPT", protocol: "openai-compatible", base_url: "https://api.openai.com/v1",
        api_key_env: "OPENAI_API_KEY", chat_path: "/chat/completions",
        models: { small: "gpt-4o-mini", standard: "gpt-4o", frontier: "gpt-4.1" }, cost_hint: 6, supports_tools: true },
    { provider: "claude", label: "Anthropic Claude", protocol: "anthropic", base_url: "https://api.anthropic.com/v1",
        api_key_env: "ANTHROPIC_API_KEY", chat_path: "/messages",
        models: { small: "claude-haiku-4", standard: "claude-sonnet-4", frontier: "claude-opus-4" }, cost_hint: 7, supports_tools: true },
];
const TIER_ORDER = ["frontier", "standard", "small"];
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function httpUrl(value, name) {
    const raw = text(value, name);
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new Error(`${name} must be a valid HTTP(S) URL`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error(`${name} must be an HTTP(S) URL without credentials or query data`);
    }
    return raw.replace(/\/+$/u, "");
}
/** Validate one declaration. A provider without any model tier is useless, so it fails closed. */
export function defineProvider(input) {
    const provider = text(input.provider, "provider");
    if (!PROVIDER_NAME.test(provider))
        throw new Error(`Unsupported provider name: ${provider}`);
    const protocol = text(input.protocol, "protocol");
    if (!["openai-compatible", "anthropic"].includes(protocol))
        throw new Error(`Unsupported provider protocol: ${protocol}`);
    const apiKeyEnv = text(input.api_key_env, "api_key_env");
    if (!ENV_NAME.test(apiKeyEnv))
        throw new Error("api_key_env must be an uppercase environment-variable name");
    const rawModels = (input.models ?? {});
    if (typeof rawModels !== "object" || Array.isArray(rawModels))
        throw new Error("provider models must be an object");
    const models = {};
    for (const tier of TIER_ORDER) {
        const value = rawModels[tier];
        if (value === undefined || value === null)
            continue;
        models[tier] = text(value, `models.${tier}`);
    }
    if (!Object.keys(models).length)
        throw new Error("provider must declare at least one model tier");
    const supportsTools = input.supports_tools ?? true;
    if (typeof supportsTools !== "boolean")
        throw new Error("supports_tools must be a boolean");
    const costHint = input.cost_hint === undefined ? 1 : Number(input.cost_hint);
    if (!Number.isFinite(costHint) || costHint < 0)
        throw new Error("cost_hint must be a non-negative number");
    return { provider, label: input.label === undefined ? provider : text(input.label, "label"),
        protocol: protocol, base_url: httpUrl(input.base_url, "base_url"), api_key_env: apiKeyEnv,
        chat_path: input.chat_path === undefined ? (protocol === "anthropic" ? "/messages" : "/chat/completions") : text(input.chat_path, "chat_path"),
        models, cost_hint: costHint, supports_tools: supportsTools };
}
/**
 * Pick a model for a tier, walking *down* so a missing tier degrades to a cheaper
 * one instead of silently paying for a stronger model than the task asked for.
 */
export function selectModel(spec, tier) {
    if (!TIER_ORDER.includes(tier))
        throw new Error(`Unsupported model tier: ${String(tier)}`);
    for (let index = TIER_ORDER.indexOf(tier); index < TIER_ORDER.length; index += 1) {
        const candidate = TIER_ORDER[index];
        const model = spec.models[candidate];
        if (model)
            return { tier: candidate, model, downgraded: candidate !== tier };
    }
    throw new Error(`Provider ${spec.provider} declares no usable model tier`);
}
/** A provider is usable when its declared environment variable holds a value. No secret is ever returned. */
export function credentialStatus(spec, env = process.env) {
    const value = env[spec.api_key_env];
    return { provider: spec.provider, api_key_env: spec.api_key_env, configured: typeof value === "string" && value.length > 0 };
}
/** Public, secret-free view of a provider, which is what every read surface returns. */
export function publicProvider(spec, env = process.env) {
    return { label: spec.label, protocol: spec.protocol, base_url: spec.base_url,
        models: spec.models, cost_hint: spec.cost_hint, supports_tools: spec.supports_tools,
        ...credentialStatus(spec, env) };
}
/**
 * Render a request for the two wire formats. Only the shape is built here; the
 * API key is read at call time from the environment by the transport, so it can
 * never end up inside a stored record.
 */
export function buildChatRequest(spec, options) {
    const model = text(options.model, "model");
    if (!Array.isArray(options.messages) || !options.messages.length)
        throw new Error("chat request requires at least one message");
    const messages = options.messages.map((message, index) => {
        if (!message || typeof message !== "object")
            throw new Error(`chat message ${index} must be an object`);
        if (!["system", "user", "assistant"].includes(message.role))
            throw new Error(`chat message ${index} has an unsupported role`);
        if (typeof message.content !== "string")
            throw new Error(`chat message ${index} content must be a string`);
        return { role: message.role, content: message.content };
    });
    const promptChars = messages.reduce((total, message) => total + message.content.length, 0);
    const promptTokensEstimate = Math.max(1, Math.ceil(promptChars / 4));
    const headers = { "content-type": "application/json" };
    let body;
    if (spec.protocol === "anthropic") {
        headers["anthropic-version"] = "2023-06-01";
        const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
        body = { model, max_tokens: options.max_tokens ?? 4_096,
            messages: messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: message.content })),
            ...(system ? { system } : {}) };
    }
    else {
        headers.authorization = `Bearer $${spec.api_key_env}`;
        body = { model, messages, max_tokens: options.max_tokens ?? 4_096,
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }) };
    }
    return { url: `${spec.base_url}${spec.chat_path}`, headers, body, prompt_tokens_estimate: promptTokensEstimate };
}
/** Normalize either wire format into text plus usage. A malformed payload fails closed. */
export function parseChatResponse(spec, payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error("Model response must be an object");
    const body = payload;
    if (spec.protocol === "anthropic") {
        const blocks = Array.isArray(body.content) ? body.content : [];
        const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
        if (!text)
            throw new Error("Anthropic response contained no text block");
        const usage = body.usage;
        return { text, model: body.model === undefined ? null : String(body.model),
            usage: usage ? { input_tokens: Number(usage.input_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? 0) } : null };
    }
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const message = choices[0]?.message;
    if (!message || typeof message.content !== "string")
        throw new Error("OpenAI-compatible response contained no message content");
    const usage = body.usage;
    return { text: message.content, model: body.model === undefined ? null : String(body.model),
        usage: usage ? { input_tokens: Number(usage.prompt_tokens ?? 0), output_tokens: Number(usage.completion_tokens ?? 0) } : null };
}
function responseError(status, body) {
    const detail = body.replace(/\s+/gu, " ").trim().slice(0, 300);
    return new Error(`Model request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
}
/**
 * The built-in network transport. It deliberately uses the platform fetch API
 * rather than adding an SDK per provider: the catalog already normalizes the
 * two wire formats and this keeps the plugin small and cross-platform.
 */
export function createFetchTransport(options = {}) {
    const env = options.env ?? process.env;
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const maxAttempts = options.maxAttempts ?? 3;
    const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000)
        throw new Error("timeoutMs must be between 100 and 300000");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)
        throw new Error("maxAttempts must be between 1 and 5");
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1_024)
        throw new Error("maxResponseBytes must be at least 1024");
    return {
        complete: async (spec, request) => {
            const key = env[spec.api_key_env]?.trim();
            if (!key)
                throw new Error(`Provider ${spec.provider} is not configured; set ${spec.api_key_env} before running Craft.`);
            const headers = { "content-type": "application/json" };
            if (spec.protocol === "anthropic") {
                headers["x-api-key"] = key;
                headers["anthropic-version"] = "2023-06-01";
            }
            else {
                headers.authorization = `Bearer ${key}`;
            }
            let lastError;
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                let retryable = true;
                try {
                    const response = await fetchImpl(request.url, { method: "POST", headers, body: JSON.stringify(request.body), signal: controller.signal });
                    const body = await response.text();
                    if (body.length > maxResponseBytes)
                        throw new Error(`Model response exceeded ${maxResponseBytes} bytes`);
                    if (response.ok) {
                        let parsed;
                        try {
                            parsed = JSON.parse(body);
                        }
                        catch {
                            throw new Error("Model response was not valid JSON");
                        }
                        return parseChatResponse(spec, parsed);
                    }
                    lastError = responseError(response.status, body);
                    retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
                    if (!retryable || attempt === maxAttempts)
                        throw lastError;
                    const retryAfter = Number(response.headers.get("retry-after") ?? "0");
                    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, 10_000) : attempt * 250));
                }
                catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    if (!retryable || attempt === maxAttempts)
                        throw lastError;
                    if (lastError.name === "AbortError")
                        lastError = new Error(`Model request timed out after ${timeoutMs}ms`);
                    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
                }
                finally {
                    clearTimeout(timer);
                }
            }
            // maxAttempts is validated as a positive integer, so every exhausted
            // loop has either captured or thrown the last transport error.
            throw lastError;
        },
    };
}
/** Turn the user-facing config shape into the normalized provider declaration. */
export function providerFromConfig(input) {
    const normalized = input.name.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "") || "custom";
    return defineProvider({ provider: normalized, label: input.name.trim() || normalized, protocol: input.protocol, base_url: input.baseUrl,
        api_key_env: input.apiKeyEnv || "CRAFT_API_KEY", chat_path: input.protocol === "anthropic" ? "/messages" : "/chat/completions",
        models: { standard: input.model }, supports_tools: true, cost_hint: 1 });
}
export const unconfiguredTransport = {
    complete: async (spec) => {
        throw new Error(`No model transport is installed for provider ${spec.provider}; set ${spec.api_key_env} and enable the internal host before running the loop.`);
    },
};
//# sourceMappingURL=model-gateway.js.map