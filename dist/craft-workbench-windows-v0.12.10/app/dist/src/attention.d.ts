import { CraftStore, type JsonObject } from "./store.ts";
/** A derived, non-authoritative projection of work that currently deserves attention. */
export declare class AttentionKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    refresh(args?: JsonObject): JsonObject;
    list(args?: JsonObject): JsonObject;
    decide(args: JsonObject): JsonObject;
    private candidates;
}
