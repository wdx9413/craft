import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
/** Unified, digest-pinned context plane for one Work Session. */
export declare class ContextPlaneKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    save(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    audit(args: JsonObject): JsonObject;
}
export type ReplayExecutor = (action: string, contract: JsonObject, sequence: number) => Promise<JsonObject>;
/** Revalidation-gated replay runner. It never runs a stale trace. */
export declare class ReplayRunnerKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    prepare(args: JsonObject): JsonObject;
    execute(args: JsonObject, executor?: ReplayExecutor): Promise<JsonObject>;
    get(args: JsonObject): JsonObject;
}
/** Persistent local service lifecycle. A host may call tick from a tray, cron, or OS scheduler. */
export declare class LocalRuntimeServiceKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    configure(args: JsonObject): JsonObject;
    start(args?: JsonObject): JsonObject;
    stop(args?: JsonObject): JsonObject;
    tick(args?: JsonObject): JsonObject;
    get(args?: JsonObject): JsonObject;
}
/** Portable, digest-verified Project Bundle for backup, migration and handoff. */
export declare class ProjectBundleKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    export(args: JsonObject): JsonObject;
    verify(args: JsonObject): JsonObject;
}
/** Records user corrections as bounded learning signals with project scope. */
export declare class FeedbackLearningKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    record(args: JsonObject): JsonObject;
    resolve(args: JsonObject): JsonObject;
}
/** Small domain evaluator registry; actual domain scoring remains user-owned. */
export declare class DomainEvaluatorKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    save(args: JsonObject): JsonObject;
    evaluate(args: JsonObject): JsonObject;
}
/** Host-neutral handoff manifests preserve context, permissions and outcome references. */
export declare class HandoffManifestKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    create(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
/** Provider price snapshots and actual usage attribution. */
export declare class CostLedgerKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    priceSave(args: JsonObject): JsonObject;
    usageRecord(args: JsonObject): JsonObject;
    report(args?: JsonObject): JsonObject;
}
