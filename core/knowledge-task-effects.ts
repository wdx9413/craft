import { realpath } from "node:fs/promises";
import { stableDigest } from "./digest.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import type { WorkbenchEvaluations } from "./workbench-evaluations.ts";
import { findClaudeExecutable } from "./infrastructure/claude-executable.ts";
import { findCodexExecutable } from "./infrastructure/codex-executable.ts";
import { evaluationExecutable } from "./evaluation-engine-identity.ts";
import { knowledgeTaskContract } from "./knowledge-task-contract.ts";
import { assessKnowledgeEvaluationProvenance, knowledgeEvaluationAdjudicationVerified, knowledgeEvaluationEvidence, knowledgeEvaluationSourceMatches } from "./knowledge-evaluation-provenance.ts";
import { KNOWLEDGE_TASK_EFFECT_POLICY, knowledgeTaskEffectId } from "./knowledge-task-effect-proof.ts";
import { prepareTaskInput, type CaseResult, type Comparison, type TaskContext } from "craft-eval";
import { createHash } from "node:crypto";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: unknown, b: unknown) => stableDigest(a) === stableDigest(b);
const reject = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
type ControlledEvaluations = Pick<WorkbenchEvaluations, "get" | "inputs" | "report" | "compare">;

/** Craft owns evidence admission. Eval only runs tasks and computes the paired statistics. */
export class KnowledgeTaskEffects {
  readonly store: CraftStore;
  readonly evaluations: ControlledEvaluations;
  private readonly nativeExecutable: (kind: "codex" | "claude") => Promise<string>;
  constructor(store: CraftStore, evaluations: ControlledEvaluations, nativeExecutable = (kind: "codex" | "claude") => evaluationExecutable(kind === "claude" ? findClaudeExecutable() : findCodexExecutable())) {
    this.store = store; this.evaluations = evaluations; this.nativeExecutable = nativeExecutable;
  }

  private material(runId: string) {
    const run = this.store.get("knowledge_evaluation_run", runId);
    reject(run.mode === "candidate_shadow" && run.status === "eligible" && (run.metrics as JsonObject)?.provenance_eligible === true, "Knowledge effect requires an eligible held-out retrieval run");
    const refs = run.candidate_claim_refs as JsonObject[];
    reject(Array.isArray(refs) && refs.length === 1, "Knowledge task effects qualify one exact Claim at a time");
    const ref = refs[0]!, claim = this.store.get("knowledge_claim", String(ref.claim_id));
    const source = this.store.get("knowledge_source", String(claim.source_id));
    reject(claim.status === "candidate" && claim.version === ref.claim_version && claim.identity_digest === ref.identity_digest
      && claim.content_digest === ref.content_digest && typeof claim.content === "string" && claim.content.trim()
      && knowledgeEvaluationSourceMatches(run, claim, source), "Knowledge effect Claim or Source revision is unavailable");
    const caseRefs = run.case_refs as JsonObject[];
    reject(Array.isArray(caseRefs) && caseRefs.length >= 21 && caseRefs.length <= 200 && same(caseRefs.map(ref => ref.case_id), run.case_ids)
      && new Set(caseRefs.map(ref => ref.case_id)).size === caseRefs.length, "Knowledge effect requires 21..200 distinct held-out cases");
    const dependencyMap = new Map<string, JsonObject>();
    const depend = (kind: string, id: unknown) => {
      const value = this.store.find(kind, String(id), undefined, false);
      if (!value) throw new Error("Knowledge effect dependency is unavailable");
      dependencyMap.set(`${kind}:${String(id)}`, { kind, id: value.id, version: value.version, digest: stableDigest(value) });
    };
    depend("knowledge_source", source.id);
    const sessions = new Set<string>(); let positives = 0, negatives = 0;
    const cases = caseRefs.map(ref => {
      const item = this.store.get("knowledge_evaluation_case", String(ref.case_id));
      const evidence = knowledgeEvaluationEvidence(this.store, item);
      reject(item.scope === claim.scope && item.version === ref.case_version && item.identity_digest === ref.identity_digest && same(item.candidate_claim_refs, refs)
        && knowledgeEvaluationAdjudicationVerified(this.store, item)
        && evidence.claimEvidence.every(({ evidence }) => evidence.record_origin !== "caller_asserted" && ["bounded", "confirmed"].includes(String(evidence.confidence))
          && (evidence.metadata as JsonObject | undefined)?.provenance !== "codex_session_program_verification")
        && assessKnowledgeEvaluationProvenance(item, evidence.sourceEvidence, evidence.claimEvidence, true).evaluation_eligible, "Knowledge effect case is not independently adjudicated for this Claim");
      const adjudication = this.store.get("knowledge_evaluation_adjudication", String(item.adjudication_id));
      const contract = knowledgeTaskContract(item.task_contract);
      reject(adjudication.task_contract_digest === stableDigest(contract), "Knowledge task checks were not adjudicated with the independent outcome evidence");
      reject(typeof item.source_session_id === "string" && !sessions.has(item.source_session_id), "Knowledge effect cases must come from distinct independent sessions");
      sessions.add(String(item.source_session_id));
      const expected = item.expected_claim_ids as string[];
      if (expected.length === 1 && expected[0] === claim.id) positives++;
      else { reject(expected.length === 0, "Knowledge effect case labels belong to another Claim"); negatives++; }
      depend("knowledge_evaluation_case", item.id); depend("knowledge_evaluation_adjudication", adjudication.id);
      for (const record of [...evidence.sourceEvidence, ...evidence.claimEvidence.map(entry => entry.evidence)]) depend("evidence", record.id);
      return item;
    });
    reject(positives >= 20 && negatives >= 1, "Knowledge effect requires at least 20 positive tasks and one negative task");
    const text = JSON.stringify({ claim_id: claim.id, claim_version: claim.version, content_digest: claim.content_digest, source_id: source.id, source_version: source.version, source_digest: source.content_digest, content: claim.content });
    reject(Buffer.byteLength(text) <= 64 * 1024, "Knowledge effect context exceeds the bounded input budget");
    const context: TaskContext = { id: `knowledge-effect-${sha(text).slice(0, 32)}`, text };
    return { run, claim, claim_record_digest: stableDigest(this.store.find("knowledge_claim", String(claim.id), undefined, false)), source, cases, context, dependencies: [...dependencyMap.values()] };
  }

  /** Exact Subject.context to use for the candidate; baseline must omit context. */
  context(runId: string): JsonObject {
    const material = this.material(runId);
    return { policy: KNOWLEDGE_TASK_EFFECT_POLICY, context: material.context, retrieval_run_id: runId, retrieval_run_version: material.run.version, case_ids: material.cases.map(item => item.id), knowledge_promotion_authorized: false };
  }

  async assess(runId: string, baselineId: string, candidateId: string): Promise<JsonObject> {
    const material = this.material(runId);
    const records = [this.evaluations.get(baselineId), this.evaluations.get(candidateId)];
    const reports = await Promise.all(records.map(record => this.evaluations.report(String(record.id))));
    const inputs = await Promise.all(records.map(record => this.evaluations.inputs(String(record.id))));
    const left = inputs[0]!, right = inputs[1]!;
    reject(baselineId !== candidateId && records.every(record => record.state === "completed"), "Knowledge effect requires two completed independent runs");
    reject(same(left.suite, right.suite) && left.suite.subject_kind === "agent" && left.suite.partition === "held_out" && left.suite.sanitized === true
      && typeof left.suite.approved_by === "string" && same(left.runtime, right.runtime), "Knowledge effect suites and runtime contracts must match");
    const metrics = left.suite.metrics as JsonObject | undefined, primary = metrics?.primary as JsonObject | undefined;
    reject(primary?.kind === "binary_pass_rate" && primary.direction === "higher_is_better" && Array.isArray(metrics?.guardrails)
      && (metrics!.guardrails as JsonObject[]).some(guardrail => guardrail.metric === "duration_ms" && guardrail.required === true && guardrail.comparator === "lte" && typeof guardrail.threshold === "number" && Number.isFinite(guardrail.threshold) && guardrail.threshold > 0),
    "Knowledge effect requires a binary task metric and an explicit required duration budget");
    const baseline = { ...left.subject }, candidate = { ...right.subject };
    reject(baseline.context === undefined && same(candidate.context, material.context), "Knowledge effect context does not match the exact Claim revision");
    delete baseline.context; delete candidate.context; delete baseline.id; delete candidate.id; delete baseline.version; delete candidate.version;
    reject(same(baseline, candidate) && baseline.kind === "agent" && (!baseline.env || same(baseline.env, {})), "Knowledge effect subjects differ beyond the intended context intervention");
    const host = baseline.host as JsonObject;
    reject(host && ["codex", "claude"].includes(String(host.kind)) && typeof host.binary === "string" && typeof host.model === "string" && host.model !== "default"
      && (!host.args_prefix || same(host.args_prefix, [])) && (!host.env || same(host.env, {})), "Knowledge effect requires a selected native engine and model without wrapper or environment overrides");
    const installed = await this.nativeExecutable(host.kind as "codex" | "claude");
    reject(await realpath(await evaluationExecutable(String(host.binary))) === installed, "Knowledge effect engine is not the locally installed native CLI");
    const engine = records[0]!.execution_engine as JsonObject;
    reject(engine && engine.kind === host.kind && engine.executable === installed && typeof engine.sha256 === "string" && /^[a-f0-9]{64}$/u.test(engine.sha256)
      && typeof engine.environment_digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(engine.environment_digest) && same(engine, records[1]!.execution_engine), "Knowledge effect native execution identities differ or are missing");
    const suiteCases = left.suite.cases as JsonObject[];
    reject(Array.isArray(suiteCases) && same(suiteCases.map(item => item.id), material.cases.map(item => item.id)), "Knowledge effect tasks do not match the exact adjudicated case set");
    const results = reports.map(report => (report.report as { results: CaseResult[] }).results);
    reject(results.every(items => items.length === material.cases.length), "Knowledge effect must contain one trial per independent task");
    let observedModel: string | undefined;
    for (const [index, item] of suiteCases.entries()) {
      const task = material.cases[index]!, contract = knowledgeTaskContract(task.task_contract);
      reject(item.prompt === task.query && same(item.checks, contract.checks) && same(item.safety_checks, contract.safety_checks)
        && item.argv === undefined && item.driver === undefined && item.in_place !== true && item.skill === undefined && item.threshold === undefined,
      "Knowledge task or checks differ from the adjudicated contract");
      reject(typeof (item.timeout_s ?? 30) === "number" && Number(item.timeout_s ?? 30) > 0 && Number(item.timeout_s ?? 30) <= 120, "Knowledge task timeout must fit the 120-second per-task limit");
      const a = results[0]![index]!, b = results[1]![index]!;
      reject(a.case_id === item.id && b.case_id === item.id && a.trial === 1 && b.trial === 1 && a.workspace_snapshot && b.workspace_snapshot
        && same(a.workspace_snapshot, b.workspace_snapshot), "Knowledge effect code snapshots differ or are unavailable");
      for (const [side, result] of [a, b].entries()) {
        reject(same(result.input_receipt, prepareTaskInput(String(task.query), side === 0 ? undefined : material.context).receipt), "Knowledge effect submitted input does not match the intended intervention");
        reject(result.host?.adapter === host.kind && result.host?.requested_model === host.model && result.host?.observed_models.length === 1
          && result.trace_complete && result.issue === null, "Knowledge effect requires observed model identity and completed native traces");
        reject(typeof result.host?.input_tokens === "number" && result.host.input_tokens >= 1 && result.host.input_tokens <= 32_768
          && typeof result.host.output_tokens === "number" && result.host.output_tokens >= 1 && result.host.output_tokens <= 8_192
          && typeof result.duration_ms === "number" && result.duration_ms >= 0 && result.duration_ms <= 120_000,
        "Knowledge effect observed token or duration budget is missing or exceeded");
        const model = result.host!.observed_models[0]!;
        reject(typeof model === "string" && !!model.trim() && model.length <= 256, "Knowledge effect observed model identity is invalid");
        if (observedModel === undefined) observedModel = model;
        reject(model === observedModel, "Knowledge effect observed models changed between tasks or runs");
      }
    }
    const comparisonResult = await this.evaluations.compare(baselineId, candidateId);
    const comparison = (comparisonResult.comparison as JsonObject).metrics as Comparison;
    const reasons: string[] = [];
    if (comparison.status !== "comparable" || !comparison.independent_task_runs || comparison.unmeasured_pairs !== 0) reasons.push("incomplete_or_reused_task_runs");
    if (comparison.one_sided_p === null || comparison.one_sided_p > 0.05 || !(comparison.primary_effect.risk_difference_ci95 && comparison.primary_effect.risk_difference_ci95[0] > 0)) reasons.push("task_gain_not_supported");
    if (results.some(items => items.some(result => result.safety_verdict !== "passed")) || comparison.guardrails.some(guardrail => guardrail.status !== "passed")) reasons.push("safety_or_budget_guardrail_not_passed");
    const negativeIds = new Set(material.cases.filter(item => (item.expected_claim_ids as string[]).length === 0).map(item => item.id));
    if (results[1]!.some(result => negativeIds.has(result.case_id) && result.task_verdict !== "passed")) reasons.push("negative_task_regression");
    const dependencies = [...material.dependencies, ...records.map(record => ({ kind: "workbench_evaluation", id: record.id, version: record.version, digest: stableDigest(record) }))];
    const binding = { policy: KNOWLEDGE_TASK_EFFECT_POLICY, scope: material.claim.scope, claim_id: material.claim.id, retrieval_run_id: runId, retrieval_run_digest: stableDigest(material.run), baseline_id: baselineId, candidate_id: candidateId,
      dependencies, comparison_digest: stableDigest(comparison), observed_model: observedModel, execution_origin: "controlled_paired_host_tasks", status: reasons.length ? "insufficient" : "eligible", reasons };
    // Recheck after filesystem/model comparisons and immediately before writing authority.
    reject(same(this.material(runId), material), "Knowledge effect inputs changed during assessment");
    for (const ref of dependencies) reject(stableDigest(this.store.find(String(ref.kind), String(ref.id), undefined, false)) === ref.digest, "Knowledge effect dependency changed during assessment");
    const id = knowledgeTaskEffectId(material.run);
    const existing = this.store.find("knowledge_task_effect", id);
    if (existing) { reject(same(existing.assessment_digest, stableDigest(binding)), "Knowledge effect run already has a different assessment; create a new retrieval run"); return { assessment: existing, idempotent: true, knowledge_promotion_authorized: false }; }
    let concurrent = false;
    const receipt = await this.store.transactionWithRetry(() => {
      reject(same(this.store.get("knowledge_evaluation_run", runId), material.run)
        && stableDigest(this.store.find("knowledge_claim", String(material.claim.id), undefined, false)) === material.claim_record_digest, "Knowledge effect inputs changed before persistence");
      for (const ref of dependencies) reject(stableDigest(this.store.find(String(ref.kind), String(ref.id), undefined, false)) === ref.digest, "Knowledge effect dependency changed before persistence");
      const current = this.store.find("knowledge_task_effect", id);
      if (current) { reject(current.assessment_digest === stableDigest(binding), "Knowledge effect assessment changed concurrently"); concurrent = true; return current; }
      return this.store.create("knowledge_task_effect", id, { ...binding, assessment_digest: stableDigest(binding), metrics: comparison });
    });
    return { assessment: receipt, idempotent: concurrent, knowledge_promotion_authorized: false };
  }
}
