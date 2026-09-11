import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function outcome(store, delivery) { const launch = store.get("work_launch", String(delivery.launch_id)); const value = launch.trial_id ? store.find("outcome", `outcome_${launch.trial_id}`) : null; if (!value)
    throw new Error("Delivery has no Host Outcome"); return value; }
function quality(status) { return status === "accepted" || status === "ready_for_delivery" ? 1 : 0; }
/** Comparable, content-free evaluation bridge for completed Work Deliveries. */
export class DeliveryEvaluationKernel {
    store;
    constructor(store) { this.store = store; }
    caseSave(args) {
        const caseId = text(args.case_id, "case_id");
        const partition = text(args.partition, "partition");
        if (!new Set(["development", "held_out"]).has(partition))
            throw new Error("Evaluation case partition is unsupported");
        const item = { name: text(args.name, "name"), domain: text(args.domain, "domain"), partition, acceptance_contract_ref: text(args.acceptance_contract_ref, "acceptance_contract_ref"), sanitized: args.sanitized === true };
        if (!item.sanitized)
            throw new Error("Evaluation cases must be sanitized");
        if (partition === "held_out" && (typeof args.approved_by !== "string" || !args.approved_by.trim()))
            throw new Error("Held-out case requires independent approval");
        const existing = this.store.find("delivery_evaluation_case", caseId);
        const definitionDigest = digest(item);
        if (existing) {
            if (existing.definition_digest !== definitionDigest)
                throw new Error("Evaluation case idempotency conflict");
            return { case: existing, idempotent: true };
        }
        return { case: this.store.create("delivery_evaluation_case", caseId, { ...item, definition_digest: definitionDigest, approved_by: args.approved_by ?? null }), idempotent: false };
    }
    compare(args) {
        const item = this.store.get("delivery_evaluation_case", text(args.case_id, "case_id"));
        const baseline = this.store.get("work_delivery", text(args.baseline_delivery_id, "baseline_delivery_id"));
        const candidate = this.store.get("work_delivery", text(args.candidate_delivery_id, "candidate_delivery_id"));
        const environment = text(args.environment_fingerprint, "environment_fingerprint");
        const budget = text(args.budget_fingerprint, "budget_fingerprint");
        const baselineOutcome = outcome(this.store, baseline);
        const candidateOutcome = outcome(this.store, candidate);
        const baselineQuality = quality(baseline.status);
        const candidateQuality = quality(candidate.status);
        const identity = { case_id: item.id, case_version: item.version, baseline_delivery_id: baseline.id, baseline_delivery_version: baseline.version, candidate_delivery_id: candidate.id, candidate_delivery_version: candidate.version, environment, budget };
        const comparisonId = String(args.comparison_id ?? `delivery_comparison_${baseline.id}_${candidate.id}_${item.id}`);
        const existing = this.store.find("delivery_evaluation_comparison", comparisonId);
        const comparisonDigest = digest(identity);
        if (existing) {
            if (existing.comparison_digest !== comparisonDigest)
                throw new Error("Delivery comparison idempotency conflict");
            return { comparison: existing, idempotent: true };
        }
        const verdict = candidateQuality > baselineQuality ? "improved" : candidateQuality < baselineQuality ? "regressed" : "equal";
        return { comparison: this.store.create("delivery_evaluation_comparison", comparisonId, { ...identity, comparison_digest: comparisonDigest, partition: item.partition, verdict, baseline: { delivery_status: baseline.status, outcome_verdict: baselineOutcome.verdict, quality: baselineQuality, costs: baselineOutcome.costs }, candidate: { delivery_status: candidate.status, outcome_verdict: candidateOutcome.verdict, quality: candidateQuality, costs: candidateOutcome.costs }, promotion_eligible: false }), idempotent: false };
    }
}
//# sourceMappingURL=delivery-evaluation.js.map