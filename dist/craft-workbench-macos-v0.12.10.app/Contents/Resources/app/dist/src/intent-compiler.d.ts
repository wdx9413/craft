import { CraftStore, type JsonObject } from "./store.ts";
export type IntentRoute = "simple" | "governed" | "clarification";
export type CoverageMetric = "methods" | "functions" | "lines" | "statements" | "branches" | "all";
export declare class IntentCompilerKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    compile(args: JsonObject): JsonObject;
    acceptanceCompile(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    acceptanceGet(args: JsonObject): JsonObject;
}
