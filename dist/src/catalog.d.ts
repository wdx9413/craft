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
    readonly store: CraftStore;
    constructor(store: CraftStore);
    addSource(path: string, label?: string, scan?: boolean): Promise<JsonObject>;
    listSources(): JsonObject[];
    getSource(id: string): JsonObject;
    updateSource(id: string, enabled?: boolean, label?: string): JsonObject;
    removeSource(id: string): JsonObject;
    scanSource(id: string): Promise<JsonObject>;
    scan(sourceId?: string): Promise<JsonObject>;
    search(query: string, limit?: number): JsonObject[];
    get(assetId: string): JsonObject;
}
