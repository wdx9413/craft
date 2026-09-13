import type { JsonObject } from "./store.ts";
export type ExecutionDecision = {
    tier: "host_read_only" | "isolated_local" | "approval_required" | "blocked";
    autonomous: boolean;
    requires_approval: boolean;
    requires_isolation: boolean;
    reason: string;
};
export declare function decideExecution(input: JsonObject): ExecutionDecision;
