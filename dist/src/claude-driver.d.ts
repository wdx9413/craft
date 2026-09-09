import type { HostDriver, HostExecutor, HostOutputObserver } from "./host-driver.ts";
import { CraftStore, type JsonObject } from "./store.ts";
export declare class ClaudeHostKernel implements HostDriver {
    readonly host = "claude-code";
    readonly store: CraftStore;
    executor: HostExecutor;
    constructor(store: CraftStore, executor?: HostExecutor);
    prepare(args: JsonObject): JsonObject;
    execute(args: JsonObject, options?: {
        signal?: AbortSignal;
        observe?: HostOutputObserver;
    }): Promise<JsonObject>;
}
