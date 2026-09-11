import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Durable, host-neutral spine for a verified loop.  It stores only immutable
 * references and digests: a Host keeps the prompt/session, Craft keeps the
 * facts required to safely observe, hand off, replay in shadow, or replan.
 */
export declare class ManagedRunKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    create(args: JsonObject): JsonObject;
    observe(args: JsonObject): JsonObject;
    handoff(args: JsonObject): JsonObject;
    resume(args: JsonObject): JsonObject;
    forkShadow(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    private event;
}
