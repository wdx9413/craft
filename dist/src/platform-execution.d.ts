import { CraftStore, type JsonObject } from "./store.ts";
/** Platform matrix: portable reads, verified boundary required for every write. */
export declare class PlatformExecutionKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    profileSave(args: JsonObject): JsonObject;
    conformanceRecord(args: JsonObject): JsonObject;
    preflight(args: JsonObject): JsonObject;
    validate(args: JsonObject): JsonObject;
    probe(args: JsonObject): JsonObject;
    probeGet(args: JsonObject): JsonObject;
    private conformanceValidate;
}
