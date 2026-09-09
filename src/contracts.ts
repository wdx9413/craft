import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const ADAPTERS = new Set(["api", "mcp", "computer_use"]);
const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive", "unknown"]);
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function object(value: unknown, name: string): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as JsonObject; }
function strings(value: unknown, name: string, minimum = 1): string[] { if (!Array.isArray(value) || value.length < minimum) throw new Error(`${name} must contain at least ${minimum} values`); const result = value.map((item) => text(item, name)); if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`); return result; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`; return JSON.stringify(value); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }

export class ContractInferenceKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  observe(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const adapter = text(args.adapter_kind, "adapter_kind");
    if (!ADAPTERS.has(adapter)) throw new Error("Contract adapter_kind is unsupported");
    const effect = text(args.observed_effect, "observed_effect"); if (!EFFECTS.has(effect)) throw new Error("Contract observed_effect is unsupported");
    const outcome = text(args.outcome, "outcome"); if (!new Set(["succeeded", "failed"]).has(outcome)) throw new Error("Contract observation outcome is unsupported");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids"); for (const id of evidenceIds) this.store.get("evidence", id);
    const inputSchema = object(args.input_schema, "input_schema"); const outputSchema = object(args.output_schema, "output_schema");
    const identity = { task_id: task.id, adapter_kind: adapter, endpoint: text(args.endpoint, "endpoint"), operation: text(args.operation, "operation"),
      input_schema_digest: digest(inputSchema), output_schema_digest: digest(outputSchema), observed_effect: effect,
      idempotency_observed: args.idempotency_observed === true, compensation_observed: args.compensation_observed === true,
      credential_handles_required: strings(args.credential_handles_required ?? [], "credential_handles_required", 0) };
    const observationId = String(args.observation_id ?? `contract_observation_${randomUUID().replaceAll("-", "")}`);
    const fingerprint = digest({ ...identity, outcome, evidence_ids: evidenceIds }); const existing = this.store.find("contract_observation", observationId);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new Error("Contract observation idempotency conflict"); return { observation: existing, idempotent: true }; }
    return { observation: this.store.create("contract_observation", observationId, { ...identity, input_schema: inputSchema,
      output_schema: outputSchema, outcome, evidence_ids: evidenceIds, fingerprint, raw_payload_stored: false }), idempotent: false };
  }

  infer(args: JsonObject): JsonObject {
    const ids = strings(args.observation_ids, "observation_ids", 2); const observations = ids.map((id) => this.store.get("contract_observation", id));
    const first = observations[0]; const same = ["task_id", "adapter_kind", "endpoint", "operation", "input_schema_digest", "output_schema_digest", "observed_effect"];
    if (observations.some((item) => same.some((key) => item[key] !== first[key]))) throw new Error("Contract observations are not structurally consistent");
    if (observations.some((item) => item.outcome !== "succeeded")) throw new Error("Contract inference requires successful observations");
    const candidateId = String(args.candidate_id ?? `contract_candidate_${randomUUID().replaceAll("-", "")}`);
    const candidateFingerprint = digest({ observation_ids: [...ids].sort() }); const existing = this.store.find("contract_candidate", candidateId);
    if (existing) { if (existing.candidate_fingerprint !== candidateFingerprint) throw new Error("Contract candidate idempotency conflict"); return { candidate: existing, idempotent: true }; }
    const unanimous = (field: string) => observations.every((item) => item[field] === first[field]) ? first[field] : "unknown";
    return { candidate: this.store.create("contract_candidate", candidateId, { task_id: first.task_id, adapter_kind: first.adapter_kind,
      endpoint: first.endpoint, operation: first.operation, input_schema: first.input_schema, output_schema: first.output_schema,
      effect: first.observed_effect, idempotency: unanimous("idempotency_observed"), compensation: unanimous("compensation_observed"),
      credential_handles_required: first.credential_handles_required, observation_ids: ids, candidate_fingerprint: candidateFingerprint,
      status: "candidate", confidence: "bounded", execution_authority: false }), idempotent: false };
  }

  review(args: JsonObject): JsonObject {
    const candidate = this.store.get("contract_candidate", text(args.candidate_id, "candidate_id"));
    if (candidate.status !== "candidate") throw new Error("Contract candidate is not awaiting review");
    const decision = text(args.decision, "decision"); if (!new Set(["accept", "reject"]).has(decision)) throw new Error("Contract review decision is unsupported");
    const corrected = args.corrected_contract === undefined ? null : object(args.corrected_contract, "corrected_contract");
    if (decision === "reject" && corrected) throw new Error("Rejected contracts cannot include corrections");
    const contract = corrected ?? { input_schema: candidate.input_schema, output_schema: candidate.output_schema, effect: candidate.effect,
      idempotency: candidate.idempotency, compensation: candidate.compensation, credential_handles_required: candidate.credential_handles_required };
    if (decision === "accept" && !EFFECTS.has(String(contract.effect))) throw new Error("Reviewed contract effect is unsupported");
    return { candidate: this.store.save("contract_candidate", String(candidate.id), { ...payload(candidate), status: decision === "accept" ? "reviewed" : "rejected",
      reviewed_contract: contract, reviewer: text(args.reviewer, "reviewer"), review_ref: text(args.review_ref, "review_ref"), execution_authority: false }) };
  }

  verify(args: JsonObject): JsonObject {
    const candidate = this.store.get("contract_candidate", text(args.candidate_id, "candidate_id")); if (candidate.status !== "reviewed") throw new Error("Contract candidate is not reviewed");
    const sandbox = this.store.get("sandbox_profile", text(args.sandbox_profile_id, "sandbox_profile_id"), Number(args.sandbox_profile_version));
    if (sandbox.status !== "verified") throw new Error("Contract verification requires a verified Sandbox Profile");
    const trial = this.store.get("trial", text(args.trial_id, "trial_id")); if (trial.task_id !== candidate.task_id) throw new Error("Contract verification Trial belongs to another task");
    const outcome = this.store.get("outcome", `outcome_${trial.id}`); if (outcome.verdict !== "passed" || !Array.isArray(outcome.evidence_ids) || !outcome.evidence_ids.length) throw new Error("Contract verification requires a passed evidence-backed Trial");
    const verified = this.store.save("contract_candidate", String(candidate.id), { ...payload(candidate), status: "verified",
      sandbox_profile_id: sandbox.id, sandbox_profile_version: sandbox.version, verification_trial_id: trial.id,
      verification_outcome_id: outcome.id, execution_authority: false });
    return { contract: verified, executable: false };
  }

  diff(args: JsonObject): JsonObject {
    const baseline = this.store.get("contract_candidate", text(args.baseline_id, "baseline_id"), Number(args.baseline_version));
    const candidate = this.store.get("contract_candidate", text(args.candidate_id, "candidate_id"), Number(args.candidate_version));
    if (baseline.adapter_kind !== candidate.adapter_kind || baseline.endpoint !== candidate.endpoint || baseline.operation !== candidate.operation) throw new Error("Contract diff subjects are unrelated");
    const left = object(baseline.reviewed_contract, "baseline reviewed_contract"); const right = object(candidate.reviewed_contract, "candidate reviewed_contract");
    const changes: JsonObject[] = []; const add = (field: string, breaking: boolean) => { if (canonical(left[field]) !== canonical(right[field])) changes.push({ field, breaking }); };
    add("input_schema", true); add("output_schema", true); add("effect", true); add("credential_handles_required", true);
    add("idempotency", left.idempotency === true && right.idempotency !== true); add("compensation", left.compensation === true && right.compensation !== true);
    return { baseline: { id: baseline.id, version: baseline.version }, candidate: { id: candidate.id, version: candidate.version },
      classification: changes.some((item) => item.breaking) ? "breaking" : changes.length ? "compatible" : "equivalent", changes };
  }

  publish(args: JsonObject): JsonObject {
    const contract = this.store.get("contract_candidate", text(args.candidate_id, "candidate_id"), Number(args.candidate_version));
    if (contract.status !== "verified") throw new Error("Only a verified Contract can be published");
    const publisher = text(args.publisher, "publisher"); if (publisher === contract.reviewer) throw new Error("Contract publication requires an independent publisher");
    const reviewed = object(contract.reviewed_contract, "reviewed_contract"); const effect = String(reviewed.effect);
    if (!new Set(["read_only", "local_write", "external_write", "destructive"]).has(effect)) throw new Error("Contract publication effect is not executable");
    const publicationId = String(args.publication_id ?? `contract_publication_${randomUUID().replaceAll("-", "")}`);
    const fingerprint = digest({ candidate_id: contract.id, candidate_version: contract.version, asset_id: args.asset_id });
    const existing = this.store.find("contract_publication", publicationId);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new Error("Contract publication idempotency conflict"); return { publication: existing, asset: this.store.get("capability_asset", String(existing.asset_id), Number(existing.asset_version)), idempotent: true }; }
    const assetId = text(args.asset_id, "asset_id"); const current = this.store.find("capability_asset", assetId);
    const asset = this.store.save("capability_asset", assetId, { name: text(args.name, "name"), asset_type: "adapter", trust: "verified", health: "healthy",
      effect, source_uri: `craft://contracts/${contract.id}/${contract.version}`, dependencies: [], aliases: [], requires_credential: Array.isArray(reviewed.credential_handles_required) && reviewed.credential_handles_required.length > 0,
      cost_hint: {}, source_digest: digest(reviewed), contract_id: contract.id, contract_version: contract.version }, current ? Number(current.version) + 1 : 1);
    const publication = this.store.create("contract_publication", publicationId, { candidate_id: contract.id, candidate_version: contract.version,
      asset_id: asset.id, asset_version: asset.version, publisher, approval_ref: text(args.approval_ref, "approval_ref"), fingerprint, status: "active" });
    return { publication, asset, idempotent: false };
  }

  rollback(args: JsonObject): JsonObject {
    const publication = this.store.get("contract_publication", text(args.publication_id, "publication_id")); if (publication.status !== "active") throw new Error("Contract publication is not active");
    const asset = this.store.get("capability_asset", String(publication.asset_id)); if (Number(asset.version) !== Number(publication.asset_version)) throw new Error("Contract publication no longer owns the active capability version");
    const retired = this.store.save("capability_asset", String(asset.id), { ...payload(asset), health: "stale", rollback_reason: text(args.reason, "reason") });
    const rolledBack = this.store.save("contract_publication", String(publication.id), { ...payload(publication), status: "rolled_back", retired_asset_version: retired.version,
      rolled_back_by: text(args.actor, "actor"), rollback_ref: text(args.rollback_ref, "rollback_ref") });
    return { publication: rolledBack, asset: retired };
  }
}
