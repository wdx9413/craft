import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Governs the last mile from an evidence-backed Wiki candidate to a portable,
 * human-imported package. It deliberately has no filesystem or Host execution
 * dependency: delivery is reviewable before an adapter is ever introduced.
 */
export declare class WikiCandidateGovernanceKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    private claimsCurrent;
    private evaluationProof;
    attest(args: JsonObject): JsonObject;
    authorize(args: JsonObject): JsonObject;
    packagePrepare(args: JsonObject): JsonObject;
}
