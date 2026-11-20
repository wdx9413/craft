import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { EvaluationContractKernel, requiredPairedSampleSize, taskEffectSamplePlanDigest, type TaskEffectSamplePlan } from "craft-common-log/evaluation-contract";
import { digestJson, stableDigest } from "craft-common-base/digest";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { AUTOMATIC_SIGNOFF_POLICY } from "@craft/capability-experience/scenario-evaluation";
import { ExperienceLearningEvaluation } from "@craft/capability-experience/learning-evaluation";

const environment = "sha256:procedure-eval-environment";
const evaluatorKeys = generateKeyPairSync("ed25519");
const evaluator = { id: "procedure-evaluator", version: "1", digest: stableDigest("procedure-evaluator"),
  public_key_pem: evaluatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString() };

function createTask(store: CraftStore, id: string): JsonObject {
  return store.create("task", id, { title: id, goal: id, project_id: null, workspace_id: null, model_id: null, permission_mode: "ask", status: "active" });
}

function createHostSession(store: CraftStore, taskId: string, id: string): JsonObject {
  const traceId = `trace-${id}`, hostId = "codex-cli";
  const identity = { trace_id: traceId, task_id: taskId, host_id: hostId, environment_fingerprint: environment,
    policy_fingerprint: stableDigest("policy"), capability_fingerprint: stableDigest("capabilities"), model_fingerprint: null, budget_fingerprint: null };
  store.create("trace", traceId, { task_id: taskId, status: "running", next_sequence: 0, event_count: 0 });
  let session = store.create("host_session", id, { ...identity, identity_digest: digestJson(identity), status: "running", next_sequence: 0, raw_content_stored: false });
  for (const kind of ["session.started", "session.completed"] as const) {
    const sequence = Number(session.next_sequence) + 1;
    const hostEvent = { session_id: id, sequence, kind, host_id: hostId, action_contract_ref: null, state_before_ref: null,
      state_after_ref: null, artifact_refs: [], evidence_refs: [], summary_digest: null };
    const eventId = `${id}:${sequence}`, eventDigest = digestJson(hostEvent);
    const traceIdentity = { trace_id: traceId, sequence, event_kind: kind, actor: hostId, source: "host_session", trust: "observed",
      span_id: `${traceId}:span:${sequence}`, parent_span_id: null, operation_id: null, action_contract: {}, state_before: {},
      state_after: {}, input_refs: [], output_refs: [], capability_revision: null, policy_revision: null, model_fingerprint: null,
      environment_fingerprint: null, workspace_before: null, workspace_after: null, usage: null, cost_usd: null, duration_ms: null,
      error_class: null, status: null, summary: null, data_digest: stableDigest({ session_id: id, session_sequence: sequence, event_digest: eventDigest }), content_stored: false };
    const traceEvent = store.create("trace_event", `host-session-trace:${eventId}`, { ...traceIdentity, event_digest: stableDigest(traceIdentity) });
    store.create("host_session_event", eventId, { ...hostEvent, event_digest: eventDigest, trace_event_id: traceEvent.id, trace_event_version: traceEvent.version, raw_content_stored: false });
    session = store.save("host_session", id, { ...session, status: kind === "session.completed" ? "terminal" : "running", next_sequence: sequence });
  }
  return session;
}

async function fixture(options: { candidateSuccess?: number; includeRoutes?: boolean; programMemory?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "craft-procedure-contract-promotion-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const previousTrust = process.env.CRAFT_TRUSTED_EVALUATORS;
  process.env.CRAFT_TRUSTED_EVALUATORS = JSON.stringify([evaluator]);
  const service = new CraftService(store);
  if (previousTrust === undefined) delete process.env.CRAFT_TRUSTED_EVALUATORS;
  else process.env.CRAFT_TRUSTED_EVALUATORS = previousTrust;
  store.create("scope_alias", "project-test", { status: "active", scope: { kind: "project", id: "project:test" }, alias_kind: "path", alias: root, alias_digest: stableDigest(root) });
  store.create("evidence", "gate-evidence", { confidence: "confirmed" });
  store.create("workflow_evolution_request", "request", { scenario_key: "inspect", scenario_signature: { project: { id: "project:test" } },
    observation_refs: [{ source: { scope: "project:test" }, evidence_ids: ["gate-evidence"] }], output_contract_ref: "acceptance:inspect" });
  store.create("workflow_evolution_proposal", "proposal", { request_id: "request", request_version: 1, name: "Inspect", description: "Read only inspection", inputs: [], steps: [] });
  store.create("experience_procedure", "procedure-baseline", { content_digest: stableDigest("baseline"), lifecycle: "candidate", routeable: false });
  const kernel = new EvaluationContractKernel(store, [evaluator]);
  const baselineRef = kernel.artifactRef("experience_procedure", "procedure-baseline", 1);
  const developmentTask = createTask(store, "dev-task"), heldOutTask = createTask(store, "held-out-task"), heldOutTask2 = createTask(store, "held-out-task-2");
  const baselineSession = createHostSession(store, String(heldOutTask.id), "held-out-baseline");
  const candidateSession = createHostSession(store, String(heldOutTask.id), "held-out-candidate");
  const baselineSession2 = createHostSession(store, String(heldOutTask2.id), "held-out-baseline-2");
  const candidateSession2 = createHostSession(store, String(heldOutTask2.id), "held-out-candidate-2");
  const devRef = kernel.taskRef(String(developmentTask.id), Number(developmentTask.version));
  const heldOutRef = kernel.taskRef(String(heldOutTask.id), Number(heldOutTask.version));
  const heldOutRef2 = kernel.taskRef(String(heldOutTask2.id), Number(heldOutTask2.version));
  const baselineSessionRef = kernel.hostSessionRef(String(baselineSession.id), Number(baselineSession.version));
  const candidateSessionRef = kernel.hostSessionRef(String(candidateSession.id), Number(candidateSession.version));
  const baselineSessionRef2 = kernel.hostSessionRef(String(baselineSession2.id), Number(baselineSession2.version));
  const candidateSessionRef2 = kernel.hostSessionRef(String(candidateSession2.id), Number(candidateSession2.version));
  const heldOutTaskRefs = [heldOutRef, heldOutRef2];
  const taskSet = { id: "procedure-held-out-v1", development_task_refs: [devRef], held_out_task_refs: heldOutTaskRefs };
  const taskEffectBase = { candidate_family: "experience_procedure", baseline_ref: baselineRef, task_set: { ...taskSet,
      digest: digestJson(taskSet) }, environment_fingerprint: environment, primary_metric: { name: "success_rate", direction: "higher" as const, minimum_delta: 0.1 },
      tolerated_regressions: { failure_rate: 0 }, latency_budget_ms: 100, cost_budget: 2, evaluator, hard_assertions: ["scope_isolation"] };
  const samplePlanUnsigned: TaskEffectSamplePlan = { method: "chebyshev-mean-precision-v1", pilot_pair_count: 5, pilot_paired_difference_variance: 0,
    pilot_report_digest: stableDigest("pilot"), minimum_meaningful_effect: 0.1, confidence_level: 0.95, planned_task_pairs: heldOutTaskRefs.length,
    repeats_per_task: 1, required_pair_count: requiredPairedSampleSize({ pilotVariance: 0, minimumMeaningfulEffect: 0.1, confidenceLevel: 0.95 }), pilot_signature: "pending" };
  const samplePlan = { ...samplePlanUnsigned, pilot_signature: sign(null, Buffer.from(taskEffectSamplePlanDigest(taskEffectBase, samplePlanUnsigned)), evaluatorKeys.privateKey).toString("base64") };
  const scope = { kind: "project", id: "project:test" };
  let programMemory: JsonObject | null = null;
  let procedure: JsonObject;
  if (options.programMemory) {
    const design = kernel.define({ contract_id: "program-memory-design", capability_id: "verify-program-memory", capability_version: 1,
      input_contract: "Project observation", output_contract: "Procedure acceptance and recovery", scope,
      effect: "program_memory_design", budget: { task_effect_design: { ...taskEffectBase, sample_plan: samplePlan } } }).contract as JsonObject;
    const observations = ["source-a", "source-b"].map(id => {
      const evidence = service.evidenceRecord({ source_type: "host_completion_signal", confidence: "bounded", claim: "Verified source task",
        metadata: { provenance: "host_completion_signal", project_scope_id: scope.id, verification_outcome: "passed",
          source_session_id: `session-${id}`, task_id: id, content_stored: false } });
      const observation = service.workflowEvolutionObserve({ sanitized: true, content_stored: false, outcome: "passed", source_kind: "host:codex",
        source_id: id, source_session_id: `session-${id}`, source_digest: id, scope: scope.id, scenario_key: "inspect",
        evidence_ids: [evidence.id] }).observation as JsonObject;
      store.create("program_memory_verified_observation", String(observation.id), { scope, evidence_id: evidence.id, source_digest: id,
        source_session_id: `session-${id}`, task_id: id });
      return observation;
    });
    const candidate = service.evolutionProgramMemoryCapture({ statement: "Inspect project using verified observations", scenario_key: "inspect",
      scope, evaluation_contract_id: design.id, evidence_ids: observations.map(observation => observation.id) });
    programMemory = service.evolutionProgramMemorySubmit({ id: candidate.id, scope });
    procedure = service.experienceProcedureGet({ procedure_id: programMemory.procedure_id }).procedure as JsonObject;
  } else {
    procedure = service.experienceProcedureDraft({ proposal_id: "proposal", procedure_id: "procedure-under-evaluation" }).procedure as JsonObject;
    if (options.includeRoutes) procedure = store.save("experience_procedure", String(procedure.id), { ...procedure, entrypoints: [{ id: "main",
      routes: [{ exit_id: "accepted" }, { exit_id: "review", subscenario_id: "needs-review" }] }] });
  }
  const candidateRef = kernel.artifactRef("experience_procedure", String(procedure.id), Number(procedure.candidate_version ?? procedure.version));
  const contract = kernel.define({ contract_id: "procedure-contract", capability_id: `experience-procedure:${String(procedure.id)}`,
    capability_version: Number(procedure.candidate_version), input_contract: "Procedure scenario and trigger", output_contract: "Procedure acceptance and recovery",
    scope, effect: "task_effect", task_effect: { ...taskEffectBase, candidate_ref: candidateRef, sample_plan: samplePlan } }).contract as JsonObject;
  for (const stage of ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified"] as const) {
    const planId = `plan-${stage}`, assessmentId = `assessment-${stage}`;
    store.create("verification_plan", planId, { change_ref: `procedure-contract:${stage}`, requires_real_host: stage === "host_verified", candidate_change: false });
    store.create("verification_assessment", assessmentId, { verdict: "eligible", verification_id: planId });
    kernel.record({ contract_id: String(contract.id), stage, evidence: [assessmentId] });
  }
  const evaluationInput = { contract_id: String(contract.id), evaluation_id: "procedure-heldout-eval", candidate_ref: candidateRef,
    candidate_source_task_refs: [devRef], evaluator, pairs: [
      { case_ref: heldOutRef, baseline: { session_ref: baselineSessionRef, metrics: { success_rate: 0.5, failure_rate: 0.2 }, latency_ms: 50, cost: 1, assertions: { scope_isolation: true } },
        candidate: { session_ref: candidateSessionRef, metrics: { success_rate: options.candidateSuccess ?? 0.8, failure_rate: 0.2 }, latency_ms: 60, cost: 1.2, assertions: { scope_isolation: true } } },
      { case_ref: heldOutRef2, baseline: { session_ref: baselineSessionRef2, metrics: { success_rate: 0.5, failure_rate: 0.2 }, latency_ms: 50, cost: 1, assertions: { scope_isolation: true } },
        candidate: { session_ref: candidateSessionRef2, metrics: { success_rate: options.candidateSuccess ?? 0.8, failure_rate: 0.2 }, latency_ms: 60, cost: 1.2, assertions: { scope_isolation: true } } },
    ] };
  const receiptDigest = digestJson({ contract_digest: contract.contract_digest, ...evaluationInput });
  kernel.recordTaskEffectEvaluation({ ...evaluationInput, evaluator_signature: sign(null, Buffer.from(receiptDigest), evaluatorKeys.privateKey).toString("base64") });
  kernel.record({ contract_id: String(contract.id), stage: "business_eligible", evidence: [String(evaluationInput.evaluation_id)] });
  return { root, store, service, procedure, programMemory, scope, contract, evaluationId: evaluationInput.evaluation_id, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Program Memory follows the exact signed Experience release and withdraws it on revocation", async () => {
  const f = await fixture({ programMemory: true });
  try {
    const memory = { id: f.programMemory!.id, scope: f.scope };
    const read = () => f.service.evolutionProgramMemoryGet(memory).candidate as JsonObject;
    assert.equal(read().routeable, false);
    let canary: JsonObject | undefined;
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
      const proof = f.service.evidenceRecord({ source_type: "program", claim: "Verified procedure entry and exit", confidence: "confirmed",
        metadata: { procedure_definition_digest: f.procedure.definition_digest, entry_id: "inspect", exit_id: "verified", stage, status: "passed" } });
      canary = f.service.experienceProcedureGate({ procedure_id: f.procedure.id, passed: true, stage, evidence_ids: [proof.id],
        evaluation_contract_id: f.contract.id, evaluation_id: f.evaluationId }).procedure as JsonObject;
    }
    assert.equal(read().active_procedure_version, canary!.version);
    const plan = { procedure_id: f.procedure.id, procedure_version: canary!.version, entry_id: "inspect", exit_id: "verified",
      scope: f.scope.id, program_memory_scope_id: f.scope.id, allowed_effects: ["read_only"], input_refs: {} };
    assert.equal(f.service.experienceProcedurePlan(plan).expanded_step_count, 1);
    assert.equal(f.service.evolutionProgramMemoryPromote({ ...memory, evaluation_ref: f.evaluationId }).status, "promoted");
    assert.equal(f.service.evolutionProgramMemoryFeedback({ ...memory, outcome: "revoked" }).status, "revoked");
    assert.equal(read().routeable, false);
    assert.throws(() => f.service.experienceProcedurePlan(plan), /unavailable|revoked/);
    assert.throws(() => f.service.experienceProcedureGet({ procedure_id: f.procedure.id, release_channel: "current" }), /unavailable/);
  } finally { f.close(); }
});

test("Procedure Service requires and pins a trusted held-out contract before routeability", async () => {
  const f = await fixture();
  try {
    f.service.experienceProcedureGate({ procedure_id: f.procedure.id, stage: "shadow", passed: true, evidence_ids: ["gate-evidence"] });
    assert.throws(() => f.service.experienceProcedureGate({ procedure_id: f.procedure.id, stage: "held_out", passed: true, evidence_ids: ["gate-evidence"] }), /evaluation_contract_id/u);
    assert.throws(() => f.service.experienceProcedureGate({ procedure_id: f.procedure.id, stage: "held_out", passed: true, evidence_ids: ["gate-evidence"],
      evaluation_contract_id: f.contract.id, evaluation_id: "wrong-evaluation" }), /verified and bound/u);
    const qualified = f.service.experienceProcedureGate({ procedure_id: f.procedure.id, stage: "held_out", passed: true, evidence_ids: ["gate-evidence"],
      evaluation_contract_id: f.contract.id, evaluation_id: f.evaluationId });
    assert.equal((qualified.procedure as JsonObject).evaluation_contract_id, f.contract.id);
    assert.equal((qualified.procedure as JsonObject).evaluation_id, f.evaluationId);
    f.service.experienceProcedureGate({ procedure_id: f.procedure.id, stage: "signoff", passed: true, evidence_ids: ["gate-evidence"] });
    const canary = f.service.experienceProcedureGate({ procedure_id: f.procedure.id, stage: "canary", passed: true, evidence_ids: ["gate-evidence"] });
    assert.equal((canary.procedure as JsonObject).routeable, true);
    assert.equal(f.service.experienceProcedureGet({ procedure_id: f.procedure.id, release_channel: "current" }).procedure !== undefined, true);
  } finally { f.close(); }
});

test("Experience Held-out dispatch accepts only the exact trusted paired report and resumes ordered promotion", async () => {
  const f = await fixture();
  try {
    let dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    assert.equal(dispatch.stage, "shadow");
    const shadowEvidence = f.service.evidenceRecord({ evidence_id: "procedure-shadow-evidence", source_type: "program", confidence: "confirmed",
      claim: "Shadow passed.", metadata: { experience_evaluation_dispatch_id: dispatch.id, procedure_id: f.procedure.id,
        procedure_version: dispatch.procedure_version, definition_digest: dispatch.definition_digest, baseline_version: dispatch.baseline_version,
        stage: "shadow", status: "passed", evaluator_ref: "local-shadow-v1", environment_digest: environment,
        evaluation_contract_digest: stableDigest("scenario-contract") } });
    f.store.save("evidence", String(shadowEvidence.id), { ...shadowEvidence, record_origin: "experience_evaluator" });
    const shadowResult = f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [shadowEvidence.id] });
    dispatch = shadowResult.next_dispatch as JsonObject;
    assert.equal(dispatch.stage, "held_out");
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id }), /requires evaluation_contract_id and evaluation_id/u);
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evaluation_contract_id: f.contract.id,
      evaluation_id: "not-the-signed-report" }), /not valid, trusted, and bound/u);
    assert.equal(f.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.experience_evaluation_dispatch_id === dispatch.id).length, 0,
      "an untrusted or misbound report must not create evaluator Evidence");
    const heldResult = f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id,
      evaluation_contract_id: f.contract.id, evaluation_id: f.evaluationId });
    const qualified = heldResult.procedure as JsonObject;
    assert.equal(qualified.evaluation_contract_id, f.contract.id);
    assert.equal(qualified.evaluation_id, f.evaluationId);
    assert.equal((heldResult.next_dispatch as JsonObject).stage, "signoff");
    const heldEvidence = f.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.experience_evaluation_dispatch_id === dispatch.id);
    assert.equal(heldEvidence.length, 1);
    assert.equal((heldEvidence[0]!.metadata as JsonObject).evaluation_contract_id, f.contract.id);
    const replay = f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id,
      evaluation_contract_id: f.contract.id, evaluation_id: f.evaluationId });
    assert.equal(replay.idempotent, true);
    assert.equal(f.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.experience_evaluation_dispatch_id === dispatch.id).length, 1,
      "a retry must reuse its content-free Evidence receipt");
    assert.throws(() => new ExperienceLearningEvaluation(f.store).result({ dispatch_id: dispatch.id,
      evidence_ids: heldEvidence.map(item => item.id), evaluation_contract_id: f.contract.id, evaluation_id: "other-report" }, () => ({})),
    /already resolved with different evidence/u);
    dispatch = heldResult.next_dispatch as JsonObject;
    for (const stage of ["signoff", "canary"]) {
      assert.equal(dispatch.stage, stage);
      const evidence = f.service.evidenceRecord({ evidence_id: `procedure-${stage}-evidence`, source_type: "program", confidence: "confirmed",
        claim: `${stage} passed.`, metadata: { experience_evaluation_dispatch_id: dispatch.id, procedure_id: f.procedure.id,
          procedure_version: dispatch.procedure_version, definition_digest: dispatch.definition_digest, baseline_version: dispatch.baseline_version,
          stage, status: "passed", evaluator_ref: "local-regression-v1", environment_digest: environment,
          ...(stage === "signoff" ? { signoff_policy_ref: AUTOMATIC_SIGNOFF_POLICY } : {}) } });
      f.store.save("evidence", String(evidence.id), { ...evidence, record_origin: "experience_evaluator" });
      const result = f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [evidence.id] });
      if (stage === "signoff") dispatch = result.next_dispatch as JsonObject;
      else assert.equal((result.procedure as JsonObject).routeable, true);
    }
    assert.equal((f.service.experienceProcedureGet({ procedure_id: f.procedure.id, release_channel: "current" }).procedure as JsonObject).routeable, true);
  } finally { f.close(); }
});

test("Held-out reports require a prior Shadow bound to the scenario evaluation contract", async () => {
  const f = await fixture();
  try {
    let dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    const shadow = f.service.evidenceRecord({ evidence_id: "shadow-without-scenario-contract", source_type: "program", confidence: "confirmed",
      claim: "Shadow passed.", metadata: { experience_evaluation_dispatch_id: dispatch.id, procedure_id: f.procedure.id,
        procedure_version: dispatch.procedure_version, definition_digest: dispatch.definition_digest, baseline_version: dispatch.baseline_version,
        stage: "shadow", status: "passed", evaluator_ref: "local-shadow-v1", environment_digest: environment } });
    f.store.save("evidence", String(shadow.id), { ...shadow, record_origin: "experience_evaluator" });
    dispatch = f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [shadow.id] }).next_dispatch as JsonObject;
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id,
      evaluation_contract_id: f.contract.id, evaluation_id: f.evaluationId }), /completed Shadow bound to a pinned scenario evaluation contract/u);
    assert.equal(f.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.experience_evaluation_dispatch_id === dispatch.id).length, 0);
  } finally { f.close(); }
});

test("trusted Held-out evidence is emitted for every composed Procedure route", async () => {
  const f = await fixture({ includeRoutes: true });
  try {
    let dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    const shadowIds = ["accepted", "review"].map(exitId => {
      const shadow = f.service.evidenceRecord({ evidence_id: `route-shadow-${exitId}`, source_type: "program", confidence: "confirmed",
        claim: "Shadow passed.", metadata: { experience_evaluation_dispatch_id: dispatch.id, procedure_id: f.procedure.id,
          procedure_version: dispatch.procedure_version, definition_digest: dispatch.definition_digest,
          procedure_definition_digest: dispatch.definition_digest, baseline_version: dispatch.baseline_version,
          stage: "shadow", status: "passed", evaluator_ref: "local-shadow-v1", environment_digest: environment,
          evaluation_contract_digest: stableDigest("scenario-contract"), entry_id: "main", exit_id: exitId,
          ...(exitId === "review" ? { subscenario_id: "needs-review" } : {}) } });
      f.store.save("evidence", String(shadow.id), { ...shadow, record_origin: "experience_evaluator" });
      return String(shadow.id);
    });
    dispatch = (f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: shadowIds }).next_dispatch as JsonObject);
    const result = f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id,
      evaluation_contract_id: f.contract.id, evaluation_id: f.evaluationId });
    const evidence = f.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.experience_evaluation_dispatch_id === dispatch.id);
    assert.equal((result.dispatch as JsonObject).status, "passed");
    assert.deepEqual(evidence.map(item => [(item.metadata as JsonObject).entry_id, (item.metadata as JsonObject).exit_id]).sort(),
      [["main", "accepted"], ["main", "review"]]);
  } finally { f.close(); }
});

test("a valid but ineligible paired report rejects the candidate without publishing it", async () => {
  const f = await fixture({ candidateSuccess: 0.55 });
  try {
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    const shadow = f.service.evidenceRecord({ evidence_id: "ineligible-shadow-evidence", source_type: "program", confidence: "confirmed",
      claim: "Shadow passed.", metadata: { experience_evaluation_dispatch_id: dispatch.id, procedure_id: f.procedure.id,
        procedure_version: dispatch.procedure_version, definition_digest: dispatch.definition_digest, baseline_version: dispatch.baseline_version,
        stage: "shadow", status: "passed", evaluator_ref: "local-shadow-v1", environment_digest: environment,
        evaluation_contract_digest: stableDigest("scenario-contract") } });
    f.store.save("evidence", String(shadow.id), { ...shadow, record_origin: "experience_evaluator" });
    const held = f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [shadow.id] }).next_dispatch as JsonObject;
    const result = f.service.experienceLearningEvaluationResult({ dispatch_id: held.id,
      evaluation_contract_id: f.contract.id, evaluation_id: f.evaluationId });
    assert.equal((result.dispatch as JsonObject).status, "failed");
    assert.equal((result.procedure as JsonObject).lifecycle, "rejected");
    assert.equal(f.store.find("experience_release", String(f.procedure.id)), null);
  } finally { f.close(); }
});
