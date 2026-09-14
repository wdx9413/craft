import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const TRUSTED = new Set(["trusted", "verified"]);
const REQUIRED_RECOVERY_CHECKS = ["rehydration_verified", "receipt_revalidated", "state_reobserved"] as const;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...value } = record;
  return value;
}
function iso(value: unknown, name: string): string {
  const result = text(value, name); if (!Number.isFinite(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}
function confirmedEvidence(store: CraftStore, value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error("evidence_ids must contain at least one value");
  const ids = value.map((item) => text(item, "evidence_id"));
  if (new Set(ids).size !== ids.length) throw new Error("evidence_ids must be unique");
  for (const id of ids) if (store.get("evidence", id).confidence !== "confirmed") throw new Error("Recovery drill requires confirmed Evidence");
  return ids.sort();
}

/**
 * The final evidence seam for a real, bounded Host attempt. It does not start
 * model work or fetch sealed Case content. Instead it proves that a Host
 * receipt, recovery drill, selected capability versions and one-time sealed
 * evaluation access still agree before an attempt is admitted as a Pilot.
 */
export class AssuredPilotKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  sealCase(args: JsonObject): JsonObject {
    const caseRecord = this.store.get("delivery_evaluation_case", text(args.case_id, "case_id"));
    if (caseRecord.partition !== "held_out" || caseRecord.sanitized !== true || !caseRecord.approved_by) throw new Error("Only independently approved sanitized held-out Cases may be sealed");
    const identity = { case_id: caseRecord.id, case_version: caseRecord.version, case_digest: caseRecord.definition_digest,
      custodian: text(args.custodian, "custodian"), opaque_locator_digest: text(args.opaque_locator_digest, "opaque_locator_digest"), approval_ref: text(args.approval_ref, "approval_ref") };
    const sealedCaseId = String(args.sealed_case_id ?? `sealed_eval_case_${caseRecord.id}_${caseRecord.version}`); const existing = this.store.find("sealed_evaluation_case", sealedCaseId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Sealed evaluation Case idempotency conflict"); return { sealed_case: existing, idempotent: true }; }
    return { sealed_case: this.store.create("sealed_evaluation_case", sealedCaseId, { ...identity, identity_digest: identityDigest, raw_case_stored: false, status: "sealed" }), idempotent: false };
  }

  issueSealedAccess(args: JsonObject): JsonObject {
    const sealed = this.sealed(args.sealed_case_id); this.assertSealedCaseCurrent(sealed);
    const run = this.store.get("task_run", text(args.task_run_id, "task_run_id")); const expiresAt = iso(args.expires_at, "expires_at");
    const identity = { sealed_case_id: sealed.id, sealed_case_version: sealed.version, task_run_id: run.id, task_run_version: run.version,
      recipient: text(args.recipient, "recipient"), expires_at: expiresAt, purpose: "evaluation" };
    const accessId = String(args.access_id ?? `sealed_eval_access_${digest(identity).slice(-16)}`); const existing = this.store.find("sealed_evaluation_access", accessId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Sealed evaluation access idempotency conflict"); return { access: existing, idempotent: true }; }
    return { access: this.store.create("sealed_evaluation_access", accessId, { ...identity, identity_digest: identityDigest, status: "issued", raw_case_stored: false }), idempotent: false };
  }

  consumeSealedAccess(args: JsonObject): JsonObject {
    const access = this.store.get("sealed_evaluation_access", text(args.access_id, "access_id"));
    const now = args.now === undefined ? new Date().toISOString() : iso(args.now, "now");
    if (access.task_run_id !== text(args.task_run_id, "task_run_id")) throw new Error("Sealed evaluation access Task Run does not match");
    if (access.status !== "issued") throw new Error("Sealed evaluation access was already consumed");
    if (Date.parse(String(access.expires_at)) <= Date.parse(now)) throw new Error("Sealed evaluation access has expired");
    this.assertSealedCaseCurrent(this.sealed(access.sealed_case_id));
    return { access: this.store.save("sealed_evaluation_access", String(access.id), { ...payload(access), status: "consumed", consumed_at: now }), idempotent: false };
  }

  recordRecovery(args: JsonObject): JsonObject {
    const run = this.store.get("task_run", text(args.task_run_id, "task_run_id"));
    const attestation = this.store.get("runtime_assurance_attestation", text(args.attestation_id, "attestation_id"));
    const readiness = this.store.get("runtime_readiness_assessment", text(args.readiness_id, "readiness_id"));
    const environmentDigest = text(args.environment_digest, "environment_digest");
    this.assertRecoveryFacts(run, attestation, readiness, environmentDigest);
    const checks = args.checks; if (!checks || typeof checks !== "object" || Array.isArray(checks) || REQUIRED_RECOVERY_CHECKS.some((key) => (checks as JsonObject)[key] !== true)) throw new Error("Recovery drill requires every recovery check");
    const evidenceIds = confirmedEvidence(this.store, args.evidence_ids);
    const identity = { task_run_id: run.id, task_run_version: run.version, attestation_id: attestation.id, attestation_version: attestation.version,
      readiness_id: readiness.id, readiness_version: readiness.version, environment_digest: environmentDigest, checks: REQUIRED_RECOVERY_CHECKS, evidence_ids: evidenceIds };
    const drillId = String(args.drill_id ?? `runtime_recovery_drill_${digest(identity).slice(-16)}`); const existing = this.store.find("runtime_recovery_drill", drillId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Recovery drill idempotency conflict"); return { drill: existing, idempotent: true }; }
    return { drill: this.store.create("runtime_recovery_drill", drillId, { ...identity, identity_digest: identityDigest, status: "passed", deployment_claimed: false }), idempotent: false };
  }

  prepare(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id"));
    const run = this.store.get("task_run", text(args.task_run_id, "task_run_id"));
    const attestation = this.store.get("runtime_assurance_attestation", text(args.attestation_id, "attestation_id"));
    const readiness = this.store.get("runtime_readiness_assessment", text(args.readiness_id, "readiness_id"));
    const drill = this.store.get("runtime_recovery_drill", text(args.recovery_drill_id, "recovery_drill_id"));
    const profile = this.store.get("activation_profile", text(args.activation_profile_id, "activation_profile_id"));
    const access = this.store.get("sealed_evaluation_access", text(args.sealed_access_id, "sealed_access_id"));
    this.assertPilotFacts(task, run, attestation, readiness, drill, access);
    this.assertProfile(profile, String(task.id)); this.assertSealedCaseCurrent(this.sealed(access.sealed_case_id));
    const identity = { task_id: task.id, task_run_id: run.id, task_run_version: run.version, environment_digest: run.environment_digest,
      attestation: { id: attestation.id, version: attestation.version }, readiness: { id: readiness.id, version: readiness.version }, recovery_drill: { id: drill.id, version: drill.version }, activation_profile: { id: profile.id, version: profile.version }, sealed_access: { id: access.id, version: access.version } };
    const pilotId = String(args.pilot_id ?? `assured_pilot_${digest(identity).slice(-16)}`); const existing = this.store.find("assured_work_pilot", pilotId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Assured Pilot idempotency conflict"); return { pilot: existing, idempotent: true }; }
    return { pilot: this.store.create("assured_work_pilot", pilotId, { ...identity, identity_digest: identityDigest, status: "evidence_bound", deployment_claimed: false }), idempotent: false };
  }

  reassess(args: JsonObject): JsonObject {
    const pilot = this.store.get("assured_work_pilot", text(args.pilot_id, "pilot_id")); const attention = this.attention(pilot, text(args.environment_digest, "environment_digest"));
    const status = attention.length ? "needs_replan" : "evidence_bound";
    const saved = pilot.status === status && JSON.stringify(pilot.attention) === JSON.stringify(attention) ? pilot : this.store.save("assured_work_pilot", String(pilot.id), { ...payload(pilot), status, attention });
    return { pilot: saved, attention, idempotent: saved === pilot };
  }

  get(args: JsonObject): JsonObject {
    const pilot = this.store.get("assured_work_pilot", text(args.pilot_id, "pilot_id"));
    return { pilot, task_run: this.store.get("task_run", String(pilot.task_run_id)), attestation: this.store.get("runtime_assurance_attestation", String((pilot.attestation as JsonObject).id), Number((pilot.attestation as JsonObject).version)), readiness: this.store.get("runtime_readiness_assessment", String((pilot.readiness as JsonObject).id), Number((pilot.readiness as JsonObject).version)), recovery_drill: this.store.get("runtime_recovery_drill", String((pilot.recovery_drill as JsonObject).id), Number((pilot.recovery_drill as JsonObject).version)), activation_profile: this.store.get("activation_profile", String((pilot.activation_profile as JsonObject).id), Number((pilot.activation_profile as JsonObject).version)), sealed_access: this.store.get("sealed_evaluation_access", String((pilot.sealed_access as JsonObject).id), Number((pilot.sealed_access as JsonObject).version)), attention: (pilot.attention as string[] | undefined) ?? [] };
  }

  private sealed(id: unknown): JsonObject { return this.store.get("sealed_evaluation_case", text(id, "sealed_case_id")); }

  private assertRecoveryFacts(run: JsonObject, attestation: JsonObject, readiness: JsonObject, environmentDigest: string): void {
    const taskId = String((run.launch_identity as JsonObject).task_id);
    const matches = [attestation.status === "verified", attestation.task_run_id === run.id, readiness.status === "ready",
      readiness.task_id === taskId, run.environment_digest === environmentDigest, attestation.environment_digest === environmentDigest,
      readiness.environment_digest === environmentDigest];
    if (matches.some((item) => !item)) throw new Error("Recovery drill requires one ready runtime and verified unchanged assurance");
  }

  private assertPilotFacts(task: JsonObject, run: JsonObject, attestation: JsonObject, readiness: JsonObject, drill: JsonObject, access: JsonObject): void {
    const matches = [(run.launch_identity as JsonObject).task_id === task.id, attestation.status === "verified", attestation.task_run_id === run.id,
      readiness.status === "ready", readiness.task_id === task.id, drill.status === "passed", drill.task_run_id === run.id,
      drill.attestation_id === attestation.id, drill.readiness_id === readiness.id, access.status === "consumed", access.task_run_id === run.id];
    if (matches.some((item) => !item)) throw new Error("Assured Pilot facts are not bound to one verified Task Run");
  }

  private assertSealedCaseCurrent(sealed: JsonObject): void {
    const current = this.store.get("delivery_evaluation_case", String(sealed.case_id));
    if (current.version !== sealed.case_version || current.definition_digest !== sealed.case_digest || current.partition !== "held_out" || current.sanitized !== true) throw new Error("Sealed evaluation Case drifted and must be sealed again");
  }

  private assertProfile(profile: JsonObject, taskId: string): void {
    if (profile.task_id !== taskId || !Array.isArray(profile.asset_ids) || !profile.asset_ids.length || !profile.asset_versions || typeof profile.asset_versions !== "object") throw new Error("Activation Profile is invalid for Assured Pilot");
    for (const assetId of profile.asset_ids as string[]) {
      const version = Number((profile.asset_versions as JsonObject)[assetId]); const current = this.store.get("capability_asset", assetId); const asset = this.store.get("capability_asset", assetId, version);
      if (current.version !== version) throw new Error("Activation Profile capability version drifted");
      if (!TRUSTED.has(String(asset.trust)) || asset.health !== "healthy" || asset.requires_credential === true || !(profile.allowed_effects as string[]).includes(String(asset.effect))) throw new Error("Activation Profile capability is no longer eligible");
    }
  }

  private attention(pilot: JsonObject, environmentDigest: string): string[] {
    const run = this.store.get("task_run", String(pilot.task_run_id)); const reasons: string[] = [];
    if (run.version !== pilot.task_run_version || run.environment_digest !== environmentDigest) reasons.push("task_run_or_environment_drift");
    try { this.assertProfile(this.store.get("activation_profile", String((pilot.activation_profile as JsonObject).id), Number((pilot.activation_profile as JsonObject).version)), String(pilot.task_id)); } catch { reasons.push("capability_profile_drift"); }
    try { this.assertSealedCaseCurrent(this.sealed((this.store.get("sealed_evaluation_access", String((pilot.sealed_access as JsonObject).id), Number((pilot.sealed_access as JsonObject).version))).sealed_case_id)); } catch { reasons.push("sealed_case_drift"); }
    const invalidation = this.store.list("work_loop_invalidation", 10_000, (item) => item.task_run_id === run.id && item.status === "needs_replan"); if (invalidation.length) reasons.push("human_or_workspace_drift");
    return reasons.sort();
  }
}
