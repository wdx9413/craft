import { CraftStore, type JsonObject } from "./store.ts";
export declare class AutonomyKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    policySave(args: JsonObject): JsonObject;
    request(args: JsonObject): JsonObject;
    decide(args: JsonObject): JsonObject;
    consumptionPlan(args: JsonObject): {
        request: JsonObject;
        existing: JsonObject | null;
        entries: Array<{
            kind: string;
            id: string;
            version?: number;
            payload: JsonObject;
        }>;
    };
    consume(args: JsonObject): JsonObject;
}
