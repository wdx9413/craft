import { createPublicKey, createHash, verify } from "node:crypto";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { canonicalJson, stableDigest, payload } from "./digest.ts";
import { text } from "./validation.ts";

const DOMAIN = Buffer.from("craft-experience-evaluation-receipt.v1\0", "utf8");

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function digest(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^sha256:[a-f0-9]{64}$/u.test(result)) throw new Error(`${name} must be a SHA-256 digest`);
  return result;
}
function safeId(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}
function publicKeyPem(value: unknown): string {
  const pem = text(value, "public_key_pem");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Trusted evaluator requires an Ed25519 key");
  return pem;
}
function signatureBytes(value: unknown): Buffer {
  const encoded = text(value, "signature");
  if (!/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/u.test(encoded)) throw new Error("signature must be unpadded base64url");
  const decoded = Buffer.from(encoded, "base64url");
  if (!decoded.length || decoded.toString("base64url") !== encoded) throw new Error("signature encoding is invalid");
  return decoded;
}

/** Administrator bootstrap root. Runtime callers cannot replace this key. */
export class TrustedExperienceEvaluator {
  readonly store: CraftStore;
  readonly rootPublicKeyPem: string | null;
  readonly now: () => number;
  constructor(store: CraftStore, rootPublicKeyPem?: string, now: () => number = Date.now) {
    this.store = store; this.rootPublicKeyPem = rootPublicKeyPem ? publicKeyPem(rootPublicKeyPem) : null; this.now = now;
  }

  /**
   * Bootstrap an evaluator policy from immutable Runtime configuration. The
   * caller must first match this identity and key against the Runtime's
   * CRAFT_TRUSTED_EVALUATORS allowlist; this method is deliberately not an MCP
   * operation, so a model cannot authorize its own key or scope.
   */
  importRuntimePolicy(args: JsonObject): JsonObject {
    const identity = object(args.identity, "identity");
    const evaluatorId = safeId(identity.id, "evaluator_id");
    const version = text(identity.version, "evaluator_version");
    const evaluatorDigest = digest(identity.digest, "evaluator_digest");
    const keyPem = publicKeyPem(identity.public_key_pem);
    const policyId = safeId(args.policy_id ?? `${evaluatorId}_${stableDigest(version).slice(-12)}`, "policy_id");
    const revision = Number(args.revision ?? 1);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("revision must be a positive safe integer");
    const projects = args.project_ids;
    const stages = args.stages;
    if (!Array.isArray(projects) || !projects.length || projects.some(item => typeof item !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(item))) {
      throw new Error("Runtime evaluator project_ids are invalid");
    }
    if (!Array.isArray(stages) || !stages.length || stages.some(item => !["shadow", "canary"].includes(String(item)))) {
      throw new Error("Runtime evaluator stages are invalid");
    }
    const authority = { schema: "craft.experience-evaluator-policy.v1", policy_id: policyId, evaluator_id: evaluatorId,
      evaluator_version: version, evaluator_digest: evaluatorDigest, revision,
      key_fingerprint: `sha256:${createHash("sha256").update(createPublicKey(keyPem).export({ type: "spki", format: "der" })).digest("hex")}`,
      project_ids: [...new Set(projects as string[])].sort(), stages: [...new Set(stages.map(String))].sort(), revoked: args.revoked === true };
    return this.store.transaction(() => {
      const latest = this.store.find("experience_evaluator_policy", policyId);
      if (latest && revision <= Number(latest.revision)) {
        if (revision === Number(latest.revision) && latest.policy_digest === stableDigest(authority)) return { policy: latest, idempotent: true };
        throw new Error("Runtime evaluator policy revision must increase monotonically");
      }
      const policy = this.store.save("experience_evaluator_policy", policyId, { ...authority, public_key_pem: keyPem,
        policy_digest: stableDigest(authority), runtime_trust_digest: evaluatorDigest, imported_at: new Date(this.now()).toISOString() });
      return { policy, idempotent: false };
    });
  }

  importPolicy(args: JsonObject): JsonObject {
    if (!this.rootPublicKeyPem) throw new Error("Administrator evaluator policy root is not configured");
    const revision = Number(args.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("revision must be a positive safe integer");
    const policy = object(args.policy, "policy");
    if (policy.schema !== "craft.experience-evaluator-policy.v1") throw new Error("policy schema is unsupported");
    const policyId = safeId(policy.policy_id, "policy_id");
    const evaluatorId = safeId(policy.evaluator_id, "evaluator_id");
    const keyPem = publicKeyPem(policy.public_key_pem);
    const projects = policy.project_ids;
    const stages = policy.stages;
    if (!Array.isArray(projects) || !projects.length || projects.some(item => typeof item !== "string" || !item)) throw new Error("policy project_ids are invalid");
    if (!Array.isArray(stages) || !stages.length || stages.some(item => !["shadow", "held_out", "canary"].includes(String(item)))) throw new Error("policy stages are invalid");
    const authority = { schema: policy.schema, policy_id: policyId, evaluator_id: evaluatorId, revision,
      key_fingerprint: `sha256:${createHash("sha256").update(createPublicKey(keyPem).export({ type: "spki", format: "der" })).digest("hex")}`,
      project_ids: [...new Set(projects as string[])].sort(), stages: [...new Set((stages as unknown[]).map(String))].sort(), revoked: policy.revoked === true };
    const signature = signatureBytes(args.signature);
    if (!verify(null, Buffer.from(canonicalJson(authority)), createPublicKey(this.rootPublicKeyPem), signature)) throw new Error("Evaluator policy signature is invalid");
    return this.store.transaction(() => {
      const latest = this.store.find("experience_evaluator_policy", policyId);
      if (latest && revision <= Number(latest.revision)) {
        if (revision === Number(latest.revision) && latest.policy_digest === stableDigest(authority)) return { policy: latest, idempotent: true };
        throw new Error("Evaluator policy revision must increase monotonically");
      }
      const record = this.store.save("experience_evaluator_policy", policyId, { ...authority, public_key_pem: keyPem,
        policy_digest: stableDigest(authority), imported_at: new Date(this.now()).toISOString() });
      return { policy: record, idempotent: false };
    });
  }

  request(args: JsonObject): JsonObject {
    const dispatch = this.store.get("experience_evaluation_dispatch", text(args.dispatch_id, "dispatch_id"));
    if (dispatch.status !== "awaiting_adapter") throw new Error("Experience evaluation dispatch is already resolved");
    const policy = this.store.get("experience_evaluator_policy", text(args.policy_id, "policy_id"));
    if (policy.revoked === true || !(policy.stages as string[]).includes(String(dispatch.stage))) throw new Error("Evaluator policy is revoked or not authorized for this stage");
    const procedure = this.store.get("experience_procedure", String(dispatch.procedure_id), Number(dispatch.procedure_version));
    if (procedure.definition_digest !== dispatch.definition_digest) throw new Error("Experience evaluation candidate definition drifted");
    if (dispatch.stage !== "shadow" && dispatch.stage !== "canary") throw new Error("Trusted Experience evaluator supports Shadow and Canary only");
    const project = ((procedure.scenario_signature as JsonObject | undefined)?.project as JsonObject | undefined)?.id;
    const scopeProjectId = String(procedure.scope ?? "").replace(/^project:/u, "");
    const scenarioProjectId = String(project ?? "").replace(/^project:/u, "");
    if (!scopeProjectId || scenarioProjectId && scenarioProjectId !== scopeProjectId) throw new Error("Evaluator project scope does not match the exact Procedure scope");
    const projectId = scopeProjectId;
    if (!(policy.project_ids as string[]).includes(projectId)) throw new Error("Evaluator policy is not authorized for this project");
    const binding = object(args.evaluation_binding, "evaluation_binding");
    const contractRef = object(binding.evaluation_contract_ref, "evaluation_contract_ref");
    const contractDigest = digest(binding.evaluation_contract_digest, "evaluation_contract_digest");
    if (contractRef.kind !== "evaluation_contract" || typeof contractRef.id !== "string" || !contractRef.id.trim()
      || !Number.isSafeInteger(contractRef.version) || Number(contractRef.version) < 1 || contractRef.digest !== contractDigest) {
      throw new Error("Evaluation Contract binding is invalid");
    }
    if (!Array.isArray(binding.cases) || binding.cases.length < 1 || binding.cases.length > 64) throw new Error("evaluation_binding cases are invalid");
    const cases = binding.cases.map((raw, index) => {
      const item = object(raw, `evaluation_binding.cases[${index}]`);
      return { case_id: safeId(item.case_id, "case_id"), input_digest: digest(item.input_digest, "input_digest") };
    });
    if (new Set(cases.map(item => item.case_id)).size !== cases.length) throw new Error("Evaluation Contract case ids are duplicated");
    const caseSetId = safeId(binding.evaluation_case_set_id, "evaluation_case_set_id");
    const budgetDigest = digest(binding.evaluation_budget_digest, "evaluation_budget_digest");
    const safetyDigest = digest(binding.safety_assertions_digest, "safety_assertions_digest");
    if (!Array.isArray(binding.safety_assertions) || !binding.safety_assertions.length
      || binding.safety_assertions.some(item => typeof item !== "string" || !item.trim())) {
      throw new Error("Evaluator safety assertions are invalid");
    }
    const candidateDefinition = object(binding.candidate_definition, "candidate_definition");
    if (stableDigest(candidateDefinition) !== procedure.definition_digest) throw new Error("Evaluator candidate definition does not match the pinned digest");
    const baselineVersion = dispatch.baseline_version ?? null;
    if (dispatch.stage === "canary" && baselineVersion === null && binding.allow_null_baseline !== true) {
      throw new Error("Canary request without a current baseline requires an explicit cold-start contract");
    }
    const requestId = safeId(args.request_id ?? `experience_eval_request_${stableDigest({ dispatch_id: dispatch.id, policy_version: policy.version }).slice(-20)}`, "request_id");
    const identity = { schema: "craft.experience-evaluation-request.v1", request_id: requestId, dispatch_id: dispatch.id,
      procedure_id: procedure.id, procedure_version: procedure.version, definition_digest: procedure.definition_digest,
      candidate_ref: { kind: "experience_procedure", id: procedure.id, version: Number(procedure.candidate_version ?? procedure.version), digest: procedure.definition_digest },
      candidate_definition: candidateDefinition,
      evaluation_contract_ref: contractRef, evaluation_contract_digest: contractDigest, evaluation_case_bindings: cases,
      evaluation_case_set_id: caseSetId, evaluation_case_set_digest: stableDigest(cases), evaluation_budget_digest: budgetDigest,
      safety_assertions_digest: safetyDigest, safety_assertions: binding.safety_assertions,
      stage: dispatch.stage, baseline_version: baselineVersion, project_id: projectId,
      policy_id: policy.id, policy_version: policy.version, dispatch_identity_digest: dispatch.identity_digest };
    return this.store.transaction(() => {
      const existing = this.store.find("experience_evaluator_request", requestId);
      if (existing) { if (existing.request_digest !== stableDigest(identity)) throw new Error("Evaluator request idempotency conflict"); return { request: existing, idempotent: true }; }
      const saved = this.store.create("experience_evaluator_request", requestId, { ...identity, request_digest: stableDigest(identity),
        nonce: stableDigest({ requestId, random: Math.random(), at: this.now() }), status: "issued" });
      return { request: saved, idempotent: false };
    });
  }

  verifyReceipt(args: JsonObject, gate: (input: JsonObject) => JsonObject): JsonObject {
    const requestId = text(args.request_id, "request_id");
    const receipt = object(args.receipt, "receipt");
    const signature = signatureBytes(args.signature);
    return this.store.transaction(() => {
      const request = this.store.get("experience_evaluator_request", requestId);
      if (args.dispatch_id !== request.dispatch_id) throw new Error("Evaluator receipt dispatch does not match its issued request");
      const policy = this.store.find("experience_evaluator_policy", String(request.policy_id));
      if (!policy || policy.revoked === true || policy.version !== request.policy_version) throw new Error("Evaluator policy was revoked or changed");
      if (request.status !== "issued") throw new Error("Evaluator request was already consumed");
      if (receipt.schema !== "craft.experience-evaluation-receipt.v1" || receipt.request_id !== request.id || receipt.nonce !== request.nonce) throw new Error("Evaluator receipt does not match its request");
      if (receipt.evaluator_id !== policy.evaluator_id || receipt.request_digest !== request.request_digest) throw new Error("Evaluator identity or request digest does not match");
      if (stableDigest(receipt.candidate_ref) !== stableDigest(request.candidate_ref)
        || receipt.definition_digest !== request.definition_digest
        || stableDigest(receipt.evaluation_contract_ref) !== stableDigest(request.evaluation_contract_ref)
        || receipt.evaluation_contract_digest !== request.evaluation_contract_digest
        || receipt.evaluation_case_set_id !== request.evaluation_case_set_id
        || receipt.evaluation_case_set_digest !== request.evaluation_case_set_digest
        || receipt.evaluation_budget_digest !== request.evaluation_budget_digest
        || receipt.safety_assertions_digest !== request.safety_assertions_digest
        || stableDigest(receipt.baseline_version ?? null) !== stableDigest(request.baseline_version)
        || receipt.dispatch_identity_digest !== request.dispatch_identity_digest) {
        throw new Error("Evaluator receipt does not echo the exact candidate, contract, baseline, and dispatch binding");
      }
      if (!Number.isSafeInteger(receipt.issued_at_ms) || Math.abs(this.now() - Number(receipt.issued_at_ms)) > 120_000) throw new Error("Evaluator receipt is outside the accepted time window");
      const signed = Buffer.concat([DOMAIN, Buffer.from(canonicalJson(receipt), "utf8")]);
      if (!verify(null, signed, createPublicKey(String(policy.public_key_pem)), signature)) throw new Error("Evaluator receipt signature is invalid");
      const results = receipt.results;
      if (!Array.isArray(results) || results.length < 1 || results.length > 64 || results.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("Evaluator receipt results are invalid");
      const cases = results as JsonObject[];
      if (new Set(cases.map(item => item.case_id)).size !== cases.length || cases.some(item => !["passed", "failed"].includes(String(item.verdict)) || typeof item.input_digest !== "string" || typeof item.evidence_digest !== "string")) throw new Error("Evaluator receipt has duplicate or invalid case results");
      const environmentDigest = digest(receipt.environment_digest, "environment_digest");
      const expectedCases = request.evaluation_case_bindings as JsonObject[] | undefined;
      if (!expectedCases || expectedCases.length !== cases.length || expectedCases.some(expected => {
        const actual = cases.find(item => item.case_id === expected.case_id);
        return !actual || actual.input_digest !== expected.input_digest;
      })) throw new Error("Evaluator receipt cases do not match the frozen Evaluation Contract binding");
      const assertions = request.safety_assertions as string[];
      const safetyResults = receipt.safety_results;
      if (!Array.isArray(safetyResults) || safetyResults.length !== assertions.length || safetyResults.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
        throw new Error("Evaluator receipt safety results are missing or incomplete");
      }
      const expectedSafety = assertions.map(assertion => stableDigest(assertion));
      if (new Set(expectedSafety).size !== expectedSafety.length || new Set(safetyResults.map(item => item.assertion_digest)).size !== safetyResults.length
        || safetyResults.some(item => !expectedSafety.includes(String(item.assertion_digest))
          || !["passed", "failed"].includes(String(item.verdict)) || typeof item.evidence_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item.evidence_digest))) {
        throw new Error("Evaluator receipt safety results do not match the frozen assertions");
      }
      const passed = cases.every(item => item.verdict === "passed") && safetyResults.every(item => item.verdict === "passed");
      const evidence = this.store.save("evidence", `experience_external_eval_${stableDigest([request.id, receipt]).slice(-24)}`, {
        source_type: "program", confidence: "confirmed", record_origin: "experience_evaluator",
        claim: `Signed external Experience ${String(request.stage)} evaluation ${passed ? "passed" : "failed"}.`,
        locator: `experience-evaluator:${request.id}`, metadata: { experience_evaluation_dispatch_id: request.dispatch_id,
          procedure_id: request.procedure_id, procedure_version: request.procedure_version, definition_digest: request.definition_digest,
          baseline_version: request.baseline_version, stage: request.stage, status: passed ? "passed" : "failed",
          evaluation_contract_ref: request.evaluation_contract_ref, evaluation_contract_digest: request.evaluation_contract_digest,
          evaluation_case_set_digest: request.evaluation_case_set_digest, candidate_ref: request.candidate_ref,
          evaluator_ref: `${policy.id}@${policy.version}`, environment_digest: environmentDigest,
          external_receipt_digest: stableDigest(receipt), case_results_digest: stableDigest(cases) }
      });
      const result = gate({ dispatch_id: request.dispatch_id, evidence_ids: [evidence.id] });
      const consumed = this.store.save("experience_evaluator_request", String(request.id), { ...payload(request), status: "consumed",
        receipt_digest: stableDigest(receipt), evidence_id: evidence.id, consumed_at: new Date(this.now()).toISOString() });
      return { request: consumed, evidence, result, idempotent: false };
    });
  }
}
