import type { JsonObject } from "./store.ts";
import { ExternalEffectKernel } from "./effects.ts";
import type { RuntimeDriver } from "./runtime-driver.ts";
/**
 * Wrap an `ExternalEffectKernel` so that every dispatch and receipt runs
 * through a `RuntimeDriver`. This is the seam that lets safety, statistics
 * and evaluation live in hooks without rewiring every caller of the
 * underlying kernel.
 *
 * The wrapper preserves the existing kernel's contract:
 *
 * - `prepare` / `start` / `report` / `resolve` / `reconcile*` / `compensate*`
 *   delegate to the inner kernel;
 * - `start` runs the `before_effect` hook chain synchronously (the
 *   built-ins are CPU-only) and refuses to dispatch when a `fail_closed`
 *   hook blocks;
 * - `report` runs `after_receipt` and marks the runtime operation complete;
 * - any thrown error from the inner kernel triggers `on_failure` and the
 *   exception is re-thrown unchanged.
 */
export declare class HookedEffectKernel {
    readonly kernel: ExternalEffectKernel;
    readonly runtime: RuntimeDriver;
    constructor(kernel: ExternalEffectKernel, runtime: RuntimeDriver);
    prepare(args: JsonObject): JsonObject;
    /**
     * Dispatch an external effect. Creates a `runtime_operation` first so
     * the hook chain has a stable id to audit against.
     */
    start(args: JsonObject): JsonObject;
    report(args: JsonObject): JsonObject;
    resolve(args: JsonObject): JsonObject;
    reconcileIssue(args: JsonObject): JsonObject;
    reconcileReport(args: JsonObject): JsonObject;
    reconcileFail(args: JsonObject): JsonObject;
    compensateIssue(args: JsonObject): JsonObject;
    compensateFromExecution(args: JsonObject): JsonObject;
    compensateCancel(args: JsonObject): JsonObject;
    compensateReport(args: JsonObject): JsonObject;
    sagaCreate(args: JsonObject): JsonObject;
    sagaGet(args: JsonObject): JsonObject;
    private allocateOperation;
    private lookupOperation;
    private syntheticOperation;
}
