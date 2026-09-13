import { CraftStore, type JsonObject } from "./store.ts";
export declare class ExternalEffectKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    prepare(args: JsonObject): JsonObject;
    start(args: JsonObject): JsonObject;
    startPlan(args: JsonObject): {
        operation: JsonObject;
        payload: JsonObject;
        dispatch: JsonObject;
        idempotent: boolean;
    };
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
    private sagaState;
}
