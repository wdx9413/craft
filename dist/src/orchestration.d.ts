import type { JsonObject } from "./store.ts";
export declare const PROVENANCE: Set<string>;
export type PlanNode = JsonObject & {
    id: string;
    depends_on: string[];
    profile_ids: string[];
    profile_versions?: number[];
    status: string;
};
export declare function addCosts(current: JsonObject, addition: JsonObject): JsonObject;
export declare function orchestrationOutcome(nodes: PlanNode[]): JsonObject;
export declare function normalizeNodes(input: unknown[]): PlanNode[];
export declare function planStatus(nodes: PlanNode[]): string;
export declare function dispatchNodes(nodes: PlanNode[], capacity: number, owner: string): {
    nodes: PlanNode[];
    leases: JsonObject[];
};
export declare function submitNode(nodes: PlanNode[], leaseId: string, verdict: string, provenance: string): PlanNode[];
