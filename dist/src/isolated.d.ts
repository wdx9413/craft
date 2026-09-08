import type { JsonObject } from "./store.ts";
export type IsolatedExecution = {
    run_id: string;
    command: string;
    args: string[];
    runtime_root: string;
    command_allowlist: string[];
    path_allowlist: string[];
    effect: string;
    cwd?: string;
    requires_credential?: boolean;
    compensation?: JsonObject | null;
};
type Runner = (request: JsonObject) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
}>;
type Options = {
    platform?: NodeJS.Platform;
    helperAvailable?: (path: string) => boolean;
    runner?: Runner;
};
export declare function runLocalProcess(request: JsonObject): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}>;
export declare class LocalIsolatedAdapter {
    readonly platform: NodeJS.Platform;
    readonly helperAvailable: (path: string) => boolean;
    readonly runner: Runner;
    constructor(options?: Options);
    execute(input: IsolatedExecution): Promise<JsonObject>;
}
export {};
