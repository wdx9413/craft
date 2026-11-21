import { generateKeyPairSync, sign } from "node:crypto";
import { EvaluationContractKernel, requiredPairedSampleSize, taskEffectSamplePlanDigest, type TaskEffectSamplePlan } from "craft-common-log/evaluation-contract";
import { digestJson, stableDigest } from "../../core/digest.ts";
import type { CraftService } from "../../core/service.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import type { ProcedureStore } from "@craft/capability-experience/procedure-projection";

const keys = generateKeyPairSync("ed25519");
const evaluator = { id: "procedure-regression-fixture", version: "1", digest: stableDigest("procedure-regression-fixture"),
  public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
let fixtureSequence = 0;

/** Synthetic effect fixture: exercises the production crypto verifier, never claims measured business benefit. */
export function procedureTaskEffectFixture(service: CraftService, procedure: JsonObject, target: Pick<ProcedureStore, "setEvaluationVerifier"> = service.experienceProcedures, candidateSuccess = 0.8): JsonObject {
  const store = service.store, kernel = new EvaluationContractKernel(store, [evaluator]);
  target.setEvaluationVerifier(kernel);
  Object.defineProperty(service, "evaluationContracts", { configurable: true, value: kernel });
  const prefix = `fixture:${procedure.id}:${procedure.candidate_version ?? procedure.version}:${++fixtureSequence}`;
  const scope = procedure.scope && typeof procedure.scope === "object" ? procedure.scope as JsonObject : { kind: "project", id: String(procedure.scope ?? "project:test") };
  const environment = stableDigest({ fixture: prefix, environment: "isolated-synthetic" });
  const baseline = store.create("experience_procedure", `${prefix}:baseline`, { content_digest: stableDigest(prefix), lifecycle: "candidate", routeable: false });
  const baselineRef = kernel.artifactRef("experience_procedure", String(baseline.id), Number(baseline.version));
  const candidateRef = kernel.artifactRef("experience_procedure", String(procedure.id), Number(procedure.candidate_version ?? procedure.version));
  const task = (name: string) => service.taskOpen({ task_id: `${prefix}:${name}`, title: name, goal: `Synthetic held-out ${name}` }).task as JsonObject;
  const development = task("development"), held = [task("held-one"), task("held-two")];
  const taskRef = (record: JsonObject) => kernel.taskRef(String(record.id), Number(record.version));
  const taskSet = { id: `${prefix}:task-set`, development_task_refs: [taskRef(development)], held_out_task_refs: held.map(taskRef) };
  const base = { candidate_family: "experience_procedure", baseline_ref: baselineRef,
    task_set: { ...taskSet, digest: digestJson(taskSet) }, environment_fingerprint: environment,
    primary_metric: { name: "success_rate", direction: "higher" as const, minimum_delta: 0.1 }, tolerated_regressions: { failure_rate: 0 },
    latency_budget_ms: 100, cost_budget: 2, evaluator, hard_assertions: ["scope_isolation"] };
  const unsigned: TaskEffectSamplePlan = { method: "chebyshev-mean-precision-v1", pilot_pair_count: 5, pilot_paired_difference_variance: 0,
    pilot_report_digest: stableDigest({ synthetic_pilot: prefix }), minimum_meaningful_effect: 0.1, confidence_level: 0.95,
    planned_task_pairs: held.length, repeats_per_task: 1,
    required_pair_count: requiredPairedSampleSize({ pilotVariance: 0, minimumMeaningfulEffect: 0.1, confidenceLevel: 0.95 }), pilot_signature: "pending" };
  const sample = { ...unsigned, pilot_signature: sign(null, Buffer.from(taskEffectSamplePlanDigest(base, unsigned)), keys.privateKey).toString("base64") };
  const contract = kernel.define({ contract_id: `${prefix}:contract`, capability_id: `experience-procedure:${procedure.id}`, capability_version: Number(procedure.candidate_version ?? procedure.version),
    input_contract: "Synthetic regression inputs", output_contract: "Synthetic independent paired acceptance", scope,
    effect: "task_effect", task_effect: { ...base, candidate_ref: candidateRef, sample_plan: sample } }).contract as JsonObject;
  for (const stage of ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified"] as const) {
    const plan = store.create("verification_plan", `${prefix}:${stage}:plan`, { change_ref: `${contract.id}:${stage}`, requires_real_host: stage === "host_verified", candidate_change: false });
    const assessment = store.create("verification_assessment", `${prefix}:${stage}:assessment`, { verdict: "eligible", verification_id: plan.id });
    kernel.record({ contract_id: String(contract.id), stage, evidence: [String(assessment.id)] });
  }
  const sessionRef = (record: JsonObject, variant: string) => {
    const session = service.hostSessionOpen({ session_id: `${prefix}:${record.id}:${variant}`, task_id: record.id, host_id: "fixture-host",
      environment_fingerprint: environment, policy_fingerprint: stableDigest("fixture-policy"), capability_fingerprint: stableDigest("fixture-capability") }).session as JsonObject;
    const completed = service.hostSessionAppend({ session_id: session.id, kind: "session.completed" }).session as JsonObject;
    return kernel.hostSessionRef(String(completed.id), Number(completed.version));
  };
  const input = { contract_id: String(contract.id), evaluation_id: `${prefix}:report`, candidate_ref: candidateRef, candidate_source_task_refs: [taskRef(development)], evaluator,
    pairs: held.map(record => ({ case_ref: taskRef(record), baseline: { session_ref: sessionRef(record, "baseline"), metrics: { success_rate: 0.5, failure_rate: 0.2 }, latency_ms: 50, cost: 1, assertions: { scope_isolation: true } },
      candidate: { session_ref: sessionRef(record, "candidate"), metrics: { success_rate: candidateSuccess, failure_rate: 0.2 }, latency_ms: 60, cost: 1.2, assertions: { scope_isolation: true } } })) };
  const receiptDigest = digestJson({ contract_digest: contract.contract_digest, ...input });
  const report = kernel.recordTaskEffectEvaluation({ ...input, evaluator_signature: sign(null, Buffer.from(receiptDigest), keys.privateKey).toString("base64") });
  if ((report.result as JsonObject).eligible === true) kernel.record({ contract_id: String(contract.id), stage: "business_eligible", evidence: [String(input.evaluation_id)] });
  return { evaluation_contract_id: contract.id, evaluation_id: input.evaluation_id };
}
