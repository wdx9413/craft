import { CraftStore, type JsonObject } from "./store.ts";
export declare class MaterializationKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    stage(args: JsonObject): Promise<JsonObject>;
    review(args: JsonObject): JsonObject;
    activate(args: JsonObject): JsonObject;
}
