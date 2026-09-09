import { type CraftPaths } from "./paths.ts";
import { CraftService } from "./service.ts";
import type { JsonObject } from "./store.ts";
export declare function assertSupervisorOwner(expected: unknown, actual: unknown): void;
export declare class LocalSupervisor {
    #private;
    readonly service: CraftService;
    readonly paths: CraftPaths;
    readonly ownerId: string;
    readonly host: string;
    readonly isProcessAlive: (pid: number) => boolean;
    readonly heartbeatMs: number;
    constructor(service: CraftService, paths: CraftPaths, options?: {
        ownerId?: string;
        host?: string;
        heartbeatMs?: number;
        isProcessAlive?: (pid: number) => boolean;
    });
    private get lockPath();
    private get statePath();
    start(port?: number): Promise<JsonObject>;
    close(): Promise<void>;
    private acquire;
    private heartbeat;
    private release;
}
export declare class SupervisorClient {
    readonly paths: CraftPaths;
    constructor(paths: CraftPaths);
    call(method: "GET" | "POST", path: string, body?: JsonObject): Promise<JsonObject>;
    status(): Promise<JsonObject>;
}
