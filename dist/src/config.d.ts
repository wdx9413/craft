import { type CraftPaths } from "./paths.ts";
import { type EmbeddingProviderConfig } from "./semantic.ts";
export type CraftMode = "agent" | "supervisor" | "provider";
export type RuntimeKind = "direct-api" | "codex-cli" | "claude-code" | "unconfigured";
export interface DirectProvider {
    protocol: "openai-compatible" | "anthropic";
    name: string;
    baseUrl: string;
    model: string;
    apiKeyEnv?: string;
}
export interface CraftConfig {
    schemaVersion: 1;
    activeMode: CraftMode;
    initializedAt: string;
    updatedAt: string;
    runtime: {
        kind: RuntimeKind;
        command?: string;
        provider?: DirectProvider;
    };
    supervisor: {
        hosts: Array<"codex-cli" | "claude-code" | "generic-mcp">;
    };
    storage: {
        database: string;
        capabilityIndex: string;
        legacyDatabase?: string;
    };
    semanticSearch?: {
        provider: EmbeddingProviderConfig;
    };
}
export interface InitInput {
    mode: CraftMode;
    runtimeKind?: RuntimeKind;
    provider?: DirectProvider;
    supervisorHosts?: CraftConfig["supervisor"]["hosts"];
    semanticSearch?: CraftConfig["semanticSearch"];
    now?: string;
}
export declare function loadConfig(paths?: CraftPaths): Promise<CraftConfig | null>;
export declare function initializeConfig(input: InitInput, paths?: CraftPaths): Promise<CraftConfig>;
export declare function setMode(mode: CraftMode, paths?: CraftPaths, now?: string): Promise<CraftConfig>;
export declare function configureSemanticSearch(semanticSearch: CraftConfig["semanticSearch"] | undefined, paths?: CraftPaths, now?: string): Promise<CraftConfig>;
