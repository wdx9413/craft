import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Separates a verified isolation boundary from a human-approved local write.
 * The latter is deliberately useful but never labelled as sandboxed or eligible
 * for unattended execution.
 */
export declare class AutonomyLadderKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    decide(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    private isolated;
    private record;
}
