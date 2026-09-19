import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { PlatformExecutionKernel } from "./platform-execution.ts";
import { text } from "./validation.ts";
import { digestJson } from "./digest.ts";

const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);

function strings(value: unknown, name: string): string[] { if (!Array.isArray(value) || !value.length) throw new Error(`${name} must contain at least one value`); const result = value.map((item) => text(item, name)); if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`); return result.sort(); }

function confirmed(store: CraftStore, ids: string[]): void { for (const id of ids) if (store.get("evidence", id).confidence !== "confirmed") throw new Error("Runtime readiness requires confirmed Evidence"); }

/**
 * A deployment checklist expressed as durable facts. It never claims a sandbox,
 * broker or host is live merely because Craft has a configuration record.
 */
export class RuntimeReadinessKernel {
  readonly store: CraftStore; readonly platform: PlatformExecutionKernel;
  constructor(store: CraftStore, platform: PlatformExecutionKernel) { this.store = store; this.platform = platform; }

  assess(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const effect = text(args.effect, "effect"); if (!EFFECTS.has(effect)) throw new Error("Runtime readiness effect is unsupported");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids"); confirmed(this.store, evidenceIds);
    const blockers: string[] = []; const platform = text(args.platform, "platform"); const host = text(args.host, "host"); const workspaceRecovery = args.workspace_recovery === true;
    let preflight: JsonObject | null = null; let enterpriseBinding: JsonObject | null = null;
    if (effect === "local_write") {
      if (!workspaceRecovery) blockers.push("workspace_recovery_missing");
      if (args.preflight_id === undefined) blockers.push("platform_preflight_missing");
      else { try { preflight = this.platform.validate({ preflight_id: text(args.preflight_id, "preflight_id") }).preflight as JsonObject; } catch { blockers.push("platform_preflight_invalid"); } }
    }
    if (effect === "external_write" || effect === "destructive") {
      if (args.enterprise_binding_id === undefined) blockers.push("enterprise_binding_missing");
      else {
        enterpriseBinding = this.store.get("enterprise_adapter_binding", text(args.enterprise_binding_id, "enterprise_binding_id"));
        if (enterpriseBinding.lifecycle !== "active" || !(enterpriseBinding.allowed_effects as string[]).includes(effect)) blockers.push("enterprise_binding_invalid");
      }
      if (args.compensation_ref === undefined && effect === "destructive") blockers.push("compensation_or_human_disposition_missing");
    }
    const identity = { task_id: task.id, host, platform, effect, environment_digest: text(args.environment_digest, "environment_digest"), workspace_recovery: workspaceRecovery, preflight_id: preflight?.id ?? null, preflight_version: preflight?.version ?? null, enterprise_binding_id: enterpriseBinding?.id ?? null, enterprise_binding_version: enterpriseBinding?.version ?? null, compensation_ref: args.compensation_ref ?? null, evidence_ids: evidenceIds, blockers: blockers.sort() };
    const assessmentId = String(args.assessment_id ?? `runtime_readiness_${digestJson(identity).slice(-16)}`); const existing = this.store.find("runtime_readiness_assessment", assessmentId); const assessmentDigest = digestJson(identity);
    if (existing) { if (existing.assessment_digest !== assessmentDigest) throw new Error("Runtime readiness assessment idempotency conflict"); return { assessment: existing, idempotent: true }; }
    return { assessment: this.store.create("runtime_readiness_assessment", assessmentId, { ...identity, assessment_digest: assessmentDigest, status: blockers.length ? "blocked" : "ready", deployment_claimed: false }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { assessment: this.store.get("runtime_readiness_assessment", text(args.assessment_id, "assessment_id")) }; }

}
