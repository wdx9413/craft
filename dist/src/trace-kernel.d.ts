import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
/** Current write format. Legacy callers may still import this name. */
export declare const TRACE_SCHEMA_VERSION = "craft.trace";
export declare const LEGACY_TRACE_SCHEMA_VERSION = "craft.trace.v1";
export type TraceStatus = "running" | "completed" | "failed" | "cancelled" | "blocked";
export type TraceTrust = "observed" | "verified" | "human" | "untrusted";
/**
 * The canonical, host-neutral event ledger used by every adapter. Raw prompt
 * and business content is never persisted here; callers provide references,
 * digests and bounded state facts instead.
 */
export declare class TraceKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    start(args: JsonObject): JsonObject;
    append(args: JsonObject): JsonObject;
    observe(args: JsonObject): JsonObject;
    feedback(args: JsonObject): JsonObject;
    finalize(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    query(args?: JsonObject): JsonObject;
    replayBundle(args: JsonObject): JsonObject;
    compileCase(args: JsonObject): JsonObject;
    retentionPlan(args: JsonObject): JsonObject;
    appendTrial(args: JsonObject): JsonObject;
}
