import { createHash } from "node:crypto";
import { assertDeliveryEvaluationCurrent, DeliveryEvaluationKernel } from "./delivery-evaluation.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";


function positive(value: unknown, name: string, fallback: number): number { const parsed = value === undefined ? fallback : Number(value); if (![Number.isInteger(parsed), parsed >= 1, parsed <= 100].every(Boolean)) throw new Error(`${name} must be an integer between 1 and 100`); return parsed; }

function independentCanarySamples(store: CraftStore, samples: JsonObject[]): JsonObject[] {
  const sessions = new Set<string>(), tasks = new Set<string>(), sources = new Set<string>(); const accepted: JsonObject[] = [];
  for (const sample of samples) {
    const evidence = typeof sample.evidence_id === "string" ? store.find("evidence", sample.evidence_id) : null;
    const metadata = evidence?.metadata as JsonObject | undefined;
    const session = metadata?.source_session_id, task = metadata?.task_id, source = metadata?.source_ref_digest;
    if (!evidence || evidence.version !== sample.evidence_version || evidence.record_origin === "caller_asserted" || evidence.confidence !== "confirmed"
      || typeof session !== "string" || !session.trim() || typeof task !== "string" || !task.trim() || typeof source !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(source)
      || sessions.has(session) || tasks.has(task) || sources.has(source)) continue;
    sessions.add(session); tasks.add(task); sources.add(source); accepted.push(sample);
  }
  return accepted;
}

export function canaryRoutingEvidenceCurrent(store: CraftStore, candidate: JsonObject): boolean {
  const binding = candidate.routing_evidence as JsonObject | undefined;
  if (!binding || typeof binding.canary_id !== "string" || !Number.isSafeInteger(binding.canary_version) || typeof binding.canary_identity_digest !== "string"
    || !Number.isSafeInteger(binding.min_samples) || Number(binding.min_samples) < 2 || !Array.isArray(binding.sample_refs)) return false;
  const canary = store.find("task_benchmark_canary", binding.canary_id);
  if (!canary || canary.candidate_id !== candidate.id || Number(canary.version) < Number(binding.canary_version) || canary.status !== "running") return false;
  const identity = { candidate_id: canary.candidate_id, candidate_version: canary.candidate_version, baseline_id: canary.baseline_id,
    evaluation_run_id: canary.evaluation_run_id, evaluation_run_version: canary.evaluation_run_version, environment_digest: canary.environment_digest, budget_digest: canary.budget_digest };
  if (canary.identity_digest !== binding.canary_identity_digest || digestJson(identity) !== binding.canary_identity_digest) return false;
  const refs = binding.sample_refs as JsonObject[]; const seen = new Set<string>(); const samples: JsonObject[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref.id !== "string" || seen.has(ref.id) || !Number.isSafeInteger(ref.version)) return false;
    const sample = store.find("task_benchmark_canary_sample", ref.id);
    if (!sample || sample.version !== ref.version || sample.canary_id !== canary.id) return false;
    seen.add(ref.id); samples.push(sample);
  }
  return samples.length >= Number(binding.min_samples) && independentCanarySamples(store, samples).length === samples.length;
}



/** Pairs already-observed Task Runs; it never fabricates a model result or starts a hidden Host. */
export class TaskBenchmarkKernel {
  readonly store: CraftStore; readonly deliveries: DeliveryEvaluationKernel;
  constructor(store: CraftStore, deliveries: DeliveryEvaluationKernel) { this.store = store; this.deliveries = deliveries; }

  create(args: JsonObject): JsonObject {
    const item = this.store.get("delivery_evaluation_case", text(args.case_id, "case_id")); const baseline = this.store.get("task_run", text(args.baseline_task_run_id, "baseline_task_run_id")); const candidate = this.store.get("task_run", text(args.candidate_task_run_id, "candidate_task_run_id"));
    const identity = { case_id: item.id, case_version: item.version, baseline_task_run_id: baseline.id, baseline_task_run_version: baseline.version, candidate_task_run_id: candidate.id, candidate_task_run_version: candidate.version, environment_digest: baseline.environment_digest, budget_digest: baseline.budget_digest, comparable: baseline.environment_digest === candidate.environment_digest && baseline.budget_digest === candidate.budget_digest };
    const benchmarkId = String(args.benchmark_id ?? `task_benchmark_${baseline.id}_${candidate.id}_${item.id}`); const existing = this.store.find("task_benchmark", benchmarkId); const identityDigest = digestJson(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Task Benchmark idempotency conflict"); return { benchmark: existing, idempotent: true }; }
    return { benchmark: this.store.create("task_benchmark", benchmarkId, { ...identity, identity_digest: identityDigest, status: "awaiting_delivery" }), idempotent: false };
  }

  evaluate(args: JsonObject): JsonObject {
    const benchmark = this.store.get("task_benchmark", text(args.benchmark_id, "benchmark_id"));
    if (benchmark.status !== "awaiting_delivery") return { benchmark, pair: this.store.find("task_benchmark_pair", `task_benchmark_pair_${benchmark.id}`), idempotent: true };
    if (benchmark.comparable !== true) return { benchmark: this.save("task_benchmark", benchmark, { status: "inconclusive", reason: "environment_or_budget_mismatch" }), pair: null, idempotent: false };
    const baseline = this.delivery(String(benchmark.baseline_task_run_id)); const candidate = this.delivery(String(benchmark.candidate_task_run_id));
    if (!baseline || !candidate) return { benchmark: this.save("task_benchmark", benchmark, { status: "awaiting_delivery" }), pair: null, idempotent: true };
    const comparison = this.deliveries.compare({ case_id: benchmark.case_id, baseline_delivery_id: baseline.id, candidate_delivery_id: candidate.id, environment_fingerprint: benchmark.environment_digest, budget_fingerprint: benchmark.budget_digest, comparison_id: `task_benchmark_comparison_${benchmark.id}` }).comparison as JsonObject;
    const pairId = `task_benchmark_pair_${benchmark.id}`; const pair = this.store.find("task_benchmark_pair", pairId) ?? this.store.create("task_benchmark_pair", pairId, { benchmark_id: benchmark.id, comparison_id: comparison.id, comparison_version: comparison.version, verdict: comparison.verdict });
    const status = comparison.verdict === "regressed" ? "rejected" : "ready_for_aggregate";
    return { benchmark: this.save("task_benchmark", benchmark, { status, comparison_id: comparison.id, pair_id: pair.id }), pair, idempotent: false };
  }

  aggregate(args: JsonObject): JsonObject {
    const ids = Array.isArray(args.benchmark_ids) && args.benchmark_ids.length ? args.benchmark_ids.map((item) => text(item, "benchmark_ids")) : (() => { throw new Error("benchmark_ids must be a non-empty array"); })();
    const benchmarks = ids.map((item) => this.store.get("task_benchmark", item)); const first = benchmarks[0];
    if (benchmarks.some((item) => item.status !== "ready_for_aggregate" || item.environment_digest !== first.environment_digest || item.budget_digest !== first.budget_digest)) throw new Error("Task Benchmarks must be completed under one environment and budget");
    const items = benchmarks.map((benchmark) => { const comparison = this.store.get("delivery_evaluation_comparison", String(benchmark.comparison_id)); return { case_id: comparison.case_id, baseline_delivery_id: comparison.baseline_delivery_id, candidate_delivery_id: comparison.candidate_delivery_id }; });
    const evaluation = this.deliveries.run({ run_id: args.run_id, environment_fingerprint: first.environment_digest, budget_fingerprint: first.budget_digest, items, min_trials: positive(args.min_trials, "min_trials", 2) }).run as JsonObject;
    return { evaluation, benchmark_ids: ids, eligible_for_candidate: evaluation.status === "eligible_for_signoff" };
  }

  candidatePropose(args: JsonObject): JsonObject {
    const evaluation = this.store.get("delivery_evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    if (evaluation.status !== "eligible_for_signoff") throw new Error("Task Benchmark candidate requires held-out eligible evaluation");
    assertDeliveryEvaluationCurrent(this.store, evaluation);
    const candidateHarness = args.candidate_harness === undefined ? null : text(args.candidate_harness, "candidate_harness");
    const applicabilityTerms = args.applicability_terms === undefined ? [] : terms(args.applicability_terms);
    const identity = { evaluation_run_id: evaluation.id, evaluation_run_version: evaluation.version, summary_digest: digestJson(text(args.summary, "summary")), design_axes: axes(args.candidate_axes), candidate_harness: candidateHarness, applicability_terms: applicabilityTerms };
    const candidateId = String(args.candidate_id ?? `task_benchmark_candidate_${evaluation.id}`); const existing = this.store.find("task_benchmark_candidate", candidateId); const identityDigest = digestJson(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Task Benchmark candidate idempotency conflict"); return { candidate: existing, idempotent: true }; }
    return { candidate: this.store.create("task_benchmark_candidate", candidateId, { ...identity, identity_digest: identityDigest, lifecycle: "draft", publication_allowed: false }), idempotent: false };
  }

  candidateAuthorizeCanary(args: JsonObject): JsonObject {
    const candidate = this.store.get("task_benchmark_candidate", text(args.candidate_id, "candidate_id")); const signoff = this.store.get("signoff", text(args.signoff_id, "signoff_id"));
    if (candidate.lifecycle !== "draft" || signoff.decision !== "passed") throw new Error("Task Benchmark candidate requires a draft and passed Signoff");
    return { candidate: this.save("task_benchmark_candidate", candidate, { lifecycle: "canary_ready", signoff_id: signoff.id, publication_allowed: false }) };
  }

  /** Canary is observation-only: a regression returns an exact baseline reference, never a publication. */
  candidateCanaryStart(args: JsonObject): JsonObject {
    const candidate = this.store.get("task_benchmark_candidate", text(args.candidate_id, "candidate_id"));
    if (candidate.lifecycle !== "canary_ready") throw new Error("Task Benchmark candidate must be canary_ready");
    const evaluation = this.store.get("delivery_evaluation_run", String(candidate.evaluation_run_id));
    if (evaluation.version !== candidate.evaluation_run_version || evaluation.status !== "eligible_for_signoff") throw new Error("Task Benchmark candidate evaluation is no longer eligible");
    assertDeliveryEvaluationCurrent(this.store, evaluation);
    const environmentDigest = digestJson(args.environment ?? {}); const budgetDigest = digestJson(args.budget ?? {});
    if (digestJson([environmentDigest, budgetDigest]) !== digestJson([evaluation.environment, evaluation.budget])) throw new Error("Task Benchmark Canary requires the evaluated environment and budget");
    const identity = { candidate_id: candidate.id, candidate_version: candidate.version, baseline_id: text(args.baseline_id, "baseline_id"), evaluation_run_id: evaluation.id, evaluation_run_version: evaluation.version, environment_digest: environmentDigest, budget_digest: budgetDigest };
    const canaryId = String(args.canary_id ?? `task_benchmark_canary_${candidate.id}`); const existing = this.store.find("task_benchmark_canary", canaryId); const identityDigest = digestJson(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Task Benchmark Canary idempotency conflict"); return { canary: existing, idempotent: true }; }
    return { canary: this.store.create("task_benchmark_canary", canaryId, { ...identity, identity_digest: identityDigest, status: "running", publication_allowed: false }), idempotent: false };
  }

  candidateCanaryObserve(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
    const canary = this.store.get("task_benchmark_canary", text(args.canary_id, "canary_id"));
    const baseline = finite(args.baseline_quality, "baseline_quality"); const candidate = finite(args.candidate_quality, "candidate_quality"); const threshold = finite(args.regression_threshold ?? 0, "regression_threshold");
    if (canary.status === "rolled_back") return { canary, idempotent: true };
    if (canary.status !== "running") throw new Error("Task Benchmark Canary is not running");
    const evidenceId = args.evidence_id === undefined ? null : text(args.evidence_id, "evidence_id"); const evidence = evidenceId ? this.store.get("evidence", evidenceId) : null;
    const sampleIdentity = { canary_id: canary.id, evidence_id: evidenceId, evidence_version: evidence?.version ?? null, baseline_quality: baseline, candidate_quality: candidate, regression_threshold: threshold };
    const sampleId = String(args.sample_id ?? `task_benchmark_canary_sample_${digestJson(sampleIdentity).slice(-16)}`); const existing = this.store.find("task_benchmark_canary_sample", sampleId); const sampleDigest = digestJson(sampleIdentity);
    if (existing) { if (existing.sample_digest !== sampleDigest) throw new Error("Task Benchmark Canary sample idempotency conflict"); return { canary, sample: existing, idempotent: true }; }
    const sample = this.store.create("task_benchmark_canary_sample", sampleId, { ...sampleIdentity, sample_digest: sampleDigest });
    const regressed = candidate < baseline - threshold;
    return { canary: this.save("task_benchmark_canary", canary, { status: regressed ? "rolled_back" : "running", baseline_quality: baseline, candidate_quality: candidate, regression_threshold: threshold, rollback_to: regressed ? canary.baseline_id : null, publication_allowed: false, sample_count: Number(canary.sample_count ?? 0) + 1 }), sample, idempotent: false };
    });
  }

  /** A candidate becomes selectable only after the already-passed Signoff and confirmed Canary samples. */
  candidateCanaryConclude(args: JsonObject): JsonObject {
    const candidate = this.store.get("task_benchmark_candidate", text(args.candidate_id, "candidate_id")); const canary = this.store.get("task_benchmark_canary", text(args.canary_id, "canary_id"));
    const minSamples = positive(args.min_samples, "min_samples", 2); text(args.reviewer, "reviewer");
    if (candidate.lifecycle === "routing_eligible") {
      const evaluation = typeof candidate.evaluation_run_id === "string" ? this.store.find("delivery_evaluation_run", candidate.evaluation_run_id) : null;
      if (!evaluation || evaluation.version !== candidate.evaluation_run_version || evaluation.status !== "eligible_for_signoff" || !canaryRoutingEvidenceCurrent(this.store, candidate)) throw new Error("Task Benchmark candidate routing evidence is no longer eligible");
      assertDeliveryEvaluationCurrent(this.store, evaluation);
      return { candidate, idempotent: true };
    }
    if (candidate.lifecycle !== "canary_ready" || canary.candidate_id !== candidate.id || canary.status !== "running") throw new Error("Task Benchmark candidate requires a non-regressed running Canary");
    const evaluation = this.store.get("delivery_evaluation_run", String(candidate.evaluation_run_id)); if (evaluation.status !== "eligible_for_signoff" || evaluation.version !== candidate.evaluation_run_version) throw new Error("Task Benchmark candidate evaluation is no longer eligible");
    assertDeliveryEvaluationCurrent(this.store, evaluation);
    const samples = this.store.list("task_benchmark_canary_sample", 10_000, (item) => item.canary_id === canary.id && item.evidence_id !== null);
    const accepted = independentCanarySamples(this.store, samples).slice(0, minSamples);
    if (accepted.length < minSamples) throw new Error("Task Benchmark candidate requires enough evidence-backed independent Canary samples");
    return this.store.transaction(() => {
      const currentCanary = this.store.get("task_benchmark_canary", String(canary.id));
      const currentEvaluation = this.store.get("delivery_evaluation_run", String(evaluation.id));
      if (currentCanary.version !== canary.version || currentCanary.status !== "running" || currentEvaluation.version !== evaluation.version || currentEvaluation.status !== "eligible_for_signoff") throw new Error("Task Benchmark Canary or evaluation changed during conclusion");
      assertDeliveryEvaluationCurrent(this.store, currentEvaluation);
      const currentSamples = accepted.map(item => this.store.get("task_benchmark_canary_sample", String(item.id)));
      if (currentSamples.some((item, index) => item.version !== accepted[index]!.version) || independentCanarySamples(this.store, currentSamples).length !== minSamples) throw new Error("Task Benchmark Canary evidence changed during conclusion");
      const saved = this.store.updateIfVersion("task_benchmark_candidate", String(candidate.id), Number(candidate.version), { ...payload(candidate), lifecycle: "routing_eligible", publication_allowed: false, routing_evidence: { canary_id: canary.id, canary_version: canary.version, canary_identity_digest: canary.identity_digest, min_samples: minSamples, sample_ids: accepted.map((item) => item.id).sort(), sample_refs: accepted.map(item => ({ id: item.id, version: item.version })), reviewer: text(args.reviewer, "reviewer") } });
      return { candidate: saved, idempotent: false };
    });
  }

  private delivery(taskRunId: string): JsonObject | null { const run = this.store.get("task_run", taskRunId); const records = this.store.list("work_delivery", 10_000, (item) => item.launch_id === run.launch_id); return records.at(-1) ?? null; }
  private save(kind: string, record: JsonObject, changes: JsonObject): JsonObject { return this.store.save(kind, String(record.id), { ...payload(record), ...changes }); }
}

function finite(value: unknown, name: string): number { const parsed = Number(value); if (![Number.isFinite(parsed), parsed >= 0].every(Boolean)) throw new Error(`${name} must be a non-negative finite number`); return parsed; }
function axes(value: unknown): string[] { const items = text(value, "candidate_axes").split(/[\n,]/).map((item) => item.trim()).filter(Boolean); if (!items.length || items.length > 2 || new Set(items).size !== items.length) throw new Error("candidate_axes must name one or two distinct design axes"); return items; }
function terms(value: unknown): string[] { if (!Array.isArray(value) || !value.length) throw new Error("applicability_terms must be a non-empty array"); const items = value.map((item) => text(item, "applicability_terms").toLowerCase()); if (new Set(items).size !== items.length || items.length > 12) throw new Error("applicability_terms must contain at most 12 unique terms"); return items.sort(); }
