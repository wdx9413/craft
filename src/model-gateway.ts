import type { JsonObject } from "./infrastructure/store.ts";
import type { CraftModelConfig, ModelProtocol } from "./settings.ts";
import { text } from "./validation.ts";

/**
 * The model gateway.
 *
 * Models are user-configured (stored in settings.json). Each model has a
 * protocol (openai-compatible or anthropic), a base URL, a model name, and
 * the name of the environment variable that holds the API key. Keys are
 * never stored in settings — only the env-var name is.
 */

export type { ModelProtocol };
export type ModelTier = "small" | "standard" | "frontier";

export interface ModelProviderSpec {
  provider: string;
  label: string;
  protocol: ModelProtocol;
  base_url: string;
  api_key_env: string;
  chat_path: string;
  models: Partial<Record<ModelTier, string>>;
  /** A relative ordering hint; it is never presented as a price. */
  cost_hint: number;
  supports_tools: boolean;
}

const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const TIER_ORDER: readonly ModelTier[] = ["frontier", "standard", "small"];

/**
 * Built-in declarations keep a freshly installed runtime observable before the
 * user has added a private model configuration. They are never credentials and
 * a declared provider is still unusable until its environment variable exists.
 */
export const PROVIDER_CATALOG: readonly ModelProviderSpec[] = [
  { provider: "deepseek", label: "DeepSeek", protocol: "openai-compatible", base_url: "https://api.deepseek.com/v1", api_key_env: "DEEPSEEK_API_KEY", chat_path: "/chat/completions", models: { small: "deepseek-chat", standard: "deepseek-chat", frontier: "deepseek-reasoner" }, cost_hint: 1, supports_tools: true },
  { provider: "volcengine", label: "火山引擎方舟", protocol: "openai-compatible", base_url: "https://ark.cn-beijing.volces.com/api/v3", api_key_env: "ARK_API_KEY", chat_path: "/chat/completions", models: { small: "doubao-lite", standard: "doubao-pro", frontier: "doubao-pro-32k" }, cost_hint: 2, supports_tools: true },
  { provider: "qwen", label: "通义千问", protocol: "openai-compatible", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_key_env: "DASHSCOPE_API_KEY", chat_path: "/chat/completions", models: { small: "qwen-turbo", standard: "qwen-plus", frontier: "qwen-max" }, cost_hint: 2, supports_tools: true },
  { provider: "kimi", label: "Kimi (Moonshot)", protocol: "openai-compatible", base_url: "https://api.moonshot.cn/v1", api_key_env: "MOONSHOT_API_KEY", chat_path: "/chat/completions", models: { small: "moonshot-v1-8k", standard: "moonshot-v1-32k", frontier: "moonshot-v1-128k" }, cost_hint: 2, supports_tools: true },
  { provider: "glm", label: "智谱 GLM", protocol: "openai-compatible", base_url: "https://open.bigmodel.cn/api/paas/v4", api_key_env: "ZHIPU_API_KEY", chat_path: "/chat/completions", models: { small: "glm-4-flash", standard: "glm-4-air", frontier: "glm-4-plus" }, cost_hint: 1, supports_tools: true },
  { provider: "minimax", label: "MiniMax", protocol: "openai-compatible", base_url: "https://api.minimax.chat/v1", api_key_env: "MINIMAX_API_KEY", chat_path: "/text/chatcompletion_v2", models: { standard: "abab6.5s-chat", frontier: "abab6.5-chat" }, cost_hint: 2, supports_tools: false },
  { provider: "gpt", label: "OpenAI GPT", protocol: "openai-compatible", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY", chat_path: "/chat/completions", models: { small: "gpt-4o-mini", standard: "gpt-4o", frontier: "gpt-4.1" }, cost_hint: 6, supports_tools: true },
  { provider: "claude", label: "Anthropic Claude", protocol: "anthropic", base_url: "https://api.anthropic.com/v1", api_key_env: "ANTHROPIC_API_KEY", chat_path: "/messages", models: { small: "claude-haiku-4", standard: "claude-sonnet-4", frontier: "claude-opus-4" }, cost_hint: 7, supports_tools: true },
];



function httpUrl(value: unknown, name: string): string {
  const raw = text(value, name); let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} must be a valid HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials or query data`);
  }
  return raw.replace(/\/+$/u, "");
}

/** Define and validate a legacy provider declaration used by the runtime API. */
export function defineProvider(input: JsonObject): ModelProviderSpec {
  const provider = text(input.provider, "provider");
  if (!PROVIDER_NAME.test(provider)) throw new Error(`Unsupported provider name: ${provider}`);
  const protocol = text(input.protocol, "protocol");
  if (protocol !== "openai-compatible" && protocol !== "anthropic") throw new Error(`Unsupported provider protocol: ${protocol}`);
  const apiKeyEnv = text(input.api_key_env, "api_key_env");
  if (!ENV_NAME.test(apiKeyEnv)) throw new Error("api_key_env must be an uppercase environment-variable name");
  const rawModels = (input.models ?? {}) as JsonObject;
  if (typeof rawModels !== "object" || Array.isArray(rawModels)) throw new Error("provider models must be an object");
  const models: Partial<Record<ModelTier, string>> = {};
  for (const tier of TIER_ORDER) {
    const value = rawModels[tier]; if (value !== undefined && value !== null) models[tier] = text(value, `models.${tier}`);
  }
  if (!Object.keys(models).length) throw new Error("provider must declare at least one model tier");
  const supportsTools = input.supports_tools ?? true;
  if (typeof supportsTools !== "boolean") throw new Error("supports_tools must be a boolean");
  const costHint = input.cost_hint === undefined ? 1 : Number(input.cost_hint);
  if (!Number.isFinite(costHint) || costHint < 0) throw new Error("cost_hint must be a non-negative number");
  return { provider, label: input.label === undefined ? provider : text(input.label, "label"), protocol: protocol as ModelProtocol,
    base_url: httpUrl(input.base_url, "base_url"), api_key_env: apiKeyEnv,
    chat_path: input.chat_path === undefined ? (protocol === "anthropic" ? "/messages" : "/chat/completions") : text(input.chat_path, "chat_path"),
    models, cost_hint: costHint, supports_tools: supportsTools };
}

export interface ChatToolDefinition { type: "function"; function: { name: string; description?: string; parameters?: JsonObject } }
export interface ChatToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: ChatToolCall[] }
export interface ChatRequest { url: string; headers: JsonObject; body: JsonObject; prompt_tokens_estimate: number }
export interface ChatResult { text: string; model: string | null; usage: { input_tokens: number; output_tokens: number } | null; tool_calls?: ChatToolCall[] }

/** Build a provider spec from a user-configured model entry. */
export function specFromConfig(model: CraftModelConfig): ModelProviderSpec {
  const chatPath = model.protocol === "anthropic" ? "/messages" : "/chat/completions";
  return {
    provider: model.id,
    label: model.name || model.id,
    protocol: model.protocol,
    base_url: model.baseUrl,
    api_key_env: model.apiKeyEnv,
    chat_path: chatPath,
    models: { standard: model.model }, cost_hint: 1,
    supports_tools: model.supportsTools,
  };
}

/** Convert an array of user models to provider specs. */
export function specsFromModels(models: CraftModelConfig[]): ModelProviderSpec[] {
  return models.map(specFromConfig);
}

/** Public, secret-free view of a model config. */
export function publicModel(model: CraftModelConfig, env: NodeJS.ProcessEnv = process.env): JsonObject {
  const value = env[model.apiKeyEnv];
  const configured = typeof value === "string" && value.length > 0;
  return { id: model.id, name: model.name, protocol: model.protocol,
    baseUrl: model.baseUrl, model: model.model, apiKeyEnv: model.apiKeyEnv,
    configured, supportsTools: model.supportsTools };
}

/**
 * Legacy wrapper: public view of a provider spec. Kept for callers that
 * still work with ModelProviderSpec objects (runtime, internal host, etc.).
 */
export function publicProvider(spec: ModelProviderSpec, env: NodeJS.ProcessEnv = process.env): JsonObject {
  const value = env[spec.api_key_env];
  const configured = typeof value === "string" && value.length > 0;
  return { provider: spec.provider, label: spec.label, protocol: spec.protocol,
    base_url: spec.base_url, api_key_env: spec.api_key_env,
    models: spec.models, cost_hint: spec.cost_hint, supports_tools: spec.supports_tools, configured };
}

/**
 * Check whether a provider spec has its API key configured in the environment.
 */
export function credentialStatus(spec: ModelProviderSpec, env: NodeJS.ProcessEnv = process.env): { provider: string; configured: boolean; api_key_env: string } {
  const value = env[spec.api_key_env];
  return { provider: spec.provider, configured: typeof value === "string" && value.length > 0, api_key_env: spec.api_key_env };
}

/**
 * Legacy tier selection. User-configured models only have one model, so every
 * tier resolves to the same "standard" model. Kept for compatibility with
 * callers that still pass a tier parameter.
 */
export function selectModel(spec: ModelProviderSpec, tier: ModelTier): { tier: ModelTier; model: string; downgraded: boolean } {
  if (!TIER_ORDER.includes(tier)) throw new Error(`Unsupported model tier: ${String(tier)}`);
  for (let index = TIER_ORDER.indexOf(tier); index < TIER_ORDER.length; index += 1) {
    const candidate = TIER_ORDER[index]; const model = spec.models[candidate];
    if (model) return { tier: candidate, model, downgraded: candidate !== tier };
  }
  throw new Error(`Provider ${spec.provider} declares no usable model tier`);
}

/**
 * Render a request for the two wire formats. Only the shape is built here; the
 * API key is read at call time from the environment by the transport, so it can
 * never end up inside a stored record.
 *
 * The authorization header therefore records the *name* of the environment
 * variable the transport should read — never a value, and never the literal
 * `${...}` source text of a template. The previous form emitted the literal
 * string `Bearer $WORKBUDDY_API_KEY`, which announced a credential to anyone
 * inspecting the built request while being a valid-looking header: the transport
 * happened to rebuild its own headers and masked the defect. It is named here as
 * `env:NAME` so a reader can tell at a glance that no secret is present.
 */
export function buildChatRequest(spec: ModelProviderSpec, options: {
  model: string; messages: ChatMessage[]; max_tokens?: number; temperature?: number; tools?: ChatToolDefinition[]; stream?: boolean;
}): ChatRequest {
  const model = text(options.model, "model");
  if (!Array.isArray(options.messages) || !options.messages.length) throw new Error("chat request requires at least one message");
  const messages = options.messages.map((message, index) => {
    if (!message || typeof message !== "object") throw new Error(`chat message ${index} must be an object`);
    if (!["system", "user", "assistant", "tool"].includes(message.role)) throw new Error(`chat message ${index} has an unsupported role`);
    if (message.content !== null && typeof message.content !== "string") throw new Error(`chat message ${index} content must be a string or null`);
    return { ...message };
  });
  const promptChars = messages.reduce((total, message) => total + String(message.content ?? "").length, 0);
  const promptTokensEstimate = Math.max(1, Math.ceil(promptChars / 4));
  const headers: JsonObject = { "content-type": "application/json" };
  let body: JsonObject;
  if (spec.protocol === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    const system = messages.filter((message) => message.role === "system").map((message) => message.content ?? "").join("\n\n");
    body = { model, max_tokens: options.max_tokens ?? 4_096,
       messages: messages.filter((message) => message.role !== "system").map((message) => message.role === "tool"
         ? ({ role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "unknown", content: message.content ?? "" }] } as JsonObject)
         : ({ ...message, ...(message.tool_call_id ? { tool_use_id: message.tool_call_id } : {}) } as JsonObject)),
      ...(system ? { system } : {}), ...(options.tools?.length ? { tools: options.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters ?? { type: "object" } })) } : {}), ...(options.stream ? { stream: true } : {}) };
  } else {
    headers.authorization = `env:${spec.api_key_env}`;
    body = { model, messages, max_tokens: options.max_tokens ?? 4_096,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }), ...(options.tools?.length ? { tools: options.tools } : {}), ...(options.stream ? { stream: true } : {}) };
  }
  return { url: `${spec.base_url}${spec.chat_path}`, headers, body, prompt_tokens_estimate: promptTokensEstimate };
}

/** Normalize either wire format into text plus usage. A malformed payload fails closed. */
export function parseChatResponse(spec: ModelProviderSpec, payload: unknown): ChatResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Model response must be an object");
  const body = payload as JsonObject;
  if (spec.protocol === "anthropic") {
    const blocks = Array.isArray(body.content) ? body.content as JsonObject[] : [];
    const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
    if (!text) throw new Error("Anthropic response contained no text block");
    const usage = body.usage as JsonObject | undefined;
    const toolCalls = blocks.filter((block) => block.type === "tool_use").map((block, index) => ({ id: String(block.id ?? `tool_${index + 1}`), type: "function" as const, function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) } }));
    return { text, model: body.model === undefined ? null : String(body.model), ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      usage: usage ? { input_tokens: Number(usage.input_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? 0) } : null };
  }
  const choices = Array.isArray(body.choices) ? body.choices as JsonObject[] : [];
  const message = choices[0]?.message as JsonObject | undefined;
  if (!message || (message.content !== null && typeof message.content !== "string")) throw new Error("OpenAI-compatible response contained no message content");
  const usage = body.usage as JsonObject | undefined;
  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as JsonObject[]).map((item, index) => {
    const fn = item.function as JsonObject;
    return { id: String(item.id ?? `tool_${index + 1}`), type: "function" as const, function: { name: String(fn.name), arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) } };
  }) : [];
  return { text: message.content === null ? "" : message.content, model: body.model === undefined ? null : String(body.model), ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    usage: usage ? { input_tokens: Number(usage.prompt_tokens ?? 0), output_tokens: Number(usage.completion_tokens ?? 0) } : null };
}

/**
 * The transport seam. Craft ships no network client in this version, so the
 * default refuses with an actionable message instead of pretending to run; a
 * deployment (or a test) injects a real one.
 */
export interface ModelTransport { complete(spec: ModelProviderSpec, request: ChatRequest): Promise<ChatResult> }

export interface FetchTransportOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  maxResponseBytes?: number;
}

function responseError(status: number, body: string): Error {
  const detail = body.replace(/\s+/gu, " ").trim().slice(0, 300);
  return new Error(`Model request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
}

/**
 * The built-in network transport. It deliberately uses the platform fetch API
 * rather than adding an SDK per provider: the config already normalizes the
 * two wire formats and this keeps the code small and cross-platform.
 */
export function createFetchTransport(options: FetchTransportOptions = {}): ModelTransport {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error("timeoutMs must be between 100 and 300000");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error("maxAttempts must be between 1 and 5");
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1_024) throw new Error("maxResponseBytes must be at least 1024");
  return {
    complete: async (spec, request) => {
      const key = env[spec.api_key_env]?.trim();
      if (!key) throw new Error(`Model ${spec.provider} is not configured; set ${spec.api_key_env} before running Craft.`);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (spec.protocol === "anthropic") {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers.authorization = `Bearer ${key}`;
      }
      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let retryable = true;
        try {
          const response = await fetchImpl(request.url, { method: "POST", headers, body: JSON.stringify(request.body), signal: controller.signal });
          const body = await response.text();
          if (body.length > maxResponseBytes) throw new Error(`Model response exceeded ${maxResponseBytes} bytes`);
          if (response.ok) {
            let parsed: unknown;
            try { parsed = JSON.parse(body); } catch { throw new Error("Model response was not valid JSON"); }
            return parseChatResponse(spec, parsed);
          }
          lastError = responseError(response.status, body);
          retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          if (!retryable || attempt === maxAttempts) throw lastError;
          const retryAfter = Number(response.headers.get("retry-after") ?? "0");
          await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, 10_000) : attempt * 250));
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (!retryable || attempt === maxAttempts) throw lastError;
          if (lastError.name === "AbortError") lastError = new Error(`Model request timed out after ${timeoutMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        } finally {
          clearTimeout(timer);
        }
      }
      // maxAttempts is validated as a positive integer, so every exhausted
      // loop has either captured or thrown the last transport error.
      throw lastError as Error;
    },
  };
}

/** Backward-compat alias — prefer specFromConfig. */
export function providerFromConfig(input: { protocol: ModelProtocol; name: string; baseUrl: string; model: string; apiKeyEnv?: string }): ModelProviderSpec {
  const normalized = input.name.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "") || "custom";
  return defineProvider({ provider: normalized, label: input.name.trim() || normalized, protocol: input.protocol,
    base_url: input.baseUrl, api_key_env: input.apiKeyEnv || "CRAFT_API_KEY", models: { standard: input.model }, supports_tools: true, cost_hint: 1 });
}

export const unconfiguredTransport: ModelTransport = {
  complete: async (spec) => {
    throw new Error(`No model transport is installed for ${spec.provider}; set ${spec.api_key_env} and enable the internal host before running the loop.`);
  },
};
