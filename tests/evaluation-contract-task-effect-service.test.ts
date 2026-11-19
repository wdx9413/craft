import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { TraceKernel } from "../core/trace-kernel.ts";
import { HostSessionEventKernel } from "../core/host-session-events.ts";
import { digestJson } from "craft-common-base/digest";
import { EvaluationContractKernel, requiredPairedSampleSize, taskEffectSamplePlanDigest, type TaskEffectSamplePlan } from "craft-common-log/evaluation-contract";
import { CONCEPT_KINDS, RELATION_KINDS } from "craft-common-ontology";
import { ontologyOperatorAuthorizationDigest } from "../core/ontology-operator-authorizer.ts";

const keys = generateKeyPairSync("ed25519");
const globalKeys = generateKeyPairSync("ed25519");
const evaluator = { id: "independent-evaluator", version: "1", digest: digestJson("evaluator"),
  public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
const globalEvaluator = { id: "global-independent-evaluator", version: "1", digest: digestJson("global-evaluator"),
  public_key_pem: globalKeys.publicKey.export({ type: "spki", format: "pem" }).toString() };
const environment = "sha256:codex-linux-node24";
const taskSetId = "software-workflow-v1";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-task-effect-service-"));
  const store = await new CraftStore(craftPaths(join(root, ".craft_data"))).open();
  const previousTrust = process.env.CRAFT_TRUSTED_EVALUATORS;
  process.env.CRAFT_TRUSTED_EVALUATORS = JSON.stringify([evaluator, globalEvaluator]);
  const service = new CraftService(store);
  if (previousTrust === undefined) delete process.env.CRAFT_TRUSTED_EVALUATORS;
  else process.env.CRAFT_TRUSTED_EVALUATORS = previousTrust;
  return { root, store, service, async close() { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("public Craft Service and MCP bind signed paired held-out Host effects before routeability", async () => {
  const f = await fixture();
  try {
    const verifier = new EvaluationContractKernel(f.store);
    const tasks = ["dev-1", "hold-1", "hold-2"].map((id) => f.store.create("task", id, { title: id, status: "completed" }));
    const refs = tasks.map((task) => verifier.taskRef(String(task.id), Number(task.version)));
    const artifacts = ["baseline", "candidate"].map((version) => (f.service.ontologyVersionRegister({ ontology: { version,
      concept_kinds: [...CONCEPT_KINDS], relation_kinds: [...RELATION_KINDS] }, scope: { kind: "project", id: "project-a" } }).ontology as JsonObject));
    const artifactRef = (row: JsonObject) => verifier.artifactRef("ontology_version", String(row.id), Number(row.version));
    const baselineRef = artifactRef(artifacts[0]!); const candidateRef = artifactRef(artifacts[1]!);
    const evaluatorRef = { ...evaluator };
    const taskSet = { id: taskSetId, development_task_refs: [refs[0]], held_out_task_refs: refs.slice(1) };
    const taskEffectBase = {
      candidate_family: "ontology_version", baseline_ref: baselineRef, candidate_ref: candidateRef, cohort_id: "codex-pilot",
      task_set: { ...taskSet, digest: digestJson(taskSet) },
      environment_fingerprint: environment, primary_metric: { name: "task_success_rate", direction: "higher" as const, minimum_delta: 0.1 },
      tolerated_regressions: { rework_rate: 0 }, latency_budget_ms: 120_000, cost_budget: 8, evaluator: evaluatorRef,
      hard_assertions: ["scope_isolation", "no_sensitive_capture"] };
    const unsignedSamplePlan: TaskEffectSamplePlan = { method: "chebyshev-mean-precision-v1", pilot_pair_count: 5, pilot_paired_difference_variance: 0,
      pilot_report_digest: digestJson("pilot"), minimum_meaningful_effect: 0.1, confidence_level: 0.95, planned_task_pairs: refs.slice(1).length,
      repeats_per_task: 1, required_pair_count: requiredPairedSampleSize({ pilotVariance: 0, minimumMeaningfulEffect: 0.1, confidenceLevel: 0.95 }), pilot_signature: "pending" };
    const samplePlan = { ...unsignedSamplePlan, pilot_signature: sign(null, Buffer.from(taskEffectSamplePlanDigest(taskEffectBase, unsignedSamplePlan)), keys.privateKey).toString("base64") };
    const taskEffect = { ...taskEffectBase, sample_plan: samplePlan };
    const defined = f.service.evaluationContractDefine({ contract_id: "codex-effect", capability_id: "craft.ontology.classification", capability_version: 2,
      scope: { kind: "project", id: "project-a" },
      input_contract: "Codex project task context", output_contract: "bounded context receipt and task outcome", effect: "task_effect", task_effect: taskEffect });
    let contract = defined.contract as JsonObject;
    assert.throws(() => f.service.evaluationContractDefine({ contract_id: "self-signed-evaluator", capability_id: "craft-context",
      capability_version: 2, input_contract: "input", output_contract: "output", effect: "task_effect",
      task_effect: { ...taskEffect, evaluator: { ...evaluator, id: "candidate-selected-evaluator" } } }), /not trusted by the Runtime/u);
    const stages = ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified"];
    for (const stage of stages) {
      const id = `assessment-${stage}`;
      f.store.create("verification_plan", `plan-${stage}`, { change_ref: `codex-effect:${stage}`, requires_real_host: stage === "host_verified", candidate_change: false });
      f.store.create("verification_assessment", id, { verdict: "eligible", verification_id: `plan-${stage}` });
      f.service.evaluationContractRecord({ contract_id: contract.id, stage, evidence: [id] });
    }
    const host = new HostSessionEventKernel(f.store, new TraceKernel(f.store));
    const hostRef = (task: JsonObject, suffix: string) => {
      const sessionId = `session-${suffix}`;
      host.open({ session_id: sessionId, task_id: task.id, host_id: "codex", environment_fingerprint: environment,
        policy_fingerprint: "sha256:policy", capability_fingerprint: "sha256:capability" });
      const terminal = host.append({ session_id: sessionId, kind: "session.completed", event_id: `${sessionId}:completed` });
      const session = terminal.session as JsonObject;
      return verifier.hostSessionRef(sessionId, Number(session.version));
    };
    const pairs = refs.slice(1).map((taskRef, index) => {
      const task = tasks[index + 1]!;
      const arm = (suffix: string, success: number) => ({ session_ref: hostRef(task, suffix), metrics: { task_success_rate: success, rework_rate: 0.1 }, latency_ms: 80_000, cost: 5,
        assertions: { scope_isolation: true, no_sensitive_capture: true } });
      return { case_ref: taskRef, baseline: arm(`base-${index}`, 0.5), candidate: arm(`candidate-${index}`, 0.8) };
    });
    const input = { contract_id: contract.id, evaluation_id: "codex-effect-eval", candidate_ref: candidateRef,
      candidate_source_task_refs: [refs[0]], evaluator, pairs };
    const receiptDigest = digestJson({ contract_digest: contract.contract_digest, ...input });
    const signed = { ...input, evaluator_signature: sign(null, Buffer.from(receiptDigest), keys.privateKey).toString("base64") };
    const regressionInput = { ...input, evaluation_id: "codex-effect-regression", pairs: pairs.map((pair) => ({ ...pair,
      candidate: { ...pair.candidate, metrics: { task_success_rate: 0.5, rework_rate: 0.1 } } })) };
    const regressionDigest = digestJson({ contract_digest: contract.contract_digest, ...regressionInput });
    f.service.evaluationContractTaskEffectRecord({ ...regressionInput,
      evaluator_signature: sign(null, Buffer.from(regressionDigest), keys.privateKey).toString("base64") });
    const server = new McpServer(f.service);
    const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "craft_evaluation_contract_task_effect_record", arguments: signed } }) as JsonObject;
    const result = (response.result as JsonObject).structuredContent as JsonObject;
    assert.equal((response.result as JsonObject).isError, false, JSON.stringify(response));
    assert.equal(((result.result as JsonObject).eligible), true);
    f.service.evaluationContractRecord({ contract_id: contract.id, stage: "business_eligible", evidence: ["codex-effect-eval", regressionInput.evaluation_id] });
    const routeable = f.service.evaluationContractRecord({ contract_id: contract.id, stage: "routeable", evidence: ["codex-effect-eval", regressionInput.evaluation_id] });
    assert.equal((routeable as JsonObject).verified_stage, "routeable");
    assert.equal((f.service.evaluationContractGet({ contract_id: contract.id }).routeable), true);
    contract = f.service.evaluationContractGet({ contract_id: contract.id }).contract as JsonObject;
    const claim = f.store.create("knowledge_claim", "ontology-live-claim", { kind: "fact", concept_kind: "fact", content: "Use the evaluated project convention.", scope: "global" });
    f.store.create("ontology_classification_revision", "candidate-classification", { record_id: claim.id, record_digest: digestJson("ontology-live-claim"),
      ontology_version: artifacts[1]!.ontology_version, ontology_digest: artifacts[1]!.ontology_digest, concept_kind: "rule", confidence: 0.99,
      rationale: "Held-out evaluated classification", created_at: "2026-11-19T00:00:00.000Z", previous_revision_id: null,
      previous_classification: { ontology_version: "legacy", concept_kind: "fact", revision_id: null }, source_refs: ["source:reviewed"] });
    const projection = f.service.ontologyClassificationProjectionBuild({ ontology_id: artifacts[1]!.id, scope: { kind: "project", id: "project-a" } }).projection as JsonObject;
    const evaluationContractRef = { kind: "evaluation_contract", id: String(contract.id), version: Number(contract.version), digest: String(contract.contract_digest) };
    const evaluationResultRef = { kind: "task_effect_evaluation", id: "codex-effect-eval",
      version: Number(f.store.get("task_effect_evaluation", "codex-effect-eval").version), digest: String(f.store.get("task_effect_evaluation", "codex-effect-eval").evaluation_digest) };
    const classificationProjectionRef = { kind: "ontology_classification_projection", id: String(projection.id), version: Number(projection.version), digest: String(projection.projection_digest) };
    const shadow = f.service.ontologyActivationSet({ scope: { kind: "project", id: "project-a" }, stage: "shadow", request_id: "codex-shadow",
      candidate_ref: candidateRef, classification_projection_ref: classificationProjectionRef, evaluation_contract_ref: evaluationContractRef,
      evaluation_result_ref: evaluationResultRef });
    assert.equal(shadow.verified, true);
    const shadowRead = f.service.ontologyClassificationGet({ claim_id: claim.id, project_scope_id: "project-a", cohort_id: "codex-pilot" });
    assert.equal((shadowRead.effective_classification as JsonObject).concept_kind, "fact", "shadow never changes query-visible classification");
    assert.equal((shadowRead.activation as JsonObject).status, "compatibility_baseline");

    const globalBaseline = f.service.ontologyVersionRegister({ ontology: { version: "global-baseline", concept_kinds: [...CONCEPT_KINDS], relation_kinds: [...RELATION_KINDS] },
      scope: { kind: "global", id: "craft" } }).ontology as JsonObject;
    const globalOntology = f.service.ontologyVersionRegister({ ontology: { version: "global-candidate", concept_kinds: [...CONCEPT_KINDS], relation_kinds: [...RELATION_KINDS] },
      scope: { kind: "global", id: "craft" } }).ontology as JsonObject;
    const globalProjection = f.service.ontologyClassificationProjectionBuild({ ontology_id: globalOntology.id, scope: { kind: "global", id: "craft" } }).projection as JsonObject;
    const globalContractId = "global-ontology-contract", globalEvaluationId = "global-ontology-report";
    const globalTaskEffectBase = { ...taskEffectBase, baseline_ref: artifactRef(globalBaseline), candidate_ref: artifactRef(globalOntology),
      cohort_id: "global-ontology-pilot", evaluator: globalEvaluator };
    const globalUnsignedSamplePlan: TaskEffectSamplePlan = { ...unsignedSamplePlan, pilot_signature: "pending" };
    const globalSamplePlan = { ...globalUnsignedSamplePlan,
      pilot_signature: sign(null, Buffer.from(taskEffectSamplePlanDigest(globalTaskEffectBase, globalUnsignedSamplePlan)), globalKeys.privateKey).toString("base64") };
    let globalContract = f.service.evaluationContractDefine({ contract_id: globalContractId, capability_id: "craft.ontology.classification", capability_version: 2,
      scope: { kind: "global", id: "craft" }, input_contract: "Global Ontology task context", output_contract: "scoped classification projection",
      effect: "task_effect", task_effect: { ...globalTaskEffectBase, sample_plan: globalSamplePlan } }).contract as JsonObject;
    for (const stage of stages) {
      const id = `global-assessment-${stage}`;
      f.store.create("verification_plan", `global-plan-${stage}`, { change_ref: `${globalContractId}:${stage}`,
        requires_real_host: stage === "host_verified", candidate_change: stage === "routeable" });
      f.store.create("verification_assessment", id, { verdict: "eligible", verification_id: `global-plan-${stage}` });
      f.service.evaluationContractRecord({ contract_id: globalContract.id, stage, evidence: [id] });
    }
    const globalCandidateRef = artifactRef(globalOntology);
    const globalInput = { contract_id: globalContractId, evaluation_id: globalEvaluationId, candidate_ref: globalCandidateRef,
      candidate_source_task_refs: [refs[0]], evaluator: globalEvaluator, pairs };
    const globalReportDigest = digestJson({ contract_digest: globalContract.contract_digest, ...globalInput });
    const globalReport = f.service.evaluationContractTaskEffectRecord({ ...globalInput,
      evaluator_signature: sign(null, Buffer.from(globalReportDigest), globalKeys.privateKey).toString("base64") });
    assert.equal(((globalReport.result as JsonObject).eligible), true);
    f.service.evaluationContractRecord({ contract_id: globalContract.id, stage: "business_eligible", evidence: [globalEvaluationId] });
    f.service.evaluationContractRecord({ contract_id: globalContract.id, stage: "routeable", evidence: [globalEvaluationId] });
    assert.equal(f.service.evaluationContractGet({ contract_id: globalContractId }).routeable, true,
      JSON.stringify(f.service.evaluationContractGet({ contract_id: globalContractId })));
    globalContract = f.service.evaluationContractGet({ contract_id: globalContractId }).contract as JsonObject;
    const globalEvaluation = f.store.get("task_effect_evaluation", globalEvaluationId);
    const savedGlobalFlag = process.env.CRAFT_ONTOLOGY_GLOBAL_ACTIVATION;
    process.env.CRAFT_ONTOLOGY_GLOBAL_ACTIVATION = "enabled";
    let globalPointer: JsonObject;
    try {
      globalPointer = f.service.ontologyActivationSet({ scope: { kind: "global", id: "craft" }, stage: "global", request_id: "codex-global",
        candidate_ref: globalCandidateRef, classification_projection_ref: { kind: "ontology_classification_projection", id: String(globalProjection.id),
          version: Number(globalProjection.version), digest: String(globalProjection.projection_digest) },
        evaluation_contract_ref: { kind: "evaluation_contract", id: globalContractId, version: Number(globalContract.version), digest: String(globalContract.contract_digest) },
        evaluation_result_ref: { kind: "task_effect_evaluation", id: globalEvaluationId, version: Number(globalEvaluation.version), digest: String(globalEvaluation.evaluation_digest) } });
    } finally {
      if (savedGlobalFlag === undefined) delete process.env.CRAFT_ONTOLOGY_GLOBAL_ACTIVATION;
      else process.env.CRAFT_ONTOLOGY_GLOBAL_ACTIVATION = savedGlobalFlag;
    }
    const globalRead = f.service.ontologyClassificationGet({ claim_id: claim.id, project_scope_id: "project-a", cohort_id: "other-cohort" });
    assert.equal((globalRead.activation as JsonObject).selected_stage, "global", "global projection is the fallback when no project cohort pointer matches");
    assert.equal((globalRead.activation as JsonObject).pointer_id, globalPointer.id);
    const pointer = f.service.ontologyActivationSet({ scope: { kind: "project", id: "project-a" }, stage: "small-scope", cohort_id: "codex-pilot",
      request_id: "codex-pilot-activate", candidate_ref: candidateRef, classification_projection_ref: classificationProjectionRef,
      evaluation_contract_ref: evaluationContractRef, evaluation_result_ref: evaluationResultRef });
    assert.equal((f.service.ontologyActivationResolve({ project_scope_id: "project-a", cohort_id: "codex-pilot" }).pointer as JsonObject).id, pointer.id);
    const otherCohortPointer = f.service.ontologyActivationResolve({ project_scope_id: "project-a", cohort_id: "other" });
    assert.equal(otherCohortPointer.status, "active");
    assert.equal((otherCohortPointer.pointer as JsonObject).id, globalPointer.id, "an unrelated project cohort falls back to global activation");
    const projectRead = f.service.ontologyClassificationGet({ claim_id: claim.id, project_scope_id: "project-a", cohort_id: "codex-pilot" });
    assert.equal((projectRead.activation as JsonObject).pointer_id, pointer.id, "the exact project cohort takes priority over the global pointer");
    assert.equal((projectRead.activation as JsonObject).pointer_revision, pointer.pointer_revision);
    assert.deepEqual((projectRead.activation as JsonObject).pointer_ref, { kind: "ontology_activation_pointer", id: pointer.id,
      version: pointer.version, digest: pointer.identity_digest }, "the query returns an exact, replayable activation receipt");
    assert.equal((projectRead.effective_classification as JsonObject).concept_kind, "rule", "the query reads the classification pinned by the active projection");
    const regression = f.service.ontologyActivationFeedback({ active_pointer_id: pointer.id, evaluation_id: regressionInput.evaluation_id });
    assert.equal(regression.status, "regression_rolled_back");
    const rolledBackPointer = f.service.ontologyActivationResolve({ project_scope_id: "project-a", cohort_id: "codex-pilot" });
    assert.equal(rolledBackPointer.status, "active");
    assert.equal((rolledBackPointer.pointer as JsonObject).id, globalPointer.id);
    const rolledBackRead = f.service.ontologyClassificationGet({ claim_id: claim.id, project_scope_id: "project-a", cohort_id: "codex-pilot" });
    assert.equal((rolledBackRead.activation as JsonObject).pointer_id, globalPointer.id, "rollback exposes the prior global fallback");
    assert.equal((rolledBackRead.effective_classification as JsonObject).concept_kind, "fact");
    contract = f.service.evaluationContractGet({ contract_id: contract.id }).contract as JsonObject;
    const reactivated = f.service.ontologyActivationSet({ scope: { kind: "project", id: "project-a" }, stage: "small-scope", cohort_id: "codex-pilot",
      request_id: "codex-pilot-reactivate", candidate_ref: candidateRef, classification_projection_ref: { kind: "ontology_classification_projection",
        id: String(projection.id), version: Number(projection.version), digest: String(projection.projection_digest) }, evaluation_contract_ref: { kind: "evaluation_contract",
        id: String(contract.id), version: Number(contract.version), digest: String(contract.contract_digest) },
      evaluation_result_ref: { kind: "task_effect_evaluation", id: "codex-effect-eval",
        version: Number(f.store.get("task_effect_evaluation", "codex-effect-eval").version), digest: String(f.store.get("task_effect_evaluation", "codex-effect-eval").evaluation_digest) } });
    assert.throws(() => f.service.ontologyActivationRollback({ active_pointer_id: reactivated.id, request_id: "unsigned-rollback", reason: "test" }), /operator_id/u);
    const operatorKeys = generateKeyPairSync("ed25519"), operatorId = "codex-test-operator", control = {
      action: "revoke", actor: operatorId, active_pointer_id: reactivated.id, target_pointer_id: null,
      scope: { kind: "project", id: "project-a" }, stage: "small-scope", cohort_id: "codex-pilot",
      reason: "service acceptance revoke", request_id: "signed-revoke", expected_pointer_revision: reactivated.pointer_revision };
    const authorizationSignature = sign(null, Buffer.from(ontologyOperatorAuthorizationDigest(operatorId, control)), operatorKeys.privateKey).toString("base64");
    const previousOperatorTrust = process.env.CRAFT_ONTOLOGY_TRUSTED_OPERATORS;
    process.env.CRAFT_ONTOLOGY_TRUSTED_OPERATORS = JSON.stringify([{ id: operatorId,
      public_key_pem: operatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString() }]);
    try {
      const revoked = f.service.ontologyActivationRevoke({ active_pointer_id: reactivated.id, request_id: "signed-revoke", reason: "service acceptance revoke",
        operator_id: operatorId, authorization_signature: authorizationSignature });
      assert.equal(revoked.action, "revoke");
      const revokedFallback = f.service.ontologyActivationResolve({ project_scope_id: "project-a", cohort_id: "codex-pilot" });
      assert.equal(revokedFallback.status, "active");
      assert.equal((revokedFallback.pointer as JsonObject).id, globalPointer.id, "revocation restores the global fallback");
    } finally {
      if (previousOperatorTrust === undefined) delete process.env.CRAFT_ONTOLOGY_TRUSTED_OPERATORS;
      else process.env.CRAFT_ONTOLOGY_TRUSTED_OPERATORS = previousOperatorTrust;
    }
    const policyDiff = "--- a/config.toml\n+++ b/config.toml\n@@ -1 +1 @@\n-review = false\n+review = true\n";
    const preparedPolicy = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "craft_host_policy_proposal_prepare", arguments: {
      target: "codex_user_config", scope: { kind: "user", id: "test-user" }, base_digest: `sha256:${"a".repeat(64)}`, diff: policyDiff } } }) as JsonObject;
    assert.equal((preparedPolicy.result as JsonObject).isError, false, JSON.stringify(preparedPolicy));
    const proposal = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "craft_host_policy_proposal_propose", arguments: {
      proposal_id: "codex-policy", target: "codex_user_config", scope: { kind: "user", id: "test-user" }, base_digest: `sha256:${"a".repeat(64)}`,
      proposed_by: "test-user", source_refs: [{ kind: "task", id: "dev-1", version: 1 }],
      diff: policyDiff, evaluation_contract_id: contract.id, evaluation_id: "codex-effect-eval" } } }) as JsonObject;
    assert.equal((proposal.result as JsonObject).isError, true, "an ontology result cannot certify a Host-policy diff");
    assert.match(JSON.stringify(proposal), /routeable exact task-effect Evaluation Contract/u);
    const untrusted = { ...signed, evaluation_id: "unsigned-effect", evaluator_signature: "forged" };
    const rejected = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "craft_evaluation_contract_task_effect_record", arguments: untrusted } }) as JsonObject;
    assert.equal(((rejected.result as JsonObject).isError), true);
    assert.match(JSON.stringify(rejected), /signature is invalid/u);
  } finally { await f.close(); }
});
