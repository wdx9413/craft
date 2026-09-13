import type { JsonObject } from "./store.ts";
/**
 * Deterministic workflows are the carrier Craft hands work to, so they live as
 * files first and as records second. A workflow file is the editable source of
 * truth; the registry only discovers, validates, diffs, and advises.
 *
 * Nothing here executes a workflow, and nothing here deletes one: retirement is
 * a recommendation a human confirms, because an unused workflow is not
 * automatically a bad one.
 */
export declare const WORKFLOW_FILE_SUFFIX = ".workflow.json";
export interface WorkflowDescriptor {
    workflow_id: string;
    version: number;
    title: string;
    domain: string | null;
    status: string;
    step_count: number;
    side_effects: string[];
    digest: string;
    path: string;
}
export interface WorkflowUsage {
    workflow_id: string;
    uses: number;
    successes: number;
    last_used_at: string | null;
}
export interface RetirementPolicy {
    min_uses: number;
    stale_days: number;
    min_success_rate: number;
}
export interface RetirementDecision {
    workflow_id: string;
    recommendation: "retire" | "deprecate" | "keep";
    reasons: string[];
    uses: number;
    success_rate: number | null;
    stale: boolean;
}
export declare const DEFAULT_RETIREMENT_POLICY: RetirementPolicy;
/**
 * Validate one workflow document. Steps go through the same `normalizeSteps`
 * used at execution time, so a registry-accepted workflow can never be rejected
 * later for a shape reason.
 */
export declare function normalizeWorkflowDefinition(raw: unknown): JsonObject;
/** A content-addressed descriptor. The digest is what makes catalog drift visible. */
export declare function describeWorkflow(path: string, definition: JsonObject): WorkflowDescriptor;
/** Pure filter that decides whether a path is a workflow file (and not a symlink or directory). */
export declare function isWorkflowFile(name: string, stat: {
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
}): boolean;
/**
 * A JSON parse throws a real Error in practice; the non-Error arm exists only so a
 * host that throws a string cannot crash the registry scan. It is exported as a
 * pure function precisely so both arms stay testable without faking JSON.parse.
 */
export declare function describeJsonFailure(path: string, error: unknown): string;
/**
 * Discover every workflow file under one root. A missing root is an error rather
 * than an empty catalog, because "no workflows" and "wrong path" must not look
 * the same to a caller about to plan work.
 */
export declare function discoverWorkflows(root: string, options?: {
    limit?: number;
}): WorkflowDescriptor[];
/** Catalog drift: what is new, what changed, and what disappeared since the last scan. */
export declare function diffWorkflowCatalog(previous: readonly WorkflowDescriptor[], current: readonly WorkflowDescriptor[]): JsonObject;
/**
 * Deterministic retirement advice. Craft proposes; a human disposes. Every
 * decision carries its reasons so the recommendation can be argued with.
 */
export declare function planWorkflowRetirement(usage: readonly WorkflowUsage[], options: {
    now: string;
    policy?: Partial<RetirementPolicy>;
}): RetirementDecision[];
