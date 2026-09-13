import { CraftStore, type JsonObject } from "./store.ts";
/** v0.12.12's single-agent vertical slice: action authorization is separate from model intent. */
export declare class VerifiedAutonomousWorkKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    prepare(args: JsonObject): JsonObject;
    authorize(args: JsonObject): JsonObject;
    recordAction(args: JsonObject): JsonObject;
    reobserve(args: JsonObject): JsonObject;
    deliver(args: JsonObject): JsonObject;
    resume(args: JsonObject): JsonObject;
    handoff(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
/** Platform claims are admitted only after verifier-attributed conformance. */
export declare class SandboxConformanceKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    save(args: JsonObject): JsonObject;
    admit(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
/** Content-free Trace Explorer projection for user-facing diagnostics. */
export declare class TraceExplorerKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    query(args?: JsonObject): JsonObject;
}
