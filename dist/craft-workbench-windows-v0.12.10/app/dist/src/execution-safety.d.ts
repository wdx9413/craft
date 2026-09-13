import { SandboxKernel } from "./sandbox.ts";
import { CraftStore, type JsonObject } from "./store.ts";
/** Binds a verified sandbox declaration and bounded Host resources to a launch; it does not claim to be an OS sandbox. */
export declare class ExecutionSafetyKernel {
    readonly store: CraftStore;
    readonly sandbox: SandboxKernel;
    constructor(store: CraftStore, sandbox: SandboxKernel);
    preflight(args: JsonObject): JsonObject;
    validate(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    bind(args: JsonObject): JsonObject;
}
