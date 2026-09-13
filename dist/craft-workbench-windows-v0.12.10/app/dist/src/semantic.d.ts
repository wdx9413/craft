export interface EmbeddingProviderConfig {
    protocol: "openai-compatible";
    name: string;
    baseUrl: string;
    model: string;
    apiKeyEnv?: string;
    timeoutMs?: number;
}
export interface EmbeddingProvider {
    readonly fingerprint: string;
    readonly label: {
        name: string;
        model: string;
    };
    embed(texts: string[]): Promise<number[][]>;
}
export type SemanticStatus = {
    mode: "disabled" | "configured" | "ready" | "degraded";
    provider?: {
        name: string;
        model: string;
    };
    reason?: "not_configured" | "cooldown" | "timeout" | "authentication" | "invalid_response" | "provider_error" | "index_incomplete";
    last_success_at?: string;
    degraded_until?: string;
    indexed_capabilities?: number;
};
export declare function embeddingFingerprint(config: EmbeddingProviderConfig): string;
export declare function semanticFailureReason(error: unknown): SemanticStatus["reason"];
export declare class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
    readonly fingerprint: string;
    readonly label: {
        name: string;
        model: string;
    };
    readonly config: EmbeddingProviderConfig;
    constructor(config: EmbeddingProviderConfig);
    embed(texts: string[]): Promise<number[][]>;
}
export declare function sanitizeEmbeddingText(value: string): string;
export declare function cosine(left: number[], right: number[]): number;
