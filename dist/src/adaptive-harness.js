import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
/** Selects only explicitly routed, evaluated candidates; otherwise returns the declared minimal baseline. */
export class AdaptiveHarnessKernel {
    store;
    constructor(store) { this.store = store; }
    recommend(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const goal = text(args.goal, "goal");
        const baseline = text(args.baseline_harness, "baseline_harness");
        const terms = [...new Set(goal.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
        const candidates = this.store.list("task_benchmark_candidate", 10_000, (item) => item.lifecycle === "routing_eligible" && typeof item.candidate_harness === "string")
            .map((candidate) => ({ candidate, matches: (candidate.applicability_terms ?? []).filter((term) => terms.includes(term.toLowerCase())).length }))
            .filter((item) => item.matches > 0)
            .sort((left, right) => right.matches - left.matches || String(left.candidate.id).localeCompare(String(right.candidate.id)));
        const selected = candidates[0]?.candidate ?? null;
        const identity = { task_id: task.id, task_version: task.version, goal_digest: digest(goal), baseline_harness: baseline, candidate_id: selected?.id ?? null, candidate_version: selected?.version ?? null };
        const recommendationId = String(args.recommendation_id ?? `adaptive_harness_recommendation_${digest(identity).slice(-16)}`);
        const existing = this.store.find("adaptive_harness_recommendation", recommendationId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Adaptive Harness recommendation idempotency conflict");
            return { recommendation: existing, idempotent: true };
        }
        const recommendation = this.store.create("adaptive_harness_recommendation", recommendationId, { ...identity, identity_digest: identityDigest, selected_harness: selected?.candidate_harness ?? baseline, reason: selected ? "evaluated_canary_candidate" : "no_eligible_candidate", execution_authority: false });
        return { recommendation, idempotent: false };
    }
}
//# sourceMappingURL=adaptive-harness.js.map