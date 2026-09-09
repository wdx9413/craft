import { type CraftPaths } from "./paths.ts";
import { CraftService } from "./service.ts";
import { type JsonObject } from "./store.ts";
export declare class MaintenanceKernel {
    readonly service: CraftService;
    constructor(service: CraftService);
    tick(args?: JsonObject): JsonObject;
}
type RunOptions = {
    intervalMs?: number;
    maxTicks?: number;
    now?: () => string;
    wait?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
};
export declare class LocalMaintenanceWorker {
    readonly kernel: MaintenanceKernel;
    readonly paths: CraftPaths;
    readonly token: `${string}-${string}-${string}-${string}-${string}`;
    readonly host: string;
    readonly staleAfterMs: number;
    readonly isProcessAlive: (pid: number) => boolean;
    readonly afterTick: (() => Promise<unknown>) | null;
    constructor(kernel: MaintenanceKernel, paths: CraftPaths, options?: {
        host?: string;
        staleAfterMs?: number;
        isProcessAlive?: (pid: number) => boolean;
        afterTick?: () => Promise<unknown>;
    });
    private get lockPath();
    private get statePath();
    run(options?: RunOptions): Promise<JsonObject>;
    status(): Promise<JsonObject>;
    private acquire;
    private heartbeat;
    private reclaimStale;
    private assertSameOwner;
    private release;
}
export {};
