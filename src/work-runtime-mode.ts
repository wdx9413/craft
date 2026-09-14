import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const MODES = new Set(["console", "agent"]);
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function strings(value: unknown, name: string): string[] { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); const result = value.map((item) => text(item, name)); if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`); return result.sort(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

/** Product-mode projection over the existing Host, Activation Profile and Work Loop seams. */
export class WorkRuntimeModeKernel {
  readonly store: CraftStore;
  readonly hosts: ReadonlySet<string>;
  constructor(store: CraftStore, hosts: Iterable<string>) { this.store = store; this.hosts = new Set(hosts); }

  configure(args: JsonObject): JsonObject {
    const mode = text(args.mode, "mode"); if (!MODES.has(mode)) throw new Error("Work Runtime mode is unsupported");
    const allowedHosts = strings(args.allowed_hosts, "allowed_hosts"); if (allowedHosts.some((host) => !this.hosts.has(host))) throw new Error("Work Runtime mode references an unavailable Host");
    const profileId = String(args.profile_id ?? `work_runtime_mode_${mode}`); const identity = { mode, allowed_hosts: allowedHosts, default_host: args.default_host === undefined ? null : text(args.default_host, "default_host"), default_model: args.default_model === undefined ? null : text(args.default_model, "default_model") };
    if (identity.default_host !== null && !allowedHosts.includes(identity.default_host)) throw new Error("Work Runtime default_host must be allowed");
    if (mode === "agent" && identity.default_model === null) throw new Error("Agent Work Runtime mode requires default_model");
    const existing = this.store.find("work_runtime_mode", profileId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Work Runtime mode idempotency conflict"); return { profile: existing, idempotent: true }; }
    return { profile: this.store.create("work_runtime_mode", profileId, { ...identity, identity_digest: identityDigest, status: "active", execution_authority: false }), idempotent: false };
  }

  prepare(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const profile = this.store.get("work_runtime_mode", text(args.profile_id, "profile_id"));
    const host = text(args.host ?? profile.default_host, "host"); if (!this.hosts.has(host) || !(profile.allowed_hosts as string[]).includes(host)) throw new Error("Work Runtime Host is not allowed by the selected mode");
    const model = args.model === undefined ? profile.default_model : text(args.model, "model"); if (profile.mode === "agent" && model === null) throw new Error("Agent Work Runtime requires a model");
    const activation = args.activation_profile_id === undefined ? null : this.store.get("activation_profile", text(args.activation_profile_id, "activation_profile_id"));
    if (activation && activation.task_id !== task.id) throw new Error("Activation Profile belongs to another Task");
    const context = args.context_receipt_id === undefined ? null : this.store.get("context_resolution_receipt", text(args.context_receipt_id, "context_receipt_id"));
    const planId = String(args.plan_id ?? `work_runtime_plan_${randomUUID().replaceAll("-", "")}`); const identity = { task_id: task.id, task_version: task.version, mode_profile_id: profile.id, mode_profile_version: profile.version, host, model, activation_profile_id: activation?.id ?? null, activation_profile_version: activation?.version ?? null, context_receipt_id: context?.id ?? null, context_receipt_version: context?.version ?? null };
    const existing = this.store.find("work_runtime_plan", planId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Work Runtime plan idempotency conflict"); return { plan: existing, idempotent: true }; }
    return { plan: this.store.create("work_runtime_plan", planId, { ...identity, identity_digest: identityDigest, status: "ready_for_verified_work_loop", dispatches_host: false, execution_authority: false }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { plan: this.store.get("work_runtime_plan", text(args.plan_id, "plan_id"), args.version === undefined ? undefined : Number(args.version)) }; }
}
