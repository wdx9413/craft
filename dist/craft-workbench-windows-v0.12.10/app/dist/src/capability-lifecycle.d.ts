import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
export type CapabilityLifecycle = "draft" | "installed" | "active" | "disabled" | "retired";
export declare class CapabilityLifecycleKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    register(args: JsonObject): JsonObject;
    install(args: JsonObject): JsonObject;
    activate(args: JsonObject): JsonObject;
    disable(args: JsonObject): JsonObject;
    upgrade(args: JsonObject): JsonObject;
    retire(args: JsonObject): JsonObject;
    resolve(args: JsonObject): JsonObject;
    list(): JsonObject;
}
