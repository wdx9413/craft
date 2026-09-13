import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Rehydrates a Wiki Context Bundle only while every referenced Claim remains
 * reviewed, current, in scope, unexpired, and byte-for-byte reproducible.
 * It owns no Host policy and never grants execution authority.
 */
export declare class KnowledgeBoundLaunchKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    bind(args: JsonObject): JsonObject;
    revalidate(binding: JsonObject, now?: unknown): JsonObject;
    prompt(binding: JsonObject, prompt: string): string;
    private validate;
}
