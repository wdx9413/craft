import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const OPERATIONS = new Set(["index", "summarize", "draft", "prefetch_metadata"]);
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim();
}
function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`); return result;
}
function strings(value: unknown, name: string, minimum = 0): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (result.length < minimum || new Set(result).size !== result.length) throw new Error(`${name} must contain at least ${minimum} unique values`);
  return result;
}
function resources(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("estimated_resources must be an object");
  for (const [name, amount] of Object.entries(value)) if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new Error(`estimated_resources.${name} must be a non-negative finite number`);
  }
  return value as JsonObject;
}
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest;
}
function instant(value: unknown, name: string): number {
  const result = value === undefined ? Date.now() : Date.parse(text(value, name));
  if (Number.isNaN(result)) throw new Error(`${name} must be an ISO timestamp`); return result;
}
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export class SpeculativeKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  policySave(args: JsonObject): JsonObject {
    const policyId = text(args.policy_id, "policy_id"); const task = this.store.get("task", text(args.task_id, "task_id"));
    const operation = text(args.operation, "operation");
    if (!OPERATIONS.has(operation)) throw new Error("Speculative operation is not read-only or supported");
    const budget = this.store.get("budget_account", text(args.budget_id, "budget_id"));
    if (budget.status !== "active") throw new Error("Speculative budget must be active");
    const estimated = resources(args.estimated_resources ?? {}); const status = String(args.status ?? "active");
    if (!new Set(["active", "paused"]).has(status)) throw new Error("Speculative policy status is unsupported");
    const next = { task_id: task.id, name: text(args.name, "name"), event_key: text(args.event_key, "event_key"), operation,
      budget_id: budget.id, estimated_resources: estimated, ttl_seconds: integer(args.ttl_seconds, "ttl_seconds", 3600, 60, 86400),
      max_candidates: integer(args.max_candidates, "max_candidates", 10, 1, 100), status };
    const existing = this.store.find("speculative_policy", policyId);
    if (!existing) return { policy: this.store.create("speculative_policy", policyId, next) };
    if (Number(args.expected_version) !== Number(existing.version)) throw new Error("Speculative policy version conflict");
    return { policy: this.store.save("speculative_policy", policyId, next) };
  }

  enqueue(args: JsonObject): JsonObject {
    const policy = this.store.get("speculative_policy", text(args.policy_id, "policy_id"), integer(args.policy_version, "policy_version", 0, 1, Number.MAX_SAFE_INTEGER));
    if (policy.status !== "active") throw new Error("Speculative policy is not active");
    const event = this.store.get("trigger_event", text(args.trigger_event_id, "trigger_event_id"));
    const dispatch = event.dispatch as JsonObject | null;
    if (event.status !== "delivered" || !dispatch || dispatch.task_id !== policy.task_id || dispatch.event_key !== policy.event_key) {
      throw new Error("Trigger event does not match the active speculative policy");
    }
    const candidateId = `spec_${policy.id}_v${policy.version}_${event.id}`; const inputFingerprint = digest({
      event_digest: event.body_digest, dispatch, policy_id: policy.id, policy_version: policy.version, operation: policy.operation });
    const existing = this.store.find("speculative_candidate", candidateId);
    if (existing) {
      if (existing.input_fingerprint !== inputFingerprint) throw new Error("Speculative candidate idempotency conflict");
      return { candidate: existing, idempotent: true };
    }
    const active = this.store.list("speculative_candidate", 10_000, (item) => item.policy_id === policy.id &&
      item.policy_version === policy.version && new Set(["queued", "leased", "ready"]).has(String(item.status)));
    if (active.length >= Number(policy.max_candidates)) throw new Error("Speculative policy candidate limit reached");
    const reservation = this.store.get("budget_reservation", text(args.reservation_id, "reservation_id"));
    if (reservation.status !== "reserved" || reservation.budget_id !== policy.budget_id ||
      JSON.stringify(reservation.resources) !== JSON.stringify(policy.estimated_resources)) throw new Error("Speculative reservation does not match policy");
    const now = instant(args.now, "now");
    const candidate = this.store.create("speculative_candidate", candidateId, { policy_id: policy.id, policy_version: policy.version,
      task_id: policy.task_id, trigger_event_id: event.id, operation: policy.operation, input_fingerprint: inputFingerprint,
      reservation_id: reservation.id, status: "queued", trust: "untrusted_data", execution_authority: false,
      expires_at: new Date(now + Number(policy.ttl_seconds) * 1000).toISOString(), artifact_ids: [], evidence_ids: [] });
    return { candidate, idempotent: false };
  }

  claim(args: JsonObject): JsonObject {
    const workerId = text(args.worker_id, "worker_id"); const allowed = strings(args.operations, "operations", 1);
    if (allowed.some((item) => !OPERATIONS.has(item))) throw new Error("Worker declares an unsupported speculative operation");
    const now = instant(args.now, "now"); const candidate = this.store.list("speculative_candidate", 10_000, (item) =>
      item.status === "queued" && Date.parse(String(item.expires_at)) > now && allowed.includes(String(item.operation)))[0];
    if (!candidate) return { candidate: null };
    const lease = `lease_${randomUUID().replaceAll("-", "")}`; const saved = this.store.updateIfVersion("speculative_candidate", String(candidate.id), Number(candidate.version), {
      ...payload(candidate), status: "leased", lease_id: lease, claimed_by: workerId,
      lease_expires_at: new Date(now + integer(args.lease_ttl_seconds, "lease_ttl_seconds", 300, 30, 3600) * 1000).toISOString() });
    return { candidate: saved, dispatch: { candidate_id: saved.id, operation: saved.operation, input_fingerprint: saved.input_fingerprint,
      trigger_event_id: saved.trigger_event_id, trust: "untrusted_data", execution_authority: false } };
  }

  submit(args: JsonObject): JsonObject {
    const candidate = this.store.get("speculative_candidate", text(args.candidate_id, "candidate_id"));
    if (candidate.status !== "leased" || candidate.lease_id !== args.lease_id || candidate.claimed_by !== args.worker_id) throw new Error("Speculative candidate lease does not match");
    const now = instant(args.now, "now"); if (now > Date.parse(String(candidate.lease_expires_at))) throw new Error("Speculative candidate lease expired");
    const verdict = text(args.verdict, "verdict"); if (!new Set(["ready", "failed"]).has(verdict)) throw new Error("Speculative verdict is unsupported");
    const artifactIds = strings(args.artifact_ids ?? [], "artifact_ids"); const evidenceIds = strings(args.evidence_ids ?? [], "evidence_ids");
    if (verdict === "ready" && (!artifactIds.length || !evidenceIds.length)) throw new Error("A ready speculative candidate requires Artifact and Evidence");
    const saved = this.store.save("speculative_candidate", String(candidate.id), { ...payload(candidate), status: verdict,
      summary: text(args.summary, "summary"), artifact_ids: artifactIds, evidence_ids: evidenceIds, completed_at: new Date(now).toISOString(),
      lease_id: null, claimed_by: null, lease_expires_at: null });
    return { candidate: saved };
  }

  decide(args: JsonObject): JsonObject {
    const candidate = this.store.get("speculative_candidate", text(args.candidate_id, "candidate_id"));
    if (candidate.status !== "ready") throw new Error("Only a ready speculative candidate can be decided");
    const decision = text(args.decision, "decision"); if (!new Set(["accepted", "rejected"]).has(decision)) throw new Error("Speculative decision is unsupported");
    const finalArtifacts = strings(args.final_artifact_ids ?? candidate.artifact_ids, "final_artifact_ids");
    const reviewer = text(args.reviewer, "reviewer"); const correction = args.correction === undefined ? null : text(args.correction, "correction");
    const saved = this.store.save("speculative_candidate", String(candidate.id), { ...payload(candidate), status: decision,
      reviewer, correction, final_artifact_ids: finalArtifacts, decided_at: new Date(instant(args.now, "now")).toISOString() });
    const signal = this.store.create("preference_signal", `signal_${candidate.id}`, { task_id: candidate.task_id,
      candidate_id: candidate.id, source: "candidate_decision", decision, reviewer, correction,
      generated_artifact_ids: candidate.artifact_ids, final_artifact_ids: finalArtifacts,
      changed: digest(candidate.artifact_ids) !== digest(finalArtifacts) || correction !== null });
    return { candidate: saved, preference_signal: signal };
  }

  expire(args: JsonObject): JsonObject {
    const now = instant(args.now, "now"); const limit = integer(args.limit, "limit", 100, 1, 1000); const expired: JsonObject[] = [];
    for (const candidate of this.store.list("speculative_candidate", 10_000, (item) =>
      new Set(["queued", "leased", "ready"]).has(String(item.status)) && Date.parse(String(item.expires_at)) <= now).slice(0, limit)) {
      expired.push(this.store.updateIfVersion("speculative_candidate", String(candidate.id), Number(candidate.version), {
        ...payload(candidate), status: "expired", expired_at: new Date(now).toISOString(), lease_id: null, claimed_by: null, lease_expires_at: null }));
    }
    return { expired, count: expired.length };
  }
}
