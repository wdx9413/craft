import { CraftStore, type JsonObject } from "./store.ts";
export declare class SandboxKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    profileSave(args: JsonObject): JsonObject;
    profileVerify(args: JsonObject): JsonObject;
    plan(args: JsonObject): JsonObject;
    receipt(args: JsonObject): JsonObject;
}
