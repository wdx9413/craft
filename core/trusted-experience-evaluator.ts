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
  readonly rootPublicKeyPem: string;
  readonly now: () => number;
  constructor(store: CraftStore, rootPublicKeyPem: string, now: () => number = Date.now) {
    this.store = store; this.rootPublicKeyPem = publicKeyPem(rootPublicKeyPem); this.now = now;
  }

  importPolicy(args: JsonObject): JsonObject {
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
    const project = ((procedure.scenario_signature as JsonObject | undefined)?.project as JsonObject | undefined)?.id;
    const projectId = String(project ?? "").replace(/^project:/u, "");
    if (!(policy.project_ids as string[]).includes(projectId)) throw new Error("Evaluator policy is not authorized for this project");
    const requestId = safeId(args.request_id ?? `experience_eval_request_${stableDigest({ dispatch_id: dispatch.id, policy_version: policy.version }).slice(-20)}`, "request_id");
    const identity = { schema: "craft.experience-evaluation-request.v1", request_id: requestId, dispatch_id: dispatch.id,
      procedure_id: procedure.id, procedure_version: procedure.version, definition_digest: procedure.definition_digest,
      stage: dispatch.stage, baseline_version: dispatch.baseline_version ?? null, project_id: projectId,
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
      const policy = this.store.find("experience_evaluator_policy", String(request.policy_id));
      if (!policy || policy.revoked === true || policy.version !== request.policy_version) throw new Error("Evaluator policy was revoked or changed");
      if (request.status !== "issued") throw new Error("Evaluator request was already consumed");
      if (receipt.schema !== "craft.experience-evaluation-receipt.v1" || receipt.request_id !== request.id || receipt.nonce !== request.nonce) throw new Error("Evaluator receipt does not match its request");
      if (receipt.evaluator_id !== policy.evaluator_id || receipt.request_digest !== request.request_digest) throw new Error("Evaluator identity or request digest does not match");
      if (!Number.isSafeInteger(receipt.issued_at_ms) || Math.abs(this.now() - Number(receipt.issued_at_ms)) > 120_000) throw new Error("Evaluator receipt is outside the accepted time window");
      const signed = Buffer.concat([DOMAIN, Buffer.from(canonicalJson(receipt), "utf8")]);
      if (!verify(null, signed, createPublicKey(String(policy.public_key_pem)), signature)) throw new Error("Evaluator receipt signature is invalid");
      const results = receipt.results;
      if (!Array.isArray(results) || results.length < 1 || results.length > 64 || results.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("Evaluator receipt results are invalid");
      const cases = results as JsonObject[];
      if (new Set(cases.map(item => item.case_id)).size !== cases.length || cases.some(item => !["passed", "failed"].includes(String(item.verdict)) || typeof item.input_digest !== "string" || typeof item.evidence_digest !== "string")) throw new Error("Evaluator receipt has duplicate or invalid case results");
      const passed = cases.every(item => item.verdict === "passed");
      const evidence = this.store.save("evidence", `experience_external_eval_${stableDigest([request.id, receipt]).slice(-24)}`, {
        source_type: "program", confidence: passed ? "confirmed" : "rejected", record_origin: "experience_evaluator",
        claim: `Signed external Experience ${String(request.stage)} evaluation ${passed ? "passed" : "failed"}.`,
        locator: `experience-evaluator:${request.id}`, metadata: { experience_evaluation_dispatch_id: request.dispatch_id,
          procedure_id: request.procedure_id, procedure_version: request.procedure_version, definition_digest: request.definition_digest,
          baseline_version: request.baseline_version, stage: request.stage, status: passed ? "passed" : "failed",
          evaluator_ref: `${policy.id}@${policy.version}`, environment_digest: digest(receipt.environment_digest, "environment_digest"),
          external_receipt_digest: stableDigest(receipt), case_results_digest: stableDigest(cases) }
      });
      const result = gate({ dispatch_id: request.dispatch_id, evidence_ids: [evidence.id] });
      const consumed = this.store.save("experience_evaluator_request", String(request.id), { ...payload(request), status: "consumed",
        receipt_digest: stableDigest(receipt), evidence_id: evidence.id, consumed_at: new Date(this.now()).toISOString() });
      return { request: consumed, evidence, result, idempotent: false };
    });
  }
}
