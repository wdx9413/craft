import { spawn } from "node:child_process";
import type { JsonObject } from "./store.ts";
import { SecurityBrokerKernel } from "./security.ts";
type WorkerOptions = {
    workerPath?: string;
    timeoutMs?: number;
    spawnProcess?: typeof spawn;
};
export declare function resolveParserWorkerPath(entry?: string, cwd?: string, fileExists?: (path: string) => boolean): string;
export declare function scrubParserEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function runParserWorker(request: JsonObject, options?: WorkerOptions): Promise<JsonObject>;
export declare class ParserProcessAdapter {
    readonly security: SecurityBrokerKernel;
    constructor(security: SecurityBrokerKernel);
    parse(args: JsonObject): Promise<JsonObject>;
}
export {};
