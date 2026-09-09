import { spawn } from "node:child_process";
import type { JsonObject } from "./store.ts";
export type DockerResult = {
    code: number;
    stdout: string;
    stderr: string;
    timed_out: boolean;
    output_limited: boolean;
};
export type DockerRunner = (argv: string[], timeoutMs: number, outputLimit: number) => Promise<DockerResult>;
export declare function dockerRequestDigest(image: string, requestedCommand: string[]): string;
export declare function runDocker(argv: string[], timeoutMs: number, outputLimit?: number, spawnProcess?: typeof spawn): Promise<DockerResult>;
export declare class DockerSandboxAdapter {
    readonly runner: DockerRunner;
    constructor(runner?: DockerRunner);
    probe(imageValue: unknown, capabilities: JsonObject): Promise<JsonObject>;
    conformance(probeIdValue: unknown, imageValue: unknown, capabilities: JsonObject, runtimeRootValue: unknown): Promise<JsonObject>;
    execute(args: JsonObject): Promise<JsonObject>;
}
