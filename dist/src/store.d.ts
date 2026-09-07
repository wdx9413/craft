import { DatabaseSync } from "node:sqlite";
import { type CraftPaths } from "./paths.ts";
export declare const SCHEMA_VERSION = 2;
export type JsonObject = Record<string, unknown>;
export type SaveEntry = {
    kind: string;
    id: string;
    payload: JsonObject;
    version?: number;
};
export declare class CraftStore {
    #private;
    readonly paths: CraftPaths;
    constructor(paths?: CraftPaths);
    open(): Promise<this>;
    get database(): DatabaseSync;
    transaction<T>(operation: (database: DatabaseSync) => T): T;
    legacyDatabaseDetected(): boolean;
    save(kind: string, id: string, payload: JsonObject, version?: number): JsonObject;
    create(kind: string, id: string, payload: JsonObject): JsonObject;
    saveBatch(entries: SaveEntry[]): JsonObject[];
    updateIfVersion(kind: string, id: string, expectedVersion: number, payload: JsonObject): JsonObject;
    private insert;
    find(kind: string, id: string, version?: number): JsonObject | null;
    get(kind: string, id: string, version?: number): JsonObject;
    list(kind: string, limit?: number, predicate?: (record: JsonObject) => boolean): JsonObject[];
    count(kind: string): number;
    searchCapabilities(terms: string[], limit: number): JsonObject[];
    remove(kind: string, id: string): number;
    appendEvent(stream: string, eventType: string, payload: JsonObject): JsonObject;
    events(stream: string): JsonObject[];
    private record;
    close(): void;
}
