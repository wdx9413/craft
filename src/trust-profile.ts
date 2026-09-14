import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function integer(value: unknown, name: string, fallback: number, minimum = 0): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return number;
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}
function list(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`);
  return result;
}

export type TrustRecommendation = "automatic" | "notify_only" | "human_approval" | "blocked";

/**
 * Evidence-backed, scoped autonomy. This kernel recommends an autonomy level;
 * it never grants an execution permission by itself. Trust is bounded by task,
 * capability, host, model, data/effect scope and an expiry time.
 */
export class TrustProfileKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  record(args: JsonObject): JsonObject {
    const profileId = String(args.profile_id ?? `trust_${randomUUID().replaceAll("-", "")}`);
    const scope = this.scope(args.scope);
    const passed = integer(args.passed, "passed", 0);
    const failed = integer(args.failed, "failed", 0);
    const interventions = integer(args.interventions, "interventions", 0);
    const attempts = passed + failed;
    if (!attempts) throw new Error("passed or failed evidence is required");
    if (passed > attempts || interventions > attempts) throw new Error("trust counts are inconsistent");
    const evidenceIds = list(args.evidence_ids, "evidence_ids");
    if (!evidenceIds.length) throw new Error("evidence_ids must contain at least one evidence reference");
    const validUntil = new Date(Date.now() + integer(args.ttl_seconds, "ttl_seconds", 86_400, 1) * 1_000).toISOString();
    const identity = { scope, attempts, passed, failed, interventions, evidence_ids: evidenceIds };
    const existing = this.store.find("trust_profile", profileId);
    if (existing) {
      if (existing.identity_digest !== digest(identity)) throw new Error("Trust profile idempotency conflict");
      return { profile: existing, idempotent: true, recommendation: this.recommend({ profile_id: profileId }) };
    }
    const profile = this.store.create("trust_profile", profileId, {
      ...scope, attempts, passed, failed, interventions, evidence_ids: evidenceIds,
      identity_digest: digest(identity), valid_until: validUntil, status: "active",
      last_reason: text(args.reason ?? "evidence_recorded", "reason"),
    });
    return { profile, idempotent: false, recommendation: this.recommend({ profile_id: profileId }) };
  }

  recommend(args: JsonObject): JsonObject {
    const profile = this.store.get("trust_profile", text(args.profile_id, "profile_id"));
    const attempts = Number(profile.attempts); const passed = Number(profile.passed);
    const passRate = attempts ? passed / attempts : 0;
    const expired = Date.parse(String(profile.valid_until)) <= Date.now();
    const revoked = profile.status === "revoked" || profile.status === "expired";
    let level: TrustRecommendation = "human_approval";
    let reason = "insufficient evidence for autonomous execution";
    if (revoked || expired) { level = "blocked"; reason = revoked ? "profile revoked" : "profile expired"; }
    else if (attempts >= 10 && passRate >= 0.99 && Number(profile.interventions) === 0) { level = "automatic"; reason = "stable scoped evidence with no interventions"; }
    else if (attempts >= 3 && passRate >= 0.9) { level = "notify_only"; reason = "repeated passing evidence supports notification-only autonomy"; }
    return { profile, recommendation: level, reason, pass_rate: passRate,
      execution_authority: false, requires_explicit_policy: true, expires_at: profile.valid_until,
      recommendation_digest: digest({ profile_id: profile.id, profile_version: profile.version, level, reason }) };
  }

  revoke(args: JsonObject): JsonObject {
    const profile = this.store.get("trust_profile", text(args.profile_id, "profile_id"));
    if (profile.status === "revoked") return { profile, idempotent: true };
    return { profile: this.store.save("trust_profile", String(profile.id), { ...payload(profile), status: "revoked", revoked_reason: text(args.reason ?? "manual_revoke", "reason") }), idempotent: false };
  }

  list(args: JsonObject = {}): JsonObject {
    const limit = integer(args.limit, "limit", 100, 1);
    const scopeKey = args.task_class === undefined ? null : text(args.task_class, "task_class");
    const profiles = this.store.list("trust_profile", limit, (item) => scopeKey === null || item.task_class === scopeKey);
    return { profiles, count: profiles.length };
  }

  get(args: JsonObject): JsonObject { return { profile: this.store.get("trust_profile", text(args.profile_id, "profile_id")) }; }

  private scope(args: unknown): JsonObject {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("scope must be an object");
    const input = args as JsonObject;
    return {
      task_class: text(input.task_class, "scope.task_class"),
      project_id: input.project_id === undefined ? null : text(input.project_id, "scope.project_id"),
      capability_revision: text(input.capability_revision, "scope.capability_revision"),
      model_ref: text(input.model_ref, "scope.model_ref"), host_ref: text(input.host_ref, "scope.host_ref"),
      effect: text(input.effect ?? "read_only", "scope.effect"), data_scope: text(input.data_scope ?? "project", "scope.data_scope"),
    };
  }
}
