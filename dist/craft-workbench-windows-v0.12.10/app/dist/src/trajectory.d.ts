import { CraftStore, type JsonObject } from "./store.ts";
export declare class TrajectoryCompiler {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    compile(args: JsonObject): JsonObject;
    authorize(args: JsonObject): JsonObject;
    private trialIds;
    private operations;
}
