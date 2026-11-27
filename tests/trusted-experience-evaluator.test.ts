import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { TrustedExperienceEvaluator } from "../core/trusted-experience-evaluator.ts";
import { stableDigest, canonicalJson } from "../core/digest.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ExperienceLearningEvaluation } from "@craft/capability-experience/learning-evaluation";
import { projectExperienceDirectory } from "../core/project-experience-directory.ts";
import { CraftService } from "../core/service.ts";

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

async function signedShadowFixture(verdict: "passed" | "failed", safetyVerdict: "passed" | "failed" | "missing" = "passed", contractExtra: JsonObject = {}, promptBody?: string, refOverride: JsonObject = {}, procedureExtra: JsonObject = {}) {
  const root = await mkdtemp(join(tmpdir(), "craft-trusted-experience-evaluation-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const projectRoot = join(root, "project");
  await (await import("node:fs/promises")).mkdir(projectRoot);
  store.create("scope_alias", "test-project-root", { status: "active", scope: { kind: "project", id: "project:test" },
    alias_kind: "path", alias: projectRoot, alias_digest: stableDigest(projectRoot) });
  projectExperienceDirectory(store, "project:test", projectRoot, true);
  const rootKeys = generateKeyPairSync("ed25519"), evaluatorKeys = generateKeyPairSync("ed25519");
  const definition = { kind: "prompt", instruction: "Use the project's verification workflow." };
  const scenarioSignature = { domain: "coding" };
  const definitionDigest = promptBody === undefined ? stableDigest(definition) : stableDigest({ body: promptBody, scenario_signature: scenarioSignature });
  const contentRef = promptBody === undefined ? undefined : store.contentStore.writeSync({ kind: "experience", record_id: "prompt-work-item", version: 1,
    scope: "project:test", status: "candidate", sensitivity: "internal", source_id: "fixture", title: "Prompt", body: promptBody, folder: "prompts", frontmatter: {} });
  const sourceRefs = [{ kind: "trace", id: "trace-1", version: 1, digest: `sha256:${"b".repeat(64)}` }];
  store.create("experience_procedure", "prompt-work-item", { scope: "project:test", provenance: "explicit_trace_distillation",
    lifecycle: "candidate", routeable: false, version: 1, candidate_version: 1, procedure_kind: "prompt", definition_digest: definitionDigest,
    source_refs: sourceRefs, completed_gates: [], ...(contentRef ? { content_ref: { ...contentRef, ...refOverride }, content_digest: contentRef.digest, scenario_signature: scenarioSignature } : {}), ...procedureExtra });
  const candidateRef = { kind: "experience_procedure", id: "prompt-work-item", version: 1, digest: definitionDigest };
  const contractDigest = `sha256:${"c".repeat(64)}`;
  store.create("evaluation_contract", "contract-1", { effect: "task_effect", capability_id: "experience-procedure:prompt-work-item",
    capability_version: 1, contract_digest: contractDigest, ...contractExtra,
    task_effect: { candidate_family: "experience_procedure", candidate_ref: candidateRef, ...(contractExtra.task_effect as JsonObject | undefined) } });
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
    candidate_definition: promptBody === undefined ? definition : { body: promptBody, scenario_signature: scenarioSignature }, evaluation_case_set_id: "shadow-set", evaluation_budget_digest: `sha256:${"f".repeat(64)}`,
    safety_assertions_digest: `sha256:${"a".repeat(64)}`, safety_assertions: ["No side effects"] };
  const request = evaluator.request({ request_id: "fixture-evaluation-request", dispatch_id: String(dispatch.id), policy_id: String(policy.id), evaluation_binding: binding }).request as JsonObject;
  const receipt = { schema: "craft.experience-evaluation-receipt.v1", request_id: request.id, nonce: request.nonce,
    evaluator_id: identity.id, request_digest: request.request_digest, candidate_ref: request.candidate_ref,
    definition_digest: request.definition_digest, evaluation_contract_ref: request.evaluation_contract_ref,
    evaluation_contract_digest: request.evaluation_contract_digest, evaluation_case_set_id: request.evaluation_case_set_id,
    evaluation_case_set_digest: request.evaluation_case_set_digest, evaluation_budget_digest: request.evaluation_budget_digest,
    safety_assertions_digest: request.safety_assertions_digest, baseline_version: request.baseline_version,
    dispatch_identity_digest: request.dispatch_identity_digest, issued_at_ms: Date.now(), environment_digest: `sha256:${"9".repeat(64)}`,
    results: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}`, verdict, evidence_digest: `sha256:${"8".repeat(64)}` }],
    ...(safetyVerdict === "missing" ? {} : { safety_results: [{ assertion_digest: stableDigest("No side effects"), verdict: safetyVerdict, evidence_digest: `sha256:${"7".repeat(64)}` }] }) };
  const signature = sign(null, Buffer.concat([Buffer.from("craft-experience-evaluation-receipt.v1\0"), Buffer.from(canonicalJson(receipt))]), evaluatorKeys.privateKey).toString("base64url");
  const gate = (input: JsonObject) => {
    const gateRecord = store.create("experience_procedure_gate", String(input.gate_id), input);
    const procedure = store.get("experience_procedure", "prompt-work-item");
    const saved = store.save("experience_procedure", String(procedure.id), { ...procedure,
      completed_gates: input.passed === true ? ["shadow"] : [], lifecycle: input.passed === true ? "candidate" : "rejected",
      routeable: false });
    return { gate: gateRecord, procedure: saved };
  };
  return { root, store, evaluator, evaluation, dispatch, request, receipt, signature, gate, identity, binding, policy, evaluatorPrivateKey: evaluatorKeys.privateKey, contentRef, leaseToken: claim.lease_token,
    async close() { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("signed Prompt Shadow receipt advances only its exact Work Item and Gate", async () => {
  const f = await signedShadowFixture("passed");
  try {
    assert.throws(() => f.evaluator.verifyReceipt({ request_id: f.request.id, dispatch_id: "other-dispatch",
      receipt: f.receipt, signature: f.signature }, f.gate), /dispatch does not match/u);
    assert.equal(f.store.get("experience_evaluator_request", String(f.request.id)).status, "issued");
    assert.throws(() => f.evaluation.result({ dispatch_id: f.dispatch.id, evidence_ids: [] }, f.gate), /active Work Item lease/u);
    const result = f.evaluator.verifyReceipt({ request_id: f.request.id, dispatch_id: f.dispatch.id,
      receipt: f.receipt, signature: f.signature }, () =>
      f.evaluation.result({ dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken, evidence_ids: [`experience_external_eval_${stableDigest([f.request.id, f.receipt]).slice(-24)}`] }, f.gate));
    assert.equal((result.result as JsonObject).dispatch && ((result.result as JsonObject).dispatch as JsonObject).status, "passed");
    const item = f.store.find("experience_learning_work_item", String(f.dispatch.learning_work_item_id));
    assert.equal(item?.stage, "held_out");
    assert.equal(item?.status, "queued");
    assert.deepEqual(f.store.get("experience_procedure", "prompt-work-item").completed_gates, ["shadow"]);
    assert.equal(f.store.list("experience_procedure_gate", 10)[0]?.stage, "shadow");
  } finally { await f.close(); }
});

test("trusted Prompt evaluation requires the active lease and a configured evaluation owner", async () => {
  const f = await signedShadowFixture("passed");
  try {
    const service = new CraftService(f.store);
    const input = { dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken };
    const initialStatus = f.store.get("experience_evaluation_dispatch", String(f.dispatch.id)).status;
    assert.throws(() => service.experienceLearningEvaluationRun({ ...input, lease_token: "wrong" }), /active Work Item lease/u);
    const result = service.experienceLearningEvaluationRun(input);
    assert.equal(result.status, "awaiting_adapter");
    assert.equal(result.reason, "experience_evaluation_owner_unavailable");
    assert.equal(f.store.get("experience_evaluation_dispatch", String(f.dispatch.id)).status, initialStatus);
    Object.defineProperty(service, "storageOwner", { value: "eval", configurable: true });
    const selfOwned = service.experienceLearningEvaluationRun(input);
    assert.equal(selfOwned.status, "awaiting_adapter");
    assert.equal(selfOwned.reason, "experience_evaluation_case_manifest_unavailable");
  } finally { await f.close(); }
});

test("runtime evaluator policies reject invalid scopes and revision conflicts without changing the trusted policy", async () => {
  const f = await signedShadowFixture("passed");
  try {
    const key = generateKeyPairSync("ed25519");
    const identity = { id: "scoped-adapter", version: "1", digest: `sha256:${"d".repeat(64)}`,
      public_key_pem: key.publicKey.export({ type: "spki", format: "pem" }).toString() };
    const input = { identity, policy_id: "scoped-policy", revision: 1, project_ids: ["test"], stages: ["shadow"] };
    assert.throws(() => f.evaluator.importRuntimePolicy({ ...input, project_ids: [] }), /project_ids are invalid/u);
    assert.throws(() => f.evaluator.importRuntimePolicy({ ...input, project_ids: ["invalid project"] }), /project_ids are invalid/u);
    assert.throws(() => f.evaluator.importRuntimePolicy({ ...input, stages: [] }), /stages are invalid/u);
    assert.throws(() => f.evaluator.importRuntimePolicy({ ...input, stages: ["held_out"] }), /stages are invalid/u);
    assert.throws(() => f.evaluator.importRuntimePolicy({ ...input, revision: 0 }), /positive safe integer/u);
    const defaulted = f.evaluator.importRuntimePolicy({ identity, project_ids: ["test"], stages: ["shadow"] });
    assert.equal((defaulted.policy as JsonObject).revision, 1);
    assert.match(String((defaulted.policy as JsonObject).id), /^scoped-adapter_/u);
    const first = f.evaluator.importRuntimePolicy(input);
    assert.equal(first.idempotent, false);
    assert.equal(f.evaluator.importRuntimePolicy(input).idempotent, true);
    assert.throws(() => f.evaluator.importRuntimePolicy({ ...input, stages: ["canary"] }), /revision must increase/u);
    assert.equal((f.store.get("experience_evaluator_policy", "scoped-policy").stages as string[])[0], "shadow");
  } finally { await f.close(); }
});

test("trusted evaluator refuses malformed pinned contracts, cases and candidate definitions", async () => {
  const f = await signedShadowFixture("passed");
  try {
    assert.throws(() => new TrustedExperienceEvaluator(f.store).importPolicy({}), /policy root is not configured/u);
    const ref = f.binding.evaluation_contract_ref as JsonObject;
    const attempts: Array<{ binding: JsonObject; reason: RegExp }> = [
      { binding: { ...f.binding, evaluation_contract_ref: { ...ref, kind: "memory" } }, reason: /Evaluation Contract binding is invalid/u },
      { binding: { ...f.binding, evaluation_contract_ref: { ...ref, id: "" } }, reason: /Evaluation Contract binding is invalid/u },
      { binding: { ...f.binding, evaluation_contract_ref: { ...ref, version: 0 } }, reason: /Evaluation Contract binding is invalid/u },
      { binding: { ...f.binding, evaluation_contract_ref: { ...ref, digest: `sha256:${"b".repeat(64)}` } }, reason: /Evaluation Contract binding is invalid/u },
      { binding: { ...f.binding, cases: [] }, reason: /cases are invalid/u },
      { binding: { ...f.binding, cases: Array.from({ length: 65 }, (_, i) => ({ case_id: `case-${i}`, input_digest: `sha256:${"e".repeat(64)}` })) }, reason: /cases are invalid/u },
      { binding: { ...f.binding, cases: [...f.binding.cases, ...f.binding.cases] }, reason: /case ids are duplicated/u },
      { binding: { ...f.binding, safety_assertions: [] }, reason: /safety assertions are invalid/u },
      { binding: { ...f.binding, candidate_definition: { kind: "prompt", instruction: "different" } }, reason: /definition does not match/u },
    ];
    const before = f.store.count("experience_evaluator_request");
    for (const attempt of attempts) {
      assert.throws(() => f.evaluator.request({ dispatch_id: f.dispatch.id, policy_id: f.policy.id, evaluation_binding: attempt.binding }), attempt.reason);
      assert.equal(f.store.count("experience_evaluator_request"), before);
    }
    const replay = { request_id: String(f.request.id), dispatch_id: f.dispatch.id, policy_id: f.policy.id, evaluation_binding: f.binding };
    assert.equal(f.evaluator.request(replay).idempotent, true);
    assert.throws(() => f.evaluator.request({ ...replay, evaluation_binding: { ...f.binding, evaluation_case_set_id: "changed-set" } }), /idempotency conflict/u);
    assert.equal(f.store.count("experience_evaluator_request"), before);
  } finally { await f.close(); }
});

test("trusted evaluator rejects resolved, unauthorized, cross-project and unapproved cold-start dispatches", async () => {
  const f = await signedShadowFixture("passed");
  try {
    const originalProcedure = f.store.get("experience_procedure", "prompt-work-item");
    const checks: Array<{ dispatch?: JsonObject; policy?: JsonObject; procedure?: JsonObject; reason: RegExp }> = [
      { dispatch: { status: "passed" }, reason: /already resolved/u },
      { policy: { revoked: true }, reason: /revoked or not authorized/u },
      { policy: { stages: [] }, reason: /revoked or not authorized/u },
      { procedure: { definition_digest: `sha256:${"1".repeat(64)}` }, reason: /candidate definition drifted/u },
      { dispatch: { stage: "held_out" }, policy: { stages: ["held_out"] }, reason: /Shadow and Canary only/u },
      { procedure: { scenario_signature: { project: { id: "project:other" } } }, reason: /project scope does not match/u },
      { procedure: { scope: undefined }, reason: /project scope does not match/u },
      { policy: { project_ids: ["other"] }, reason: /not authorized for this project/u },
      { dispatch: { stage: "canary", baseline_version: null }, policy: { stages: ["canary"] }, reason: /explicit cold-start contract/u },
    ];
    for (const check of checks) {
      const store = { get: (kind: string) => kind === "experience_evaluation_dispatch" ? { ...f.dispatch, ...check.dispatch }
        : kind === "experience_evaluator_policy" ? { ...f.policy, ...check.policy } : { ...originalProcedure, ...check.procedure },
        transaction: () => { throw new Error("rejected request must not write"); } } as unknown as CraftStore;
      const evaluator = new TrustedExperienceEvaluator(store);
      assert.throws(() => evaluator.request({ dispatch_id: f.dispatch.id, policy_id: f.policy.id, evaluation_binding: f.binding }), check.reason);
    }
  } finally { await f.close(); }
});

test("signed evaluator receipts cannot substitute their pinned candidate, contract, cases or safety assertions", async () => {
  const f = await signedShadowFixture("passed");
  try {
    const substitutions: Array<[string, unknown]> = [
      ["candidate_ref", { kind: "experience_procedure", id: "other", version: 1, digest: `sha256:${"d".repeat(64)}` }],
      ["definition_digest", `sha256:${"1".repeat(64)}`], ["evaluation_contract_ref", { id: "other" }],
      ["evaluation_contract_digest", `sha256:${"1".repeat(64)}`], ["evaluation_case_set_id", "other"],
      ["evaluation_case_set_digest", `sha256:${"1".repeat(64)}`], ["evaluation_budget_digest", `sha256:${"1".repeat(64)}`],
      ["safety_assertions_digest", `sha256:${"1".repeat(64)}`], ["baseline_version", 42], ["dispatch_identity_digest", `sha256:${"1".repeat(64)}`],
    ];
    for (const [field, value] of substitutions) {
      assert.throws(() => f.evaluator.verifyReceipt({ request_id: f.request.id, dispatch_id: f.dispatch.id,
        receipt: { ...f.receipt, [field]: value }, signature: f.signature }, () => { throw new Error("gate must not run"); }), /does not echo/u);
    }
    const signedFailures: Array<{ receipt: JsonObject; reason: RegExp }> = [
      { receipt: { ...f.receipt, results: [{ case_id: "case-1", input_digest: `sha256:${"1".repeat(64)}`, verdict: "passed", evidence_digest: `sha256:${"8".repeat(64)}` }] }, reason: /cases do not match/u },
      { receipt: { ...f.receipt, safety_results: [{ assertion_digest: `sha256:${"1".repeat(64)}`, verdict: "passed", evidence_digest: `sha256:${"7".repeat(64)}` }] }, reason: /safety results do not match/u },
      { receipt: { ...f.receipt, safety_results: [{ assertion_digest: stableDigest("No side effects"), verdict: "passed", evidence_digest: "invalid" }] }, reason: /safety results do not match/u },
    ];
    for (const attempt of signedFailures) {
      const signature = sign(null, Buffer.concat([Buffer.from("craft-experience-evaluation-receipt.v1\0"), Buffer.from(canonicalJson(attempt.receipt))]), f.evaluatorPrivateKey).toString("base64url");
      assert.throws(() => f.evaluator.verifyReceipt({ request_id: f.request.id, dispatch_id: f.dispatch.id, receipt: attempt.receipt, signature },
        () => { throw new Error("gate must not run"); }), attempt.reason);
    }
    assert.equal(f.store.get("experience_evaluator_request", String(f.request.id)).status, "issued");
    assert.equal(f.store.count("experience_procedure_gate"), 0);
  } finally { await f.close(); }
});

test("trusted Prompt evaluation rejects missing or reused evaluation cases before issuing a request", async () => {
  const cases = [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}` }];
  const stage = { case_bindings: cases, safety_assertions: ["No side effects"], budget: { max_calls: 1 } };
  const examples: Array<{ extra: JsonObject; reason: string }> = [
    { extra: {}, reason: "experience_evaluation_case_manifest_unavailable" },
    { extra: { budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: [] } } }, reason: "experience_evaluation_held_out_set_unavailable" },
    { extra: { budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: ["case-1"] } },
      task_effect: { task_set: { held_out_task_refs: [] } } }, reason: "experience_evaluation_case_set_reused" },
    { extra: { budget: { experience_evaluation: { stages: { shadow: stage, canary: stage }, discovery_case_ids: [] } },
      task_effect: { task_set: { held_out_task_refs: [] } } }, reason: "experience_evaluation_stage_case_sets_overlap" },
  ];
  for (const example of examples) {
    const f = await signedShadowFixture("passed", "passed", example.extra);
    try {
      const service = new CraftService(f.store);
      (service.ownerServices as Map<string, CraftService>).set("eval", service);
      const result = service.experienceLearningEvaluationRun({ dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken });
      assert.equal(result.status, "awaiting_adapter");
      assert.equal(result.reason, example.reason);
      assert.equal(f.store.count("experience_evaluator_request"), 1);
    } finally { await f.close(); }
  }
});

test("trusted Prompt evaluation cannot issue a request without a pinned case-set ID", async () => {
  const stage = { case_bindings: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}` }],
    safety_assertions: ["No side effects"], budget: { max_calls: 1 } };
  const extra = { budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: [] } },
    task_effect: { task_set: { held_out_task_refs: [] } } };
  const f = await signedShadowFixture("passed", "passed", extra, "Check the pinned project verification result.");
  try {
    const service = new CraftService(f.store);
    (service.ownerServices as Map<string, CraftService>).set("eval", service);
    service.serviceEnvironment = { CRAFT_TRUSTED_EVALUATORS: JSON.stringify([{ ...f.identity, project_ids: ["test"], experience_stages: ["shadow"] }]) };
    const before = f.store.count("experience_evaluator_request");
    const result = service.experienceLearningEvaluationRun({ dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken });
    assert.equal(result.status, "awaiting_adapter");
    assert.equal(result.reason, "trusted_prompt_evaluator_unavailable");
    assert.equal(f.store.count("experience_evaluator_request"), before);
  } finally { await f.close(); }
});

test("a pinned Prompt issues a signed evaluation request and rejects a changed content file", async t => {
  const stage = { case_bindings: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}` }],
    case_set_id: "shadow-set", safety_assertions: ["No side effects"], budget: { max_calls: 1 } };
  const extra = { budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: [] } },
    task_effect: { task_set: { held_out_task_refs: [] } } };
  const f = await signedShadowFixture("passed", "passed", extra, "Check the pinned project verification result.");
  try {
    const service = new CraftService(f.store);
    (service.ownerServices as Map<string, CraftService>).set("eval", service);
    assert.equal(f.store.contentStore.readCompatSync(f.contentRef!, "project:test").body, "Check the pinned project verification result.");
    service.serviceEnvironment = { CRAFT_TRUSTED_EVALUATORS: JSON.stringify([{ ...f.identity, project_ids: ["test"], experience_stages: ["shadow"] }]) };
    let underlyingError: unknown;
    const originalRequest = TrustedExperienceEvaluator.prototype.request;
    t.mock.method(TrustedExperienceEvaluator.prototype, "request", function (this: TrustedExperienceEvaluator, ...args: Parameters<typeof originalRequest>) {
      try { return originalRequest.apply(this, args); } catch (error) { underlyingError = error; throw error; }
    });
    const input = { dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken };
    const issued = service.experienceLearningEvaluationRun(input);
    assert.equal(issued.reason, "trusted_prompt_evaluator_required", String(underlyingError));
    assert.equal(typeof (issued.evaluation_request as JsonObject).id, "string");
    const issuedId = String((issued.evaluation_request as JsonObject).id);
    assert.throws(() => service.experienceLearningEvaluationResult({ ...input, dispatch_id: "other-dispatch", evaluator_request_id: issuedId,
      receipt: f.receipt, signature: f.signature }), /dispatch does not match/u);
    assert.throws(() => service.experienceLearningEvaluationResult({ ...input, evaluator_request_id: issuedId,
      receipt: f.receipt, signature: "!" }), /signature|does not match/u);
    assert.equal(f.store.get("experience_evaluator_request", issuedId).status, "issued");
    const trustedEnvironment = service.serviceEnvironment;
    service.serviceEnvironment = { CRAFT_TRUSTED_EVALUATORS: JSON.stringify([{ ...f.identity, id: "replacement-adapter", project_ids: ["test"], experience_stages: ["shadow"] }]) };
    assert.throws(() => service.experienceLearningEvaluationResult({ ...input, evaluator_request_id: issuedId, receipt: f.receipt, signature: f.signature }), /configuration changed or was revoked/u);
    service.serviceEnvironment = trustedEnvironment;
    assert.equal(f.store.get("experience_evaluator_request", issuedId).status, "issued");
    const path = String(f.contentRef!.path);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original + "\ntampered");
    const rejected = service.experienceLearningEvaluationRun(input);
    assert.equal(rejected.status, "awaiting_adapter");
    assert.notEqual(rejected.reason, "trusted_prompt_evaluator_required");
    assert.equal(rejected.evaluation_request, undefined);
  } finally { await f.close(); }
});

test("a valid signed Prompt receipt advances its exact leased Work Item through the service", async t => {
  const stage = { case_bindings: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}` }],
    case_set_id: "shadow-set", safety_assertions: ["No side effects"], budget: { max_calls: 1 } };
  const extra = { budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: [] } },
    task_effect: { task_set: { held_out_task_refs: [] } } };
  const f = await signedShadowFixture("passed", "passed", extra, "Check the pinned project verification result.");
  try {
    const service = new CraftService(f.store);
    (service.ownerServices as Map<string, CraftService>).set("eval", service);
    service.serviceEnvironment = { CRAFT_TRUSTED_EVALUATORS: JSON.stringify([{ ...f.identity, project_ids: ["test"], experience_stages: ["shadow"] }]) };
    t.mock.method(service.experienceProcedures, "gate", f.gate);
    const input = { dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken };
    const request = service.experienceLearningEvaluationRun(input).evaluation_request as JsonObject;
    const receipt = { ...f.receipt, request_id: request.id, nonce: request.nonce, request_digest: request.request_digest,
      candidate_ref: request.candidate_ref, definition_digest: request.definition_digest, evaluation_contract_ref: request.evaluation_contract_ref,
      evaluation_contract_digest: request.evaluation_contract_digest, evaluation_case_set_id: request.evaluation_case_set_id,
      evaluation_case_set_digest: request.evaluation_case_set_digest, evaluation_budget_digest: request.evaluation_budget_digest,
      safety_assertions_digest: request.safety_assertions_digest, baseline_version: request.baseline_version,
      dispatch_identity_digest: request.dispatch_identity_digest, issued_at_ms: Date.now() };
    const signature = sign(null, Buffer.concat([Buffer.from("craft-experience-evaluation-receipt.v1\0"), Buffer.from(canonicalJson(receipt))]), f.evaluatorPrivateKey).toString("base64url");
    assert.throws(() => service.experienceLearningEvaluationResult({ ...input, lease_token: "wrong", evaluator_request_id: request.id, receipt, signature }), /active Work Item lease/u);
    assert.equal(f.store.get("experience_evaluator_request", String(request.id)).status, "issued");
    assert.equal(f.store.count("experience_procedure_gate"), 0);
    const result = service.experienceLearningEvaluationResult({ ...input, evaluator_request_id: request.id, receipt, signature });
    assert.equal(((result.result as JsonObject).dispatch as JsonObject).status, "passed");
    assert.equal(f.store.get("experience_evaluator_request", String(request.id)).status, "consumed");
    assert.equal(f.store.get("experience_learning_work_item", String(f.dispatch.learning_work_item_id)).stage, "held_out");
  } finally { await f.close(); }
});

test("trusted Prompt evaluation refuses a content reference bound to another asset, version or scope", async () => {
  const stage = { case_bindings: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}` }],
    case_set_id: "shadow-set", safety_assertions: ["No side effects"], budget: { max_calls: 1 } };
  const extra = { budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: [] } },
    task_effect: { task_set: { held_out_task_refs: [] } } };
  for (const refOverride of [{ kind: "knowledge" }, { record_id: "other-prompt" }, { version: 2 }, { scope: "project:other" }]) {
    const f = await signedShadowFixture("passed", "passed", extra, "Check the pinned project verification result.", refOverride);
    try {
      const service = new CraftService(f.store);
      (service.ownerServices as Map<string, CraftService>).set("eval", service);
      service.serviceEnvironment = { CRAFT_TRUSTED_EVALUATORS: JSON.stringify([{ ...f.identity, project_ids: ["test"], experience_stages: ["shadow"] }]) };
      const before = f.store.count("experience_evaluator_request");
      const rejected = service.experienceLearningEvaluationRun({ dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken });
      assert.equal(rejected.status, "awaiting_adapter");
      assert.equal(rejected.reason, "experience_prompt_content_reference_invalid");
      assert.equal(rejected.evaluation_request, undefined);
      assert.equal(f.store.count("experience_evaluator_request"), before);
    } finally { await f.close(); }
  }
});

test("trusted Prompt evaluation refuses a scenario signature that drifted from the pinned definition", async () => {
  const stage = { case_bindings: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}` }],
    case_set_id: "shadow-set", safety_assertions: ["No side effects"], budget: { max_calls: 1 } };
  const extra = { budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: [] } },
    task_effect: { task_set: { held_out_task_refs: [] } } };
  const f = await signedShadowFixture("passed", "passed", extra, "Check the pinned project verification result.", {}, { scenario_signature: { domain: "writing" } });
  try {
    const service = new CraftService(f.store);
    (service.ownerServices as Map<string, CraftService>).set("eval", service);
    service.serviceEnvironment = { CRAFT_TRUSTED_EVALUATORS: JSON.stringify([{ ...f.identity, project_ids: ["test"], experience_stages: ["shadow"] }]) };
    const before = f.store.count("experience_evaluator_request");
    const result = service.experienceLearningEvaluationRun({ dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken });
    assert.equal(result.status, "awaiting_adapter");
    assert.equal(result.reason, "experience_prompt_definition_drifted");
    assert.equal(f.store.count("experience_evaluator_request"), before);
  } finally { await f.close(); }
});

test("trusted Prompt evaluation uses its initial version when an older candidate omits candidate_version", async () => {
  const stage = { case_bindings: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}` }],
    case_set_id: "shadow-set", safety_assertions: ["No side effects"], budget: { max_calls: 1 } };
  const extra = { budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: [] } },
    task_effect: { task_set: { held_out_task_refs: [] } } };
  const f = await signedShadowFixture("passed", "passed", extra, "Check the pinned project verification result.", {}, { candidate_version: undefined });
  try {
    const service = new CraftService(f.store);
    (service.ownerServices as Map<string, CraftService>).set("eval", service);
    service.serviceEnvironment = { CRAFT_TRUSTED_EVALUATORS: JSON.stringify([{ ...f.identity, project_ids: ["test"], experience_stages: ["shadow"] }]) };
    const result = service.experienceLearningEvaluationRun({ dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken });
    assert.equal(result.reason, "trusted_prompt_evaluator_required");
    assert.equal(((result.evaluation_request as JsonObject).candidate_ref as JsonObject).version, 1);
  } finally { await f.close(); }
});

test("trusted Prompt evaluation fails closed when the runtime evaluator policy is unavailable or ambiguous", async () => {
  const stage = { case_bindings: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}` }],
    case_set_id: "shadow-set", safety_assertions: ["No side effects"], budget: { max_calls: 1 } };
  const extra = { budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: [] } },
    task_effect: { task_set: { held_out_task_refs: [] } } };
  const f = await signedShadowFixture("passed", "passed", extra, "Check the pinned project verification result.");
  try {
    const service = new CraftService(f.store);
    (service.ownerServices as Map<string, CraftService>).set("eval", service);
    const allowed = { ...f.identity, project_ids: ["test"], experience_stages: ["shadow"] };
    const scenarios = [
      { registry: [], reason: "trusted_experience_evaluator_scope_unavailable" },
      { registry: [{ ...allowed, revoked: true }], reason: "trusted_experience_evaluator_scope_unavailable" },
      { registry: [{ ...f.identity }], reason: "trusted_experience_evaluator_scope_unavailable" },
      { registry: [{ ...f.identity, project_ids: ["test"] }], reason: "trusted_experience_evaluator_scope_unavailable" },
      { registry: [{ ...allowed, project_ids: ["another"] }], reason: "trusted_experience_evaluator_scope_unavailable" },
      { registry: [{ ...allowed, experience_stages: ["canary"] }], reason: "trusted_experience_evaluator_scope_unavailable" },
      { registry: [{ ...allowed, policy_revision: 0 }], reason: "trusted_prompt_evaluator_unavailable" },
      { registry: [allowed, { ...allowed, id: "other-adapter" }], reason: "trusted_experience_evaluator_scope_ambiguous" },
    ];
    const before = f.store.count("experience_evaluator_request");
    for (const scenario of scenarios) {
      service.serviceEnvironment = { CRAFT_TRUSTED_EVALUATORS: JSON.stringify(scenario.registry) };
      const result = service.experienceLearningEvaluationRun({ dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken });
      assert.equal(result.status, "awaiting_adapter");
      assert.equal(result.reason, scenario.reason);
      assert.equal(f.store.count("experience_evaluator_request"), before);
    }
  } finally { await f.close(); }
});

test("trusted Prompt evaluation uses process configuration only when no service environment is supplied", async () => {
  const stage = { case_bindings: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}` }],
    case_set_id: "shadow-set", safety_assertions: ["No side effects"], budget: { max_calls: 1 } };
  const extra = { budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: [] } },
    task_effect: { task_set: { held_out_task_refs: [] } } };
  const f = await signedShadowFixture("passed", "passed", extra, "Check the pinned project verification result.");
  const prior = process.env.CRAFT_TRUSTED_EVALUATORS;
  try {
    const service = new CraftService(f.store);
    (service.ownerServices as Map<string, CraftService>).set("eval", service);
    const input = { dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken };
    delete process.env.CRAFT_TRUSTED_EVALUATORS;
    service.serviceEnvironment = {};
    assert.equal(service.experienceLearningEvaluationRun(input).reason, "trusted_experience_evaluator_scope_unavailable");
    process.env.CRAFT_TRUSTED_EVALUATORS = JSON.stringify([{ ...f.identity, project_ids: ["test"], experience_stages: ["shadow"] }]);
    service.serviceEnvironment = undefined as unknown as NodeJS.ProcessEnv;
    assert.equal(service.experienceLearningEvaluationRun(input).reason, "trusted_prompt_evaluator_required");
  } finally {
    if (prior === undefined) delete process.env.CRAFT_TRUSTED_EVALUATORS; else process.env.CRAFT_TRUSTED_EVALUATORS = prior;
    await f.close();
  }
});

test("trusted Prompt evaluation fails closed if an injected registry changes between validation and parsing", async () => {
  const stage = { case_bindings: [{ case_id: "case-1", input_digest: `sha256:${"e".repeat(64)}` }],
    case_set_id: "shadow-set", safety_assertions: ["No side effects"], budget: { max_calls: 1 } };
  const extra = { budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: [] } },
    task_effect: { task_set: { held_out_task_refs: [] } } };
  const f = await signedShadowFixture("passed", "passed", extra, "Check the pinned project verification result.");
  try {
    const service = new CraftService(f.store);
    (service.ownerServices as Map<string, CraftService>).set("eval", service);
    const allowed = { ...f.identity, project_ids: ["test"], experience_stages: ["shadow"] };
    const stable = JSON.stringify([allowed]);
    const cases: Array<{ second: string; reason: string }> = [
      { second: "{", reason: "trusted_prompt_evaluator_unavailable" },
      { second: "{}", reason: "trusted_prompt_evaluator_unavailable" },
      { second: "[null]", reason: "trusted_experience_evaluator_scope_unavailable" },
      { second: "[{}]", reason: "trusted_experience_evaluator_scope_unavailable" },
      { second: JSON.stringify([{ ...allowed, digest: `sha256:${"1".repeat(64)}` }]), reason: "trusted_experience_evaluator_scope_unavailable" },
      { second: JSON.stringify([{ ...allowed, public_key_pem: "different-key" }]), reason: "trusted_experience_evaluator_scope_unavailable" },
    ];
    const before = f.store.count("experience_evaluator_request");
    for (const entry of cases) {
      let reads = 0;
      service.serviceEnvironment = Object.defineProperty({}, "CRAFT_TRUSTED_EVALUATORS", { get: () => reads++ === 0 ? stable : entry.second });
      const result = service.experienceLearningEvaluationRun({ dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken });
      assert.equal(result.status, "awaiting_adapter");
      assert.equal(result.reason, entry.reason);
      assert.equal(f.store.count("experience_evaluator_request"), before);
    }
  } finally { await f.close(); }
});

test("Prompt evaluation does not issue a request if an injected dispatch loses its Work Item identity", () => {
  let reads = 0;
  const dispatch = { id: "dispatch-1", stage: "shadow", procedure_id: "prompt-1", procedure_version: 1,
    get learning_work_item_id() { return reads++ < 2 ? "item-1" : undefined; }, lease_token_digest: stableDigest("lease") };
  const procedure = { id: "prompt-1", procedure_kind: "prompt" };
  const item = { status: "processing", lease_owner: "worker", lease_token: "lease", lease_expires_at: "2999-01-01T00:00:00.000Z", active_dispatch_ref: { id: dispatch.id } };
  const fake = { store: { get: (kind: string) => kind === "experience_evaluation_dispatch" ? dispatch : kind === "experience_procedure" ? procedure : item },
    ownerServices: new Map() } as unknown as CraftService;
  const result = CraftService.prototype.experienceLearningEvaluationRun.call(fake, { dispatch_id: dispatch.id, worker_id: "worker", lease_token: "lease" });
  assert.equal(result.status, "awaiting_adapter");
  assert.equal(result.reason, "experience_learning_work_item_unavailable");
});

test("automatic Prompt signoff remains pending without its contract owner and prior gates", async () => {
  const f = await signedShadowFixture("passed");
  try {
    f.store.save("experience_evaluation_dispatch", String(f.dispatch.id), { ...f.dispatch, stage: "signoff" });
    const service = new CraftService(f.store);
    const input = { dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken };
    const first = service.experienceLearningEvaluationRun(input);
    assert.equal(first.status, "awaiting_adapter");
    assert.equal(first.reason, "experience_evaluation_contract_unavailable");
    (service.ownerServices as Map<string, CraftService>).set("eval", service);
    const second = service.experienceLearningEvaluationRun(input);
    assert.equal(second.status, "awaiting_adapter");
    assert.equal(second.reason, "experience_signoff_prior_gates_unavailable");
    (service.ownerServices as Map<string, CraftService>).delete("eval");
    Object.defineProperty(service, "storageOwner", { value: "eval", configurable: true });
    const selfOwned = service.experienceLearningEvaluationRun(input);
    assert.equal(selfOwned.status, "awaiting_adapter");
    assert.equal(selfOwned.reason, "experience_signoff_prior_gates_unavailable");
    assert.deepEqual(f.store.get("experience_procedure", "prompt-work-item").completed_gates, []);
  } finally { await f.close(); }
});

test("automatic Prompt signoff rejects prior gate evidence with the wrong identity, result or contract", () => {
  const contract = { id: "contract-1", contract_digest: `sha256:${"c".repeat(64)}` };
  const dispatch = { id: "dispatch-1", stage: "signoff", procedure_id: "prompt-1", procedure_version: 1,
    learning_work_item_id: "item-1", lease_token_digest: stableDigest("lease") };
  const procedure = { id: "prompt-1", procedure_kind: "prompt", completed_gates: ["shadow", "held_out"],
    evaluation_contract_id: "contract-1", evaluation_id: "heldout-1", evaluation_contract_digest: `sha256:${"c".repeat(64)}`, definition_digest: `sha256:${"d".repeat(64)}` };
  const item = { status: "processing", lease_owner: "worker", lease_token: "lease", lease_expires_at: "2999-01-01T00:00:00.000Z",
    active_dispatch_ref: { id: dispatch.id }, evaluation_contract_ref: { id: contract.id, version: 1, digest: contract.contract_digest },
    completed_gate_refs: [{ id: "shadow-gate" }, { id: "heldout-gate" }] };
  const gates: Record<string, JsonObject> = {
    "shadow-gate": { id: "shadow-gate", stage: "shadow", passed: true, evidence_ids: ["shadow-evidence"] },
    "heldout-gate": { id: "heldout-gate", stage: "held_out", passed: true, evidence_ids: ["heldout-evidence"] },
  };
  const shared = { status: "passed", procedure_id: procedure.id, definition_digest: procedure.definition_digest };
  const shadow = { record_origin: "experience_evaluator", metadata: { ...shared, evaluation_contract_digest: contract.contract_digest } };
  const heldout = { record_origin: "experience_evaluator", metadata: { ...shared, evaluation_contract_id: "contract-1", evaluation_id: "heldout-1", task_effect_contract_digest: procedure.evaluation_contract_digest } };
  const mutations: Array<{ id: string; value: JsonObject }> = [
    { id: "shadow-evidence", value: { ...shadow, record_origin: "untrusted" } },
    ...["status", "procedure_id", "definition_digest", "evaluation_contract_digest"].map(key => ({ id: "shadow-evidence", value: { ...shadow, metadata: { ...shadow.metadata, [key]: "wrong" } } })),
    ...["evaluation_contract_id", "evaluation_id", "task_effect_contract_digest"].map(key => ({ id: "heldout-evidence", value: { ...heldout, metadata: { ...heldout.metadata, [key]: "wrong" } } })),
  ];
  for (const mutation of mutations) {
    const evidence: Record<string, JsonObject> = { "shadow-evidence": shadow, "heldout-evidence": heldout, [mutation.id]: mutation.value };
    const get = (kind: string, id: string): JsonObject => {
      if (kind === "experience_procedure_gate") return gates[id]!;
      if (kind === "evidence") return evidence[id]!;
      return { experience_evaluation_dispatch: dispatch, experience_procedure: procedure, experience_learning_work_item: item }[kind]!;
    };
    const fake = { store: { get, find: get, save: () => { throw new Error("invalid evidence must not persist"); } },
      ownerServices: new Map([["eval", { store: { get: () => contract } }]]) } as unknown as CraftService;
    const result = CraftService.prototype.experienceLearningEvaluationRun.call(fake, { dispatch_id: dispatch.id, worker_id: "worker", lease_token: "lease" });
    assert.equal(result.status, "awaiting_adapter");
    assert.equal(result.reason, "experience_signoff_prior_evidence_invalid", mutation.id);
  }
});

test("automatic Prompt signoff binds both independently checked prior gates to its evaluator evidence", t => {
  const contract = { id: "contract-1", contract_digest: `sha256:${"c".repeat(64)}` };
  const dispatch = { id: "dispatch-1", stage: "signoff", procedure_id: "prompt-1", procedure_version: 1,
    learning_work_item_id: "item-1", lease_token_digest: stableDigest("lease") };
  const procedure = { id: "prompt-1", version: 1, procedure_kind: "prompt", completed_gates: ["shadow", "held_out"],
    evaluation_contract_id: "contract-1", evaluation_id: "heldout-1", evaluation_contract_digest: contract.contract_digest,
    definition_digest: `sha256:${"d".repeat(64)}` };
  const item = { status: "processing", lease_owner: "worker", lease_token: "lease", lease_expires_at: "2999-01-01T00:00:00.000Z",
    active_dispatch_ref: { id: dispatch.id }, evaluation_contract_ref: { id: contract.id, version: 1, digest: contract.contract_digest },
    completed_gate_refs: [{ id: "shadow-gate" }, { id: "heldout-gate" }] };
  const gates: Record<string, JsonObject> = {
    "shadow-gate": { id: "shadow-gate", stage: "shadow", passed: true, evidence_ids: ["shadow-evidence"] },
    "heldout-gate": { id: "heldout-gate", stage: "held_out", passed: true, evidence_ids: ["heldout-evidence"] },
  };
  const common = { status: "passed", procedure_id: procedure.id, definition_digest: procedure.definition_digest };
  const evidence: Record<string, JsonObject> = {
    "shadow-evidence": { id: "shadow-evidence", record_origin: "experience_evaluator", metadata: { ...common, evaluation_contract_digest: contract.contract_digest } },
    "heldout-evidence": { id: "heldout-evidence", record_origin: "experience_evaluator", metadata: { ...common, evaluation_contract_id: contract.id,
      evaluation_id: procedure.evaluation_id, task_effect_contract_digest: procedure.evaluation_contract_digest } },
  };
  const get = (kind: string, id: string): JsonObject => {
    if (kind === "experience_procedure_gate") return gates[id]!;
    if (kind === "evidence") return evidence[id]!;
    return { experience_evaluation_dispatch: dispatch, experience_procedure: procedure, experience_learning_work_item: item }[kind]!;
  };
  let savedEvidence: JsonObject | undefined;
  const fake = { store: { get, find: get, save: (_kind: string, _id: string, payload: JsonObject) => { savedEvidence = payload; return payload; } },
    ownerServices: new Map([["eval", { store: { get: () => contract } }]]),
    evidenceRecord: (payload: JsonObject) => ({ ...payload, id: "signoff-evidence" }),
    experienceProcedures: { gate: (args: JsonObject) => ({ gate: args, procedure }) } } as unknown as CraftService;
  t.mock.method(ExperienceLearningEvaluation.prototype, "result", function (args: JsonObject, gate: (value: JsonObject) => JsonObject) {
    assert.equal(args.dispatch_id, dispatch.id);
    assert.equal(args.worker_id, "worker");
    assert.equal(args.lease_token, "lease");
    assert.deepEqual(args.evidence_ids, ["signoff-evidence"]);
    gate({ stage: "signoff" });
    return { dispatch: { ...dispatch, status: "passed" } };
  });
  const result = CraftService.prototype.experienceLearningEvaluationRun.call(fake, { dispatch_id: dispatch.id, worker_id: "worker", lease_token: "lease" });
  assert.equal((result.dispatch as JsonObject).status, "passed");
  assert.equal(savedEvidence?.record_origin, "experience_evaluator");
  assert.deepEqual((savedEvidence?.metadata as JsonObject).prior_gate_evidence_ids, ["heldout-evidence", "shadow-evidence"]);
  savedEvidence = undefined;
  fake.evidenceRecord = (() => { throw new Error("private storage details"); }) as typeof fake.evidenceRecord;
  const unavailable = CraftService.prototype.experienceLearningEvaluationRun.call(fake, { dispatch_id: dispatch.id, worker_id: "worker", lease_token: "lease" });
  assert.equal(unavailable.status, "awaiting_adapter");
  assert.equal(unavailable.reason, "experience_signoff_unavailable");
  assert.equal(savedEvidence, undefined);
});

test("automatic Prompt signoff fails closed when its contract or exact prior gates drift", () => {
  const digest = `sha256:${"c".repeat(64)}`;
  const dispatch = { id: "dispatch-1", stage: "signoff", procedure_id: "prompt-1", procedure_version: 1,
    learning_work_item_id: "item-1", lease_token_digest: stableDigest("lease") };
  const procedure: JsonObject = { id: "prompt-1", procedure_kind: "prompt", completed_gates: ["shadow", "held_out"],
    evaluation_contract_id: "contract-1", evaluation_id: "heldout-1", definition_digest: `sha256:${"d".repeat(64)}` };
  const item: JsonObject = { status: "processing", lease_owner: "worker", lease_token: "lease", lease_expires_at: "2999-01-01T00:00:00.000Z",
    active_dispatch_ref: { id: dispatch.id }, evaluation_contract_ref: { id: "contract-1", version: 1, digest }, completed_gate_refs: [] };
  let contract = { contract_digest: "changed" };
  const get = (kind: string): JsonObject => ({ experience_evaluation_dispatch: dispatch, experience_procedure: procedure,
    experience_learning_work_item: item } as Record<string, JsonObject>)[kind]!;
  const fake = { store: { get, find: () => null, save: () => { throw new Error("invalid signoff must not write"); } },
    ownerServices: new Map([["eval", { store: { get: () => contract } }]]) } as unknown as CraftService;
  const run = () => CraftService.prototype.experienceLearningEvaluationRun.call(fake, { dispatch_id: dispatch.id, worker_id: "worker", lease_token: "lease" });
  assert.equal(run().reason, "experience_evaluation_contract_drifted");
  contract = { contract_digest: digest };
  for (const completed of [null, [], ["shadow"], ["held_out"]]) {
    procedure.completed_gates = completed;
    assert.equal(run().reason, "experience_signoff_prior_gates_unavailable");
  }
  procedure.completed_gates = ["shadow", "held_out"];
  item.completed_gate_refs = null;
  assert.equal(run().reason, "experience_signoff_prior_gates_unavailable");
});

test("non-Prompt evaluation delegates to the existing evaluation owner", t => {
  const dispatch = { id: "workflow-dispatch", stage: "shadow", procedure_id: "workflow-1", procedure_version: 1 };
  const procedure = { id: "workflow-1", procedure_kind: "workflow" };
  const fake = { store: { get: (kind: string) => kind === "experience_evaluation_dispatch" ? dispatch : procedure } } as unknown as CraftService;
  const input = { dispatch_id: dispatch.id };
  t.mock.method(ExperienceLearningEvaluation.prototype, "run", (args: JsonObject) => {
    assert.deepEqual(args, input);
    return { dispatch, status: "delegated" };
  });
  const result = CraftService.prototype.experienceLearningEvaluationRun.call(fake, input);
  assert.equal(result.status, "delegated");
});

test("Prompt evaluation rejects a missing work item or malformed pinned contract before issuing a request", () => {
  const dispatch: JsonObject = { id: "prompt-dispatch", stage: "shadow", procedure_id: "prompt-1", procedure_version: 1,
    learning_work_item_id: "item-1", lease_token_digest: stableDigest("lease") };
  const procedure = { id: "prompt-1", procedure_kind: "prompt" };
  const item: JsonObject = { status: "processing", lease_owner: "worker", lease_token: "lease", lease_expires_at: "2999-01-01T00:00:00.000Z",
    active_dispatch_ref: { id: dispatch.id }, evaluation_contract_ref: { kind: "wrong", id: "contract", version: 1 } };
  const fake = { store: { get: (kind: string) => kind === "experience_evaluation_dispatch" ? dispatch : kind === "experience_procedure" ? procedure : item },
    ownerServices: new Map() } as unknown as CraftService;
  const input = { dispatch_id: dispatch.id, worker_id: "worker", lease_token: "lease" };
  const malformed = CraftService.prototype.experienceLearningEvaluationRun.call(fake, input);
  assert.equal(malformed.status, "awaiting_adapter");
  assert.equal(malformed.reason, "experience_evaluation_contract_unavailable");
  item.evaluation_contract_ref = { kind: "evaluation_contract", id: "contract", version: 1, digest: "expected" };
  (fake.ownerServices as Map<string, unknown>).set("eval", { store: { get: () => ({ contract_digest: "changed" }) } });
  const drifted = CraftService.prototype.experienceLearningEvaluationRun.call(fake, input);
  assert.equal(drifted.status, "awaiting_adapter");
  assert.equal(drifted.reason, "experience_evaluation_contract_drifted");
  dispatch.learning_work_item_id = "";
  const empty = CraftService.prototype.experienceLearningEvaluationRun.call(fake, input);
  assert.equal(empty.status, "awaiting_adapter");
  assert.equal(empty.reason, "experience_learning_work_item_unavailable");
  delete dispatch.learning_work_item_id;
  assert.throws(() => CraftService.prototype.experienceLearningEvaluationRun.call(fake, input), /requires a Learning Work Item/u);
  procedure.procedure_kind = "workflow";
  (procedure as JsonObject).definition_ref = { kind: "prompt" };
  assert.throws(() => CraftService.prototype.experienceLearningEvaluationRun.call(fake, input), /requires a Learning Work Item/u);
});

test("evaluation run without a dispatch ID cannot select an arbitrary dispatch", () => {
  const fake = { store: { get: (kind: string, id: string) => {
    assert.equal(kind, "experience_evaluation_dispatch");
    assert.equal(id, "");
    throw new Error("dispatch not found");
  } } } as unknown as CraftService;
  assert.throws(() => CraftService.prototype.experienceLearningEvaluationRun.call(fake, {}), /dispatch not found/u);
});

test("an older Prompt without a valid structured definition cannot issue a trusted request", () => {
  const dispatch = { id: "legacy-prompt-dispatch", stage: "shadow", procedure_id: "legacy-prompt", procedure_version: 1,
    learning_work_item_id: "item-1", lease_token_digest: stableDigest("lease") };
  const procedure = { id: "legacy-prompt", procedure_kind: "prompt", scope: "project:test" };
  const item = { status: "processing", lease_owner: "worker", lease_token: "lease", lease_expires_at: "2999-01-01T00:00:00.000Z",
    active_dispatch_ref: { id: dispatch.id }, evaluation_contract_ref: { kind: "evaluation_contract", id: "contract", version: 1, digest: "digest" } };
  const stage = { case_bindings: [{ case_id: "case" }], safety_assertions: ["safe"], budget: {} };
  const contract = { contract_digest: "digest", budget: { experience_evaluation: { stages: { shadow: stage }, discovery_case_ids: [] } },
    task_effect: { task_set: { held_out_task_refs: [] } } };
  const fake = { store: { get: (kind: string) => kind === "experience_evaluation_dispatch" ? dispatch : kind === "experience_procedure" ? procedure : item },
    ownerServices: new Map([["eval", { store: { get: () => contract } }]]) } as unknown as CraftService;
  const result = CraftService.prototype.experienceLearningEvaluationRun.call(fake, { dispatch_id: dispatch.id, worker_id: "worker", lease_token: "lease" });
  assert.equal(result.status, "awaiting_adapter");
  assert.equal(result.reason, "trusted_prompt_evaluator_unavailable");
  assert.equal(result.evaluation_request, undefined);
});

test("Canary Prompt evaluation passes its explicit cold-start contract to the trusted adapter", t => {
  const key = generateKeyPairSync("ed25519");
  const identity = { id: "canary-adapter", version: "1", digest: `sha256:${"a".repeat(64)}`,
    public_key_pem: key.publicKey.export({ type: "spki", format: "pem" }).toString(), project_ids: ["test"], experience_stages: ["canary"] };
  const body = "Review the current project before continuing.";
  const scenario = { domain: "coding" };
  const dispatch = { id: "canary-dispatch", stage: "canary", procedure_id: "prompt-1", procedure_version: 1,
    learning_work_item_id: "item-1", lease_token_digest: stableDigest("lease"), baseline_version: null };
  const ref = { kind: "experience", record_id: "prompt-1", version: 1, scope: "project:test", digest: `sha256:${"b".repeat(64)}` };
  const procedure = { id: "prompt-1", version: 1, candidate_version: 1, procedure_kind: "prompt", provenance: "explicit_trace_distillation",
    scope: "project:test", content_ref: ref, content_digest: ref.digest, scenario_signature: scenario, definition_digest: stableDigest({ body, scenario_signature: scenario }) };
  const item = { status: "processing", lease_owner: "worker", lease_token: "lease", lease_expires_at: "2999-01-01T00:00:00.000Z",
    active_dispatch_ref: { id: dispatch.id }, evaluation_contract_ref: { kind: "evaluation_contract", id: "contract", version: 1, digest: "contract-digest" } };
  const canary = { case_bindings: [{ case_id: "canary-case", input_digest: `sha256:${"c".repeat(64)}` }], case_set_id: "canary-set",
    safety_assertions: ["No side effects"], budget: { max_calls: 1 }, allow_null_baseline: true };
  const contract = { contract_digest: "contract-digest", budget: { experience_evaluation: { stages: { canary }, discovery_case_ids: [] } },
    task_effect: { task_set: { held_out_task_refs: [] } } };
  const fake = { store: { get: (kind: string) => kind === "experience_evaluation_dispatch" ? dispatch : kind === "experience_procedure" ? procedure : item,
    contentStore: { readCompatSync: () => ({ body }) } }, ownerServices: new Map([["eval", { store: { get: () => contract } }]]),
    serviceEnvironment: { CRAFT_TRUSTED_EVALUATORS: JSON.stringify([identity]) } } as unknown as CraftService;
  t.mock.method(TrustedExperienceEvaluator.prototype, "importRuntimePolicy", () => ({ policy: { id: "test-policy" } }));
  t.mock.method(TrustedExperienceEvaluator.prototype, "request", (args: JsonObject) => {
    const binding = args.evaluation_binding as JsonObject;
    assert.equal(binding.allow_null_baseline, true);
    assert.deepEqual(binding.candidate_definition, { body, scenario_signature: scenario });
    assert.deepEqual(binding.cases, canary.case_bindings);
    return { request: { id: "canary-request" } };
  });
  const result = CraftService.prototype.experienceLearningEvaluationRun.call(fake, { dispatch_id: dispatch.id, worker_id: "worker", lease_token: "lease" });
  assert.equal(result.reason, "trusted_prompt_evaluator_required");
  assert.equal((result.evaluation_request as JsonObject).id, "canary-request");
});

test("Canary result passes its pinned contract and lease to the evaluation owner", t => {
  const key = generateKeyPairSync("ed25519");
  const identity = { id: "canary-adapter", version: "1", digest: `sha256:${"a".repeat(64)}`,
    public_key_pem: key.publicKey.export({ type: "spki", format: "pem" }).toString(), project_ids: ["test"], experience_stages: ["canary"] };
  const policyId = `experience_${stableDigest({ id: identity.id, version: identity.version, digest: identity.digest }).slice(-24)}`;
  const request = { id: "request-1", dispatch_id: "dispatch-1", project_id: "test", stage: "canary", policy_id: policyId };
  const dispatch = { id: "dispatch-1", stage: "canary", procedure_id: "prompt-1", procedure_version: 1 };
  const procedure = { id: "prompt-1", evaluation_contract_id: "contract-1", evaluation_id: "heldout-1" };
  let gateInput: JsonObject | undefined;
  const fake = { store: { get: (kind: string) => kind === "experience_evaluator_request" ? request : kind === "experience_evaluation_dispatch" ? dispatch : procedure },
    ownerServices: new Map(), serviceEnvironment: { CRAFT_TRUSTED_EVALUATORS: JSON.stringify([identity]) },
    experienceProcedures: { gate: (args: JsonObject) => { gateInput = args; return { gate: args, procedure }; } } } as unknown as CraftService;
  t.mock.method(TrustedExperienceEvaluator.prototype, "importRuntimePolicy", () => ({ policy: { id: policyId } }));
  let verifiedDispatch = dispatch.id;
  t.mock.method(TrustedExperienceEvaluator.prototype, "verifyReceipt", (_args: JsonObject, gate: (value: JsonObject) => JsonObject) => gate({ dispatch_id: verifiedDispatch, evidence_ids: ["signed-evidence"] }));
  t.mock.method(ExperienceLearningEvaluation.prototype, "result", (args: JsonObject, gate: (value: JsonObject) => JsonObject) => {
    assert.equal(args.evaluation_contract_id, "contract-1");
    assert.equal(args.evaluation_id, "heldout-1");
    assert.equal(args.worker_id, "worker");
    assert.equal(args.lease_token, "lease");
    return gate({ stage: "canary" });
  });
  CraftService.prototype.experienceLearningEvaluationResult.call(fake, { dispatch_id: dispatch.id, evaluator_request_id: request.id,
    worker_id: "worker", lease_token: "lease", receipt: {}, signature: "fixture" });
  assert.equal(gateInput?.evaluation_contract_id, "contract-1");
  assert.equal(gateInput?.evaluation_id, "heldout-1");
  gateInput = undefined;
  verifiedDispatch = "different-dispatch";
  assert.throws(() => CraftService.prototype.experienceLearningEvaluationResult.call(fake, { dispatch_id: dispatch.id,
    evaluator_request_id: request.id, worker_id: "worker", lease_token: "lease", receipt: {}, signature: "fixture" }), /Verified evaluator result dispatch changed/u);
  assert.equal(gateInput, undefined);
});

test("evaluation results without an external receipt still use the existing owner", t => {
  const dispatch = { id: "workflow-dispatch", stage: "shadow" };
  const fake = { store: { transaction: (fn: () => JsonObject) => fn(), get: () => dispatch },
    experienceProcedures: { gate: (args: JsonObject) => ({ gate: args }) } } as unknown as CraftService;
  const input = { dispatch_id: dispatch.id, evidence_ids: ["existing-evidence"] };
  t.mock.method(ExperienceLearningEvaluation.prototype, "result", (args: JsonObject) => {
    assert.deepEqual(args, input);
    return { dispatch, status: "delegated" };
  });
  const result = CraftService.prototype.experienceLearningEvaluationResult.call(fake, input);
  assert.equal(result.status, "delegated");
});

test("signed Prompt Shadow failure records rejection and fails the exact Work Item", async () => {
  const f = await signedShadowFixture("failed");
  try {
    const result = f.evaluator.verifyReceipt({ request_id: f.request.id, dispatch_id: f.dispatch.id,
      receipt: f.receipt, signature: f.signature }, () =>
      f.evaluation.result({ dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken, evidence_ids: [`experience_external_eval_${stableDigest([f.request.id, f.receipt]).slice(-24)}`] }, f.gate));
    assert.equal(((result.result as JsonObject).dispatch as JsonObject).status, "failed");
    const item = f.store.find("experience_learning_work_item", String(f.dispatch.learning_work_item_id));
    assert.equal(item?.stage, "shadow");
    assert.equal(item?.status, "failed");
    assert.equal(item?.failure_reason, "evaluation_gate_failed");
    assert.deepEqual(f.store.get("experience_procedure", "prompt-work-item").completed_gates, []);
    assert.equal(f.store.list("experience_procedure_gate", 10)[0]?.passed, false);
  } finally { await f.close(); }
});

test("failed signed safety assertion fails the Work Item even when cases pass", async () => {
  const f = await signedShadowFixture("passed", "failed");
  try {
    const result = f.evaluator.verifyReceipt({ request_id: f.request.id, dispatch_id: f.dispatch.id, receipt: f.receipt, signature: f.signature }, () =>
      f.evaluation.result({ dispatch_id: f.dispatch.id, worker_id: "test-worker", lease_token: f.leaseToken,
        evidence_ids: [`experience_external_eval_${stableDigest([f.request.id, f.receipt]).slice(-24)}`] }, f.gate));
    assert.equal(((result.result as JsonObject).dispatch as JsonObject).status, "failed");
  } finally { await f.close(); }
});

test("signed receipt without safety results does not advance its Work Item", async () => {
  const f = await signedShadowFixture("passed", "missing");
  try {
    assert.throws(() => f.evaluator.verifyReceipt({ request_id: f.request.id, dispatch_id: f.dispatch.id, receipt: f.receipt, signature: f.signature }, f.gate), /safety results/u);
    assert.equal(f.store.get("experience_evaluator_request", String(f.request.id)).status, "issued");
  } finally { await f.close(); }
});
