import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
export class PlatformOperationsKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  memberSave(args: JsonObject): JsonObject {
    const memberId = String(args.member_id ?? `member_${randomUUID().replaceAll("-", "")}`);
    const name = text(args.name, "name");
    const roles = Array.isArray(args.roles) ? args.roles.map((item) => text(item, "roles")) : ["member"];
    const identityDigest = digest({ name, roles });
    const existing = this.store.find("platform_member", memberId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Member identity conflict"); return { member: existing, idempotent: true }; }
    return { member: this.store.create("platform_member", memberId, { name, roles, identity_digest: identityDigest, active: true }), idempotent: false };
  }

  authorize(args: JsonObject): JsonObject {
    const member = this.store.get("platform_member", text(args.member_id, "member_id"));
    const action = text(args.action, "action");
    const required = text(args.required_role ?? "member", "required_role");
    const allowed = member.active === true && ((member.roles as string[]).includes(required) || (member.roles as string[]).includes("admin"));
    const decision = this.store.create("platform_authorization", String(args.authorization_id ?? `authorization_${randomUUID().replaceAll("-", "")}`), { member_id: member.id, action, required_role: required, allowed, reason: allowed ? "role_granted" : "role_missing" });
    return { authorization: decision, allowed };
  }

  observe(args: JsonObject): JsonObject {
    const event = text(args.event, "event");
    const status = text(args.status ?? "ok", "status");
    const observation = this.store.create("platform_observation", String(args.observation_id ?? `observation_${randomUUID().replaceAll("-", "")}`), { event, status, run_id: args.run_id ?? null, metric: args.metric ?? null, value: args.value ?? null, value_digest: digest(args.value ?? null) });
    return { observation };
  }

  exportObservations(args: JsonObject): JsonObject {
    const limit = args.limit === undefined ? 100 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("limit must be an integer between 1 and 10000");
    const observations = this.store.list("platform_observation", limit);
    return { format: "craft.observability.v1", count: observations.length, observations: observations.map((item) => ({ id: item.id, event: item.event, status: item.status, run_id: item.run_id, value_digest: item.value_digest, created_at: item.created_at })) };
  }
}
