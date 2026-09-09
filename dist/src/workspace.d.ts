import { type Stats } from "node:fs";
import type { CraftPaths } from "./paths.ts";
import { CraftStore, type JsonObject } from "./store.ts";
export declare function snapshotNodeKind(stat: Pick<Stats, "isFile" | "isDirectory">, path: string): "file" | "directory";
export declare class WorkspaceState {
    readonly store: CraftStore;
    readonly paths: CraftPaths;
    constructor(store: CraftStore, paths: CraftPaths);
    open(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    checkpoint(args: JsonObject): JsonObject;
    diff(args: JsonObject): JsonObject;
    humanChange(args: JsonObject): JsonObject;
    restore(args: JsonObject): JsonObject;
    private checkpointFor;
    private checkpoints;
    private changes;
}
