import { DeliveryEvaluationKernel } from "./delivery-evaluation.ts";
import { CraftStore, type JsonObject } from "./store.ts";
/** Pairs already-observed Task Runs; it never fabricates a model result or starts a hidden Host. */
export declare class TaskBenchmarkKernel {
    readonly store: CraftStore;
    readonly deliveries: DeliveryEvaluationKernel;
    constructor(store: CraftStore, deliveries: DeliveryEvaluationKernel);
    create(args: JsonObject): JsonObject;
    evaluate(args: JsonObject): JsonObject;
    aggregate(args: JsonObject): JsonObject;
    candidatePropose(args: JsonObject): JsonObject;
    candidateAuthorizeCanary(args: JsonObject): JsonObject;
    /** Canary is observation-only: a regression returns an exact baseline reference, never a publication. */
    candidateCanaryStart(args: JsonObject): JsonObject;
    candidateCanaryObserve(args: JsonObject): JsonObject;
    /** A candidate becomes selectable only after the already-passed Signoff and confirmed Canary samples. */
    candidateCanaryConclude(args: JsonObject): JsonObject;
    private delivery;
    private save;
}
