import { CraftStore, type JsonObject } from "./store.ts";
import type { HostDriver, HostExecutionRequest, HostExecutionResult, HostExecutor, HostOutputObserver, HostSandbox } from "./host-driver.ts";
export type CodexSandbox = HostSandbox;
export type CodexExecutionRequest = HostExecutionRequest;
export type CodexExecutionResult = HostExecutionResult;
export type CodexExecutor = HostExecutor;
export declare const executeCodex: CodexExecutor;
export declare class CodexHostKernel implements HostDriver {
    readonly host = "codex-cli";
    readonly store: CraftStore;
    executor: CodexExecutor;
    constructor(store: CraftStore, executor?: CodexExecutor);
    prepare(args: JsonObject): JsonObject;
    execute(args: JsonObject, options?: {
        signal?: AbortSignal;
        observe?: HostOutputObserver;
    }): Promise<JsonObject>;
}
