import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
export type RuntimeTurn = {
    kind: "action";
    action: string;
    args?: JsonObject;
    tokens?: number;
} | {
    kind: "final";
    message: string;
    tokens?: number;
};
export interface RuntimeModel {
    next(input: {
        goal: string;
        history: JsonObject[];
        checkpoint: JsonObject | null;
    }): Promise<RuntimeTurn>;
}
export type RuntimeExecutor = (action: string, args: JsonObject) => Promise<JsonObject>;
export interface RuntimeLimits {
    max_steps: number;
    max_tokens: number;
}
export declare class AutonomousRuntimeKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    prepare(args: JsonObject): JsonObject;
    private current;
    checkpoint(args: JsonObject): JsonObject;
    resume(args: JsonObject): JsonObject;
    run(args: JsonObject, model: RuntimeModel, executor: RuntimeExecutor): Promise<JsonObject>;
    cancel(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
