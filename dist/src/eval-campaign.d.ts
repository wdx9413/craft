import { CraftStore, type JsonObject } from "./store.ts";
import { TaskBenchmarkKernel } from "./task-benchmark.ts";
/** Plans Case × Harness × Trial slots. Hosts bind observed runs; this kernel never starts hidden model work. */
export declare class EvalCampaignKernel {
    readonly store: CraftStore;
    readonly benchmarks: TaskBenchmarkKernel;
    constructor(store: CraftStore, benchmarks: TaskBenchmarkKernel);
    create(args: JsonObject): JsonObject;
    bind(args: JsonObject): JsonObject;
    advance(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
    private slots;
}
