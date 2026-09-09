import type { HostDriver } from "./host-driver.ts";
import { CraftStore, type JsonObject } from "./store.ts";
export declare class HostRunKernel {
    readonly store: CraftStore;
    readonly drivers: Map<string, HostDriver>;
    readonly ownerId: string;
    readonly terminalObserver?: (run: JsonObject, receipt: JsonObject | null) => void;
    private controllers;
    private completions;
    constructor(store: CraftStore, drivers: HostDriver[], ownerId?: string, terminalObserver?: (run: JsonObject, receipt: JsonObject | null) => void);
    private notifyTerminal;
    start(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    cancel(args: JsonObject): JsonObject;
    recover(args: JsonObject): JsonObject;
    wait(runId: string): Promise<void>;
}
