import { CraftStore, type JsonObject } from "./store.ts";
import { type HostDriver, type HostExecutionRequest, type HostExecutionResult, type HostExecutor, type HostOutputObserver, type HostSandbox } from "./host-driver.ts";
export type CodexSandbox = HostSandbox;
export type CodexExecutionRequest = HostExecutionRequest;
export type CodexExecutionResult = HostExecutionResult;
export type CodexExecutor = HostExecutor;
export declare const executeCodex: CodexExecutor;
export declare class CodexHostKernel implements HostDriver {
    readonly host = "codex-cli";
    readonly dispatchKind = "codex_dispatch";
    readonly store: CraftStore;
    executor: CodexExecutor;
    constructor(store: CraftStore, executor?: CodexExecutor);
    prepare(args: JsonObject): JsonObject;
    execute(args: JsonObject, options?: {
        signal?: AbortSignal;
        observe?: HostOutputObserver;
    }): Promise<JsonObject>;
}
