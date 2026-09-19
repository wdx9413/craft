import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";


function finite(value: unknown, name: string, fallback = 0): number { const result = value === undefined ? fallback : Number(value); if (!Number.isFinite(result) || result < 0) throw new Error(`${name} must be a non-negative finite number`); return result; }


function mean(values: number[]): number { return values.reduce((sum, item) => sum + item, 0) / values.length; }

export class ReleaseQualificationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  pilotSave(args: JsonObject): JsonObject {
    const kind = text(args.kind, "kind"); if (!new Set(["development", "file_delivery"]).has(kind)) throw new Error("Reference Pilot kind is unsupported");
    if (args.sanitized !== true || args.content_stored === true) throw new Error("Reference Pilot must be sanitized and content-free");
    const direction = text(args.direction ?? "lower_is_better", "direction"); if (!new Set(["lower_is_better", "higher_is_better"]).has(direction)) throw new Error("Reference Pilot metric direction is unsupported");
    const identity = { kind, name: text(args.name, "name"), case_ref: text(args.case_ref, "case_ref"), host: text(args.host ?? "codex", "host"), primary_metric: text(args.primary_metric, "primary_metric"), direction, effect_threshold: finite(args.effect_threshold, "effect_threshold"), guardrail_names: Array.isArray(args.guardrail_names) ? [...new Set(args.guardrail_names.map((item) => text(item, "guardrail_names")))].sort() : [], sanitized: true, content_stored: false };
    const pilotId = String(args.pilot_id ?? `reference_pilot_${kind}`); const definitionDigest = digestJson(identity); const existing = this.store.find("reference_pilot", pilotId);
    if (existing) { if (existing.definition_digest !== definitionDigest) throw new Error("Reference Pilot idempotency conflict"); return { pilot: existing, idempotent: true }; }
    return { pilot: this.store.create("reference_pilot", pilotId, { ...identity, definition_digest: definitionDigest }), idempotent: false };
  }

  plan(args: JsonObject): JsonObject {
    const pilot = this.store.get("reference_pilot", text(args.pilot_id, "pilot_id")); const environment = text(args.environment_fingerprint, "environment_fingerprint"); const budget = text(args.budget_fingerprint, "budget_fingerprint");
    const identity = { pilot_id: pilot.id, pilot_version: pilot.version, baseline_ref: text(args.baseline_ref, "baseline_ref"), candidate_ref: text(args.candidate_ref, "candidate_ref"), environment_fingerprint: environment, budget_fingerprint: budget, trials_per_arm: 5 };
    const qualificationId = String(args.qualification_id ?? `release_qualification_${pilot.id}_${digestJson(identity).slice(-12)}`); const identityDigest = digestJson(identity); const existing = this.store.find("release_qualification", qualificationId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Release Qualification idempotency conflict"); return { qualification: existing, slots: this.store.list("release_qualification_slot", 20, (item) => item.qualification_id === existing.id), idempotent: true }; }
    const qualification = this.store.create("release_qualification", qualificationId, { ...identity, identity_digest: identityDigest, lifecycle: "collecting", conclusion: "inconclusive" });
    const slots: JsonObject[] = []; for (const arm of ["baseline", "candidate"]) for (let index = 1; index <= 5; index += 1) slots.push(this.store.create("release_qualification_slot", `${qualificationId}_${arm}_${index}`, { qualification_id: qualification.id, arm, pair_index: index, status: "pending" }));
    return { qualification, slots, idempotent: false };
  }

  record(args: JsonObject): JsonObject {
    const slot = this.store.get("release_qualification_slot", text(args.slot_id, "slot_id")); if (slot.status === "completed") return { slot, idempotent: true }; if (slot.status !== "pending") throw new Error("Release Qualification slot is not pending");
    const guardrails = args.guardrails && typeof args.guardrails === "object" && !Array.isArray(args.guardrails) ? args.guardrails as JsonObject : {}; if (Object.values(guardrails).some((item) => typeof item !== "boolean")) throw new Error("Release Qualification guardrails must be booleans");
    const evidenceIds = Array.isArray(args.evidence_ids) ? args.evidence_ids.map((item) => text(item, "evidence_ids")) : []; if (!evidenceIds.length) throw new Error("Release Qualification result requires Evidence");
    for (const id of evidenceIds) if (!new Set(["confirmed", "bounded"]).has(String(this.store.get("evidence", id).confidence))) throw new Error("Release Qualification Evidence must be confirmed or bounded");
    return { slot: this.store.save("release_qualification_slot", String(slot.id), { ...payload(slot), status: "completed", mechanism_passed: args.mechanism_passed === true, primary_value: finite(args.primary_value, "primary_value"), guardrails, evidence_ids: evidenceIds, environment_fingerprint: text(args.environment_fingerprint, "environment_fingerprint"), budget_fingerprint: text(args.budget_fingerprint, "budget_fingerprint") }), idempotent: false };
  }

  evaluate(args: JsonObject): JsonObject {
    const qualification = this.store.get("release_qualification", text(args.qualification_id, "qualification_id")); if (qualification.lifecycle === "completed") return { qualification, idempotent: true };
    const pilot = this.store.get("reference_pilot", String(qualification.pilot_id)); const slots = this.store.list("release_qualification_slot", 20, (item) => item.qualification_id === qualification.id);
    if (slots.length !== 10 || slots.some((item) => item.status !== "completed")) return { qualification, conclusion: "inconclusive", idempotent: true };
    const comparable = slots.every((item) => item.environment_fingerprint === qualification.environment_fingerprint && item.budget_fingerprint === qualification.budget_fingerprint); const mechanism = slots.every((item) => item.mechanism_passed === true); const guardrails = slots.every((item) => Object.values(item.guardrails as JsonObject).every((value) => value === true));
    const baseline = slots.filter((item) => item.arm === "baseline").sort((a, b) => Number(a.pair_index) - Number(b.pair_index)); const candidate = slots.filter((item) => item.arm === "candidate").sort((a, b) => Number(a.pair_index) - Number(b.pair_index));
    const deltas = baseline.map((item, index) => Number(candidate[index]!.primary_value) - Number(item.primary_value)); const signed = pilot.direction === "lower_is_better" ? deltas.map((item) => -item) : deltas; const improvement = mean(signed); const wins = signed.filter((item) => item > 0).length;
    const conclusion = !comparable ? "inconclusive" : !mechanism || !guardrails ? "rejected" : improvement >= Number(pilot.effect_threshold) && wins >= 3 ? "eligible" : signed.some((item) => item < 0) && improvement < 0 ? "rejected" : "inconclusive";
    const saved = this.store.save("release_qualification", String(qualification.id), { ...payload(qualification), lifecycle: "completed", conclusion, comparable, mechanism_passed: mechanism, guardrails_passed: guardrails, primary_improvement: improvement, paired_wins: wins, recommendation: conclusion === "eligible" ? "candidate_may_enter_signoff" : conclusion === "rejected" ? "rollback_and_attribute_failure" : "improve_case_environment_or_metrics" });
    return { qualification: saved, conclusion, idempotent: false };
  }

  platformAssess(args: JsonObject): JsonObject {
    const development = this.store.get("release_qualification", text(args.development_qualification_id, "development_qualification_id")); const file = this.store.get("release_qualification", text(args.file_qualification_id, "file_qualification_id"));
    if (this.store.get("reference_pilot", String(development.pilot_id)).kind !== "development" || this.store.get("reference_pilot", String(file.pilot_id)).kind !== "file_delivery") throw new Error("Platform assessment requires development and file-delivery Pilots");
    const completed = development.lifecycle === "completed" && file.lifecycle === "completed"; const eligible = completed && development.conclusion === "eligible" && file.conclusion !== "rejected" && development.mechanism_passed === true && file.mechanism_passed === true;
    return { status: eligible ? "eligible" : completed && (development.conclusion === "rejected" || file.conclusion === "rejected") ? "rejected" : "inconclusive", platform_ideal_state_v1: eligible, development: development.conclusion, file_delivery: file.conclusion };
  }
}
