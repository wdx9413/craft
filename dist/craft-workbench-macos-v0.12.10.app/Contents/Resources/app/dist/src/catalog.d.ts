import { type EmbeddingProvider, type SemanticStatus } from "./semantic.ts";
import { CraftStore, type JsonObject } from "./store.ts";
export interface SkillDocument {
    name: string;
    description: string;
    version: string;
    body: string;
    metadata: JsonObject;
}
export declare function pathKey(path: string, platform?: NodeJS.Platform): string;
export declare function parseSkill(text: string, fallback: string): SkillDocument;
export declare function skillFiles(root: string, onError?: (path: string, error: unknown) => void): Promise<string[]>;
export declare class Catalog {
    #private;
    readonly store: CraftStore;
    readonly semanticProvider?: EmbeddingProvider;
    constructor(store: CraftStore, semanticProvider?: EmbeddingProvider);
    addSource(path: string, label?: string, scan?: boolean, priority?: number): Promise<JsonObject>;
    listSources(): JsonObject[];
    listLogicalCapabilities(): JsonObject[];
    getSource(id: string): JsonObject;
    updateSource(id: string, enabled?: boolean, label?: string, priority?: number): JsonObject;
    private rebuildLogicalCapabilities;
    removeSource(id: string): JsonObject;
    scanSource(id: string): Promise<JsonObject>;
    scan(sourceId?: string): Promise<JsonObject>;
    search(query: string, limit?: number): JsonObject[];
    semanticStatus(): SemanticStatus;
    searchHybrid(query: string, limit?: number): Promise<JsonObject[]>;
    private capabilityVectors;
    get(assetId: string): JsonObject;
}
