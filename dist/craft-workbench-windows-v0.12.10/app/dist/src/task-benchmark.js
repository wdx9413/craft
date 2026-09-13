import { createHash } from "node:crypto";
import { DeliveryEvaluationKernel } from "./delivery-evaluation.js";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function positive(value, name, fallback) { const parsed = value === undefined ? fallback : Number(value); if (![Number.isInteger(parsed), parsed >= 1, parsed <= 100].every(Boolean))
    throw new Error(`${name} must be an integer between 1 and 100`); return parsed; }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
/** Pairs already-observed Task Runs; it never fabricates a model result or starts a hidden Host. */
export class TaskBenchmarkKernel {
    store;
    deliveries;
    constructor(store, deliveries) { this.store = store; this.deliveries = deliveries; }
    create(args) {
        const item = this.store.get("delivery_evaluation_case", text(args.case_id, "case_id"));
        const baseline = this.store.get("task_run", text(args.baseline_task_run_id, "baseline_task_run_id"));
        const candidate = this.store.get("task_run", text(args.candidate_task_run_id, "candidate_task_run_id"));
        const identity = { case_id: item.id, case_version: item.version, baseline_task_run_id: baseline.id, baseline_task_run_version: baseline.version, candidate_task_run_id: candidate.id, candidate_task_run_version: candidate.version, environment_digest: baseline.environment_digest, budget_digest: baseline.budget_digest, comparable: baseline.environment_digest === candidate.environment_digest && baseline.budget_digest === candidate.budget_digest };
        const benchmarkId = String(args.benchmark_id ?? `task_benchmark_${baseline.id}_${candidate.id}_${item.id}`);
        const existing = this.store.find("task_benchmark", benchmarkId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Task Benchmark idempotency conflict");
            return { benchmark: existing, idempotent: true };
        }
        return { benchmark: this.store.create("task_benchmark", benchmarkId, { ...identity, identity_digest: identityDigest, status: "awaiting_delivery" }), idempotent: false };
    }
    evaluate(args) {
        const benchmark = this.store.get("task_benchmark", text(args.benchmark_id, "benchmark_id"));
        if (benchmark.status !== "awaiting_delivery")
            return { benchmark, pair: this.store.find("task_benchmark_pair", `task_benchmark_pair_${benchmark.id}`), idempotent: true };
        if (benchmark.comparable !== true)
            return { benchmark: this.save("task_benchmark", benchmark, { status: "inconclusive", reason: "environment_or_budget_mismatch" }), pair: null, idempotent: false };
        const baseline = this.delivery(String(benchmark.baseline_task_run_id));
        const candidate = this.delivery(String(benchmark.candidate_task_run_id));
        if (!baseline || !candidate)
            return { benchmark: this.save("task_benchmark", benchmark, { status: "awaiting_delivery" }), pair: null, idempotent: true };
        const comparison = this.deliveries.compare({ case_id: benchmark.case_id, baseline_delivery_id: baseline.id, candidate_delivery_id: candidate.id, environment_fingerprint: benchmark.environment_digest, budget_fingerprint: benchmark.budget_digest, comparison_id: `task_benchmark_comparison_${benchmark.id}` }).comparison;
        const pairId = `task_benchmark_pair_${benchmark.id}`;
        const pair = this.store.find("task_benchmark_pair", pairId) ?? this.store.create("task_benchmark_pair", pairId, { benchmark_id: benchmark.id, comparison_id: comparison.id, comparison_version: comparison.version, verdict: comparison.verdict });
        const status = comparison.verdict === "regressed" ? "rejected" : "ready_for_aggregate";
        return { benchmark: this.save("task_benchmark", benchmark, { status, comparison_id: comparison.id, pair_id: pair.id }), pair, idempotent: false };
    }
    aggregate(args) {
        const ids = Array.isArray(args.benchmark_ids) && args.benchmark_ids.length ? args.benchmark_ids.map((item) => text(item, "benchmark_ids")) : (() => { throw new Error("benchmark_ids must be a non-empty array"); })();
        const benchmarks = ids.map((item) => this.store.get("task_benchmark", item));
        const first = benchmarks[0];
        if (benchmarks.some((item) => item.status !== "ready_for_aggregate" || item.environment_digest !== first.environment_digest || item.budget_digest !== first.budget_digest))
            throw new Error("Task Benchmarks must be completed under one environment and budget");
        const items = benchmarks.map((benchmark) => { const comparison = this.store.get("delivery_evaluation_comparison", String(benchmark.comparison_id)); return { case_id: comparison.case_id, baseline_delivery_id: comparison.baseline_delivery_id, candidate_delivery_id: comparison.candidate_delivery_id }; });
        const evaluation = this.deliveries.run({ run_id: args.run_id, environment_fingerprint: first.environment_digest, budget_fingerprint: first.budget_digest, items, min_trials: positive(args.min_trials, "min_trials", 2) }).run;
        return { evaluation, benchmark_ids: ids, eligible_for_candidate: evaluation.status === "eligible_for_signoff" };
    }
    candidatePropose(args) {
        const evaluation = this.store.get("delivery_evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
        if (evaluation.status !== "eligible_for_signoff")
            throw new Error("Task Benchmark candidate requires held-out eligible evaluation");
        const candidateHarness = args.candidate_harness === undefined ? null : text(args.candidate_harness, "candidate_harness");
        const applicabilityTerms = args.applicability_terms === undefined ? [] : terms(args.applicability_terms);
        const identity = { evaluation_run_id: evaluation.id, evaluation_run_version: evaluation.version, summary_digest: digest(text(args.summary, "summary")), design_axes: axes(args.candidate_axes), candidate_harness: candidateHarness, applicability_terms: applicabilityTerms };
        const candidateId = String(args.candidate_id ?? `task_benchmark_candidate_${evaluation.id}`);
        const existing = this.store.find("task_benchmark_candidate", candidateId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Task Benchmark candidate idempotency conflict");
            return { candidate: existing, idempotent: true };
        }
        return { candidate: this.store.create("task_benchmark_candidate", candidateId, { ...identity, identity_digest: identityDigest, lifecycle: "draft", publication_allowed: false }), idempotent: false };
    }
    candidateAuthorizeCanary(args) {
        const candidate = this.store.get("task_benchmark_candidate", text(args.candidate_id, "candidate_id"));
        const signoff = this.store.get("signoff", text(args.signoff_id, "signoff_id"));
        if (candidate.lifecycle !== "draft" || signoff.decision !== "passed")
            throw new Error("Task Benchmark candidate requires a draft and passed Signoff");
        return { candidate: this.save("task_benchmark_candidate", candidate, { lifecycle: "canary_ready", signoff_id: signoff.id, publication_allowed: false }) };
    }
    /** Canary is observation-only: a regression returns an exact baseline reference, never a publication. */
    candidateCanaryStart(args) {
        const candidate = this.store.get("task_benchmark_candidate", text(args.candidate_id, "candidate_id"));
        if (candidate.lifecycle !== "canary_ready")
            throw new Error("Task Benchmark candidate must be canary_ready");
        const evaluation = this.store.get("delivery_evaluation_run", String(candidate.evaluation_run_id));
        const environmentDigest = digest(args.environment ?? {});
        const budgetDigest = digest(args.budget ?? {});
        if (digest([environmentDigest, budgetDigest]) !== digest([evaluation.environment, evaluation.budget]))
            throw new Error("Task Benchmark Canary requires the evaluated environment and budget");
        const identity = { candidate_id: candidate.id, candidate_version: candidate.version, baseline_id: text(args.baseline_id, "baseline_id"), evaluation_run_id: evaluation.id, evaluation_run_version: evaluation.version, environment_digest: environmentDigest, budget_digest: budgetDigest };
        const canaryId = String(args.canary_id ?? `task_benchmark_canary_${candidate.id}`);
        const existing = this.store.find("task_benchmark_canary", canaryId);
        const identityDigest = digest(identity);
        if (existing) {
            if (existing.identity_digest !== identityDigest)
                throw new Error("Task Benchmark Canary idempotency conflict");
            return { canary: existing, idempotent: true };
        }
        return { canary: this.store.create("task_benchmark_canary", canaryId, { ...identity, identity_digest: identityDigest, status: "running", publication_allowed: false }), idempotent: false };
    }
    candidateCanaryObserve(args) {
        const canary = this.store.get("task_benchmark_canary", text(args.canary_id, "canary_id"));
        const baseline = finite(args.baseline_quality, "baseline_quality");
        const candidate = finite(args.candidate_quality, "candidate_quality");
        const threshold = finite(args.regression_threshold ?? 0, "regression_threshold");
        if (canary.status === "rolled_back")
            return { canary, idempotent: true };
        if (canary.status !== "running")
            throw new Error("Task Benchmark Canary is not running");
        const evidenceId = args.evidence_id === undefined ? null : text(args.evidence_id, "evidence_id");
        if (evidenceId)
            this.store.get("evidence", evidenceId);
        const sampleIdentity = { canary_id: canary.id, evidence_id: evidenceId, baseline_quality: baseline, candidate_quality: candidate, regression_threshold: threshold };
        const sampleId = String(args.sample_id ?? `task_benchmark_canary_sample_${digest(sampleIdentity).slice(-16)}`);
        const existing = this.store.find("task_benchmark_canary_sample", sampleId);
        const sampleDigest = digest(sampleIdentity);
        if (existing) {
            if (existing.sample_digest !== sampleDigest)
                throw new Error("Task Benchmark Canary sample idempotency conflict");
            return { canary, sample: existing, idempotent: true };
        }
        const sample = this.store.create("task_benchmark_canary_sample", sampleId, { ...sampleIdentity, sample_digest: sampleDigest });
        const regressed = candidate < baseline - threshold;
        return { canary: this.save("task_benchmark_canary", canary, { status: regressed ? "rolled_back" : "running", baseline_quality: baseline, candidate_quality: candidate, regression_threshold: threshold, rollback_to: regressed ? canary.baseline_id : null, publication_allowed: false, sample_count: Number(canary.sample_count ?? 0) + 1 }), sample, idempotent: false };
    }
    /** A candidate becomes selectable only after the already-passed Signoff and confirmed Canary samples. */
    candidateCanaryConclude(args) {
        const candidate = this.store.get("task_benchmark_candidate", text(args.candidate_id, "candidate_id"));
        const canary = this.store.get("task_benchmark_canary", text(args.canary_id, "canary_id"));
        const minSamples = positive(args.min_samples, "min_samples", 2);
        text(args.reviewer, "reviewer");
        if (candidate.lifecycle === "routing_eligible")
            return { candidate, idempotent: true };
        if (candidate.lifecycle !== "canary_ready" || canary.candidate_id !== candidate.id || canary.status !== "running")
            throw new Error("Task Benchmark candidate requires a non-regressed running Canary");
        const evaluation = this.store.get("delivery_evaluation_run", String(candidate.evaluation_run_id));
        if (evaluation.status !== "eligible_for_signoff")
            throw new Error("Task Benchmark candidate evaluation is no longer eligible");
        const samples = this.store.list("task_benchmark_canary_sample", 10_000, (item) => item.canary_id === canary.id && item.evidence_id !== null);
        if (samples.length < minSamples)
            throw new Error("Task Benchmark candidate requires enough evidence-backed Canary samples");
        const saved = this.save("task_benchmark_candidate", candidate, { lifecycle: "routing_eligible", publication_allowed: false, routing_evidence: { canary_id: canary.id, canary_version: canary.version, sample_ids: samples.map((item) => item.id).sort(), reviewer: text(args.reviewer, "reviewer") } });
        return { candidate: saved, idempotent: false };
    }
    delivery(taskRunId) { const run = this.store.get("task_run", taskRunId); const records = this.store.list("work_delivery", 10_000, (item) => item.launch_id === run.launch_id); return records.at(-1) ?? null; }
    save(kind, record, changes) { return this.store.save(kind, String(record.id), { ...payload(record), ...changes }); }
}
function finite(value, name) { const parsed = Number(value); if (![Number.isFinite(parsed), parsed >= 0].every(Boolean))
    throw new Error(`${name} must be a non-negative finite number`); return parsed; }
function axes(value) { const items = text(value, "candidate_axes").split(/[\n,]/).map((item) => item.trim()).filter(Boolean); if (!items.length || items.length > 2 || new Set(items).size !== items.length)
    throw new Error("candidate_axes must name one or two distinct design axes"); return items; }
function terms(value) { if (!Array.isArray(value) || !value.length)
    throw new Error("applicability_terms must be a non-empty array"); const items = value.map((item) => text(item, "applicability_terms").toLowerCase()); if (new Set(items).size !== items.length || items.length > 12)
    throw new Error("applicability_terms must contain at most 12 unique terms"); return items.sort(); }
//# sourceMappingURL=task-benchmark.js.map