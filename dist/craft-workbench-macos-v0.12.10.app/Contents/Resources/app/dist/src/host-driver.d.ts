import type { JsonObject } from "./store.ts";
export type HostSandbox = "read-only" | "workspace-write";
export type HostOutputObserver = (event: {
    stream: "stdout" | "stderr";
    bytes: number;
    digest: string;
}) => void;
export interface HostExecutionRequest {
    executable: string;
    argv: string[];
    cwd: string;
    stdin: string;
    timeoutMs: number;
    outputLimit: number;
    signal?: AbortSignal;
    observe?: HostOutputObserver;
}
export interface HostExecutionResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled?: boolean;
    outputLimited: boolean;
}
export type HostExecutor = (request: HostExecutionRequest) => Promise<HostExecutionResult>;
export interface HostDriver {
    readonly host: string;
    /**
     * The dispatch record kind this driver owns. Declaring it here is what lets a
     * new model CLI plug in without editing the service's host branches, so it is
     * required rather than optional.
     */
    readonly dispatchKind: string;
    prepare(args: JsonObject): JsonObject;
    execute(args: JsonObject, options?: {
        signal?: AbortSignal;
        observe?: HostOutputObserver;
    }): Promise<JsonObject>;
}
/**
 * One bounded, cancellable child process with output caps. Every host driver
 * shares it, so sandboxing, output limiting and cancellation behave identically
 * whether the host is Codex, Claude, or a user-declared model CLI.
 */
export declare const executeHostProcess: HostExecutor;
