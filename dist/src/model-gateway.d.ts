import type { JsonObject } from "./store.ts";
/**
 * The model gateway.
 *
 * Craft's second shape is running the loop itself instead of handing work to
 * Codex or Claude. That needs a provider abstraction, and the first thing a
 * provider abstraction must get right is where the secret lives: Craft stores
 * the *name* of the environment variable that holds a key, never the key. This
 * module therefore contains no credential values at all — a configured provider
 * is one whose environment variable happens to be set at run time.
 *
 * Nothing here performs I/O. Rendering a request and parsing a response are pure
 * functions so they can be verified without a network, which is also what lets
 * the eight provider families ship before any key exists.
 */
export type ModelProtocol = "openai-compatible" | "anthropic";
export type ModelTier = "small" | "standard" | "frontier";
export interface ModelProviderSpec {
    provider: string;
    label: string;
    protocol: ModelProtocol;
    base_url: string;
    api_key_env: string;
    chat_path: string;
    models: Partial<Record<ModelTier, string>>;
    /** Relative price hint used only to order providers; never presented as a real quote. */
    cost_hint: number;
    supports_tools: boolean;
}
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface ChatRequest {
    url: string;
    headers: JsonObject;
    body: JsonObject;
    prompt_tokens_estimate: number;
}
export interface ChatResult {
    text: string;
    model: string | null;
    usage: {
        input_tokens: number;
        output_tokens: number;
    } | null;
}
/**
 * The provider families Craft declares support for. Each row is a data
 * declaration: adding a vendor is a row, not a code path.
 *
 * Anthropic is the one native non-OpenAI wire format in this list; every other
 * vendor exposes an OpenAI-compatible surface, including the Chinese clouds.
 */
export declare const PROVIDER_CATALOG: readonly ModelProviderSpec[];
/** Validate one declaration. A provider without any model tier is useless, so it fails closed. */
export declare function defineProvider(input: JsonObject): ModelProviderSpec;
/**
 * Pick a model for a tier, walking *down* so a missing tier degrades to a cheaper
 * one instead of silently paying for a stronger model than the task asked for.
 */
export declare function selectModel(spec: ModelProviderSpec, tier: ModelTier): {
    tier: ModelTier;
    model: string;
    downgraded: boolean;
};
/** A provider is usable when its declared environment variable holds a value. No secret is ever returned. */
export declare function credentialStatus(spec: ModelProviderSpec, env?: NodeJS.ProcessEnv): {
    provider: string;
    api_key_env: string;
    configured: boolean;
};
/** Public, secret-free view of a provider, which is what every read surface returns. */
export declare function publicProvider(spec: ModelProviderSpec, env?: NodeJS.ProcessEnv): JsonObject;
/**
 * Render a request for the two wire formats. Only the shape is built here; the
 * API key is read at call time from the environment by the transport, so it can
 * never end up inside a stored record.
 */
export declare function buildChatRequest(spec: ModelProviderSpec, options: {
    model: string;
    messages: ChatMessage[];
    max_tokens?: number;
    temperature?: number;
}): ChatRequest;
/** Normalize either wire format into text plus usage. A malformed payload fails closed. */
export declare function parseChatResponse(spec: ModelProviderSpec, payload: unknown): ChatResult;
/**
 * The transport seam. Craft ships no network client in this version, so the
 * default refuses with an actionable message instead of pretending to run; a
 * deployment (or a test) injects a real one.
 */
export interface ModelTransport {
    complete(spec: ModelProviderSpec, request: ChatRequest): Promise<ChatResult>;
}
export declare const unconfiguredTransport: ModelTransport;
