import { CraftStore, type JsonObject } from "./store.ts";
/** Explicit local import for reviewed packages. It writes one chosen file and never enables a host capability. */
export declare class LocalCandidateImportKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    import(args: JsonObject): Promise<JsonObject>;
    get(args: JsonObject): JsonObject;
}
