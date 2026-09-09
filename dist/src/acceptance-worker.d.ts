import { type CraftService } from "./service.ts";
import { type JsonObject } from "./store.ts";
export type AcceptanceEvaluationResult = {
    result: "passed" | "failed" | "blocked";
    summary: string;
    receipt?: JsonObject;
};
export type AcceptanceJobExecutor = (job: JsonObject) => Promise<AcceptanceEvaluationResult>;
/** One cross-platform SDK tick: lease matching work, isolate evaluator failures, and submit attributable receipts. */
export declare function runAcceptanceAdapterTick(service: CraftService, adapterId: string, execute: AcceptanceJobExecutor, options?: {
    limit?: number;
    leaseSeconds?: number;
}): Promise<JsonObject>;
/** Built-in deterministic artifact check shared by documents, media, data, and development outputs. */
export declare function evaluateFileArtifact(job: JsonObject): Promise<AcceptanceEvaluationResult>;
/** Deterministic Istanbul/nyc coverage-summary gate. It reads evidence; it never asks a model to estimate coverage. */
export declare function evaluateCoverageReport(job: JsonObject): Promise<AcceptanceEvaluationResult>;
/** Deterministic ffprobe JSON gate. The probe remains an external tool; Craft validates its structured evidence. */
export declare function evaluateMediaProbeReport(job: JsonObject): Promise<AcceptanceEvaluationResult>;
/** Run every built-in deterministic evaluator without mixing their leases or evidence. */
export declare function runBuiltinAcceptanceTicks(service: CraftService): Promise<JsonObject>;
