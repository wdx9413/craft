import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { TrustedExperienceEvaluator } from "../core/trusted-experience-evaluator.ts";
import { stableDigest, canonicalJson } from "../core/digest.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ExperienceLearningEvaluation } from "@craft/capability-experience/learning-evaluation";
import { projectExperienceDirectory } from "../core/project-experience-directory.ts";

test("a newer revoked evaluator policy blocks receipts from already-issued requests", () => {
  const root = generateKeyPairSync("ed25519");
  const policyHistory = new Map<number, Record<string, unknown>>([
    [1, { id: "policy-a", version: 1, evaluator_id: "evaluator-a", revoked: false, public_key_pem: root.publicKey.export({ type: "spki", format: "pem" }) }],
    [2, { id: "policy-a", version: 2, evaluator_id: "evaluator-a", revoked: true, public_key_pem: root.publicKey.export({ type: "spki", format: "pem" }) }],
  ]);
  const request = { id: "request-a", policy_id: "policy-a", policy_version: 1, status: "issued" };
  const store = {
    transaction: <T>(work: () => T) => work(),
    get: (kind: string, id: string, version?: number) => {
      assert.equal(kind, "experience_evaluator_request"); assert.equal(id, request.id);
      return request;
    },
    find: (kind: string, id: string) => {
      assert.equal(kind, "experience_evaluator_policy"); assert.equal(id, "policy-a");
      return policyHistory.get(2)!;
    },
    save: () => { throw new Error("revoked receipt must not be persisted"); },
  } as unknown as CraftStore;
  const evaluator = new TrustedExperienceEvaluator(store, String(root.publicKey.export({ type: "spki", format: "pem" })));
  let gateCalled = false;
  assert.throws(() => evaluator.verifyReceipt({ request_id: request.id, signature: "AQ", receipt: {} }, () => {
    gateCalled = true; return {};
  }), /revoked or changed/u);
  assert.equal(gateCalled, false);
});

async function signedShadowFixture(verdict: "passed" | "failed") {
  const root = await mkdtemp(join(tmpdir(), "craft-trusted-experience-evaluation-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const projectRoot = join(root, "project");
  await (await import("node:fs/promises")).mkdir(projectRoot);
  store.create("scope_alias", "test-project-root", { status: "active", scope: { kind: "project", id: "project:test" },
    alias_kind: "path", alias: projectRoot, alias_digest: stableDigest(projectRoot) });
  projectExperienceDirectory(store, "project:test", projectRoot, true);
  const rootKeys = generateKeyPairSync("ed25519"), evaluatorKeys = generateKeyPairSync("ed25519");
  const definition = { kind: "prompt", instruction: "Use the project's verification workflow." };
  const definitionDigest = stableDigest(definition);
  const sourceRefs = [{ kind: "trace", id: "trace-1", version: 1, digest: `sha256:${"b".repeat(64)}` }];
  store.create("experience_procedure", "prompt-work-item", { scope: "project:test", provenance: "explicit_trace_distillation",
    lifecycle: "candidate", routeable: false, version: 1, candidate_version: 1, procedure_kind: "prompt", definition_digest: definitionDigest,
    source_refs: sourceRefs, completed_gates: [] });
  const candidateRef = { kind: "experience_procedure", id: "prompt-work-item", version: 1, digest: definitionDigest };
  const contractDigest = `sha256:${"c".repeat(64)}`;
  store.create("evaluation_contract", "contract-1", { effect: "task_effect", capability_id: "experience-procedure:prompt-work-item",
    capability_version: 1, contract_digest: contractDigest, task_effect: { candidate_family: "experience_procedure", candidate_ref: candidateRef } });
  const evaluation = new ExperienceLearningEvaluation(store);
  evaluation.setEvaluationContractSource(store);
  const item = evaluation.workItems.enqueue({ candidate_ref: candidateRef, scope: "project:test", source_refs: sourceRefs,
    evaluation_contract_ref: { kind: "evaluation_contract", id: "contract-1", version: 1, digest: contractDigest } }).work_item as JsonObject;
  const claim = evaluation.workItems.claimNext({ worker_id: "test-worker" });
  const dispatchResult = evaluation.dispatch({ procedure_id: "prompt-work-item", work_item_id: item.id,
    worker_id: "test-worker", lease_token: claim.lease_token });
  const dispatch = dispatchResult.dispatch as JsonObject;
  const evaluator = new TrustedExperienceEvaluator(store, String(rootKeys.publicKey.export({ type: "spki", format: "pem" })));
  const identity = { id: "signed-adapter", version: "1", digest: `sha256:${"d".repeat(64)}`,
    public_key_pem: evaluatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const policy = evaluator.importRuntimePolicy({ identity, policy_id: "runtime-policy", revision: 1,
    project_ids: ["test"], stages: ["shadow"] }).policy as JsonObject;
  const binding = { evaluation_contract_ref: { kind: "evaluation_contract", id: "contract-1", version: 1, digest: contractDigest },
    evaluation_contract_digest: contractDigest, cases: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}` }],
    candidate_definition: definition, evaluation_case_set_id: "shadow-set", evaluation_budget_digest: `sha256:${"f".repeat(64)}`,
    safety_assertions_digest: `sha256:${"a".repeat(64)}`, safety_assertions: ["No side effects"] };
  const request = evaluator.request({ dispatch_id: String(dispatch.id), policy_id: String(policy.id), evaluation_binding: binding }).request as JsonObject;
  const receipt = { schema: "craft.experience-evaluation-receipt.v1", request_id: request.id, nonce: request.nonce,
    evaluator_id: identity.id, request_digest: request.request_digest, candidate_ref: request.candidate_ref,
    definition_digest: request.definition_digest, evaluation_contract_ref: request.evaluation_contract_ref,
    evaluation_contract_digest: request.evaluation_contract_digest, evaluation_case_set_id: request.evaluation_case_set_id,
    evaluation_case_set_digest: request.evaluation_case_set_digest, evaluation_budget_digest: request.evaluation_budget_digest,
    safety_assertions_digest: request.safety_assertions_digest, baseline_version: request.baseline_version,
    dispatch_identity_digest: request.dispatch_identity_digest, issued_at_ms: Date.now(), environment_digest: `sha256:${"9".repeat(64)}`,
    results: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}`, verdict, evidence_digest: `sha256:${"8".repeat(64)}` }] };
  const signature = sign(null, Buffer.concat([Buffer.from("craft-experience-evaluation-receipt.v1\0"), Buffer.from(canonicalJson(receipt))]), evaluatorKeys.privateKey).toString("base64url");
  const gate = (input: JsonObject) => {
    const gateRecord = store.create("experience_procedure_gate", String(input.gate_id), input);
    const procedure = store.get("experience_procedure", "prompt-work-item");
    const saved = store.save("experience_procedure", String(procedure.id), { ...procedure,
      completed_gates: input.passed === true ? ["shadow"] : [], lifecycle: input.passed === true ? "candidate" : "rejected",
      routeable: false });
    return { gate: gateRecord, procedure: saved };
  };
  return { root, store, evaluator, evaluation, dispatch, request, receipt, signature, gate,
    async close() { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("signed Prompt Shadow receipt advances only its exact Work Item and Gate", async () => {
  const f = await signedShadowFixture("passed");
  try {
    assert.throws(() => f.evaluator.verifyReceipt({ request_id: f.request.id, dispatch_id: "other-dispatch",
      receipt: f.receipt, signature: f.signature }, f.gate), /dispatch does not match/u);
    assert.equal(f.store.get("experience_evaluator_request", String(f.request.id)).status, "issued");
    const result = f.evaluator.verifyReceipt({ request_id: f.request.id, dispatch_id: f.dispatch.id,
      receipt: f.receipt, signature: f.signature }, () =>
      f.evaluation.result({ dispatch_id: f.dispatch.id, evidence_ids: [`experience_external_eval_${stableDigest([f.request.id, f.receipt]).slice(-24)}`] }, f.gate));
    assert.equal((result.result as JsonObject).dispatch && ((result.result as JsonObject).dispatch as JsonObject).status, "passed");
    const item = f.store.find("experience_learning_work_item", String(f.dispatch.learning_work_item_id));
    assert.equal(item?.stage, "held_out");
    assert.equal(item?.status, "queued");
    assert.deepEqual(f.store.get("experience_procedure", "prompt-work-item").completed_gates, ["shadow"]);
    assert.equal(f.store.list("experience_procedure_gate", 10)[0]?.stage, "shadow");
  } finally { await f.close(); }
});

test("signed Prompt Shadow failure records rejection and fails the exact Work Item", async () => {
  const f = await signedShadowFixture("failed");
  try {
    const result = f.evaluator.verifyReceipt({ request_id: f.request.id, dispatch_id: f.dispatch.id,
      receipt: f.receipt, signature: f.signature }, () =>
      f.evaluation.result({ dispatch_id: f.dispatch.id, evidence_ids: [`experience_external_eval_${stableDigest([f.request.id, f.receipt]).slice(-24)}`] }, f.gate));
    assert.equal(((result.result as JsonObject).dispatch as JsonObject).status, "failed");
    const item = f.store.find("experience_learning_work_item", String(f.dispatch.learning_work_item_id));
    assert.equal(item?.stage, "shadow");
    assert.equal(item?.status, "failed");
    assert.equal(item?.failure_reason, "evaluation_gate_failed");
    assert.deepEqual(f.store.get("experience_procedure", "prompt-work-item").completed_gates, []);
    assert.equal(f.store.list("experience_procedure_gate", 10)[0]?.passed, false);
  } finally { await f.close(); }
});
