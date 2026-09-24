/**
 * An opt-in Engineering Quality Profile sample.  This is deliberately a
 * Capability Kit client, not a new coding runtime: every durable fact is a
 * Task-bound Kit activation, digest-only contribution, Evidence reference, or
 * evaluation receipt already understood by Craft's generic control plane.
 */
import type { CraftStore, JsonObject } from "../core/infrastructure/store.ts";
import { payload, stableDigest } from "../core/digest.ts";
import { CapabilityKitRuntime } from "../core/capability-kit-runtime.ts";
import { object, text } from "../core/validation.ts";
import { receiptEvidenceIds, receiptPassed, verifiedEvaluationReceipt } from "./verified-evaluation-receipt.ts";

export const ENGINEERING_QUALITY_PROFILE_ID = "engineering-quality-profile";
export const ENGINEERING_QUALITY_PROFILE_VERSION = "1.0.0";
const EFFECTS = ["local_write", "read_only"] as const;
const PHASES = ["accept.evaluate", "instrument.emit", "observe.snapshot", "plan.propose", "preflight.check"] as const;
const REVIEW_AXES = ["standards", "spec"] as const;

function strings(value: unknown, name: string, minimum = 1): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (result.length < minimum || new Set(result).size !== result.length) throw new Error(`${name} must contain at least ${minimum} unique values`);
  return result.sort();
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}
function exactFive(value: unknown): number {
  const result = Number(value);
  if (result !== 5) throw new Error("Engineering Quality Profile requires exactly five paired trials");
  return result;
}
function sha256(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^sha256:[A-Za-z0-9._-]+$/u.test(result)) throw new Error(`${name} must be a sha256 digest`);
  return result;
}

/** The version-pinned declarative Kit installed by this sample only on request. */
export function engineeringQualityProfileManifest(): JsonObject {
  return {
    id: ENGINEERING_QUALITY_PROFILE_ID,
    version: ENGINEERING_QUALITY_PROFILE_VERSION,
    name: "Engineering quality profile",
    description: "An explicit, task-bound engineering-quality profile with evidence-only contributions.",
    compatibility: "^0.12.37",
    provides: ["quality_profile", "root_cause_minimal_change", "risk_driven_verification", "independent_dual_review"],
    effects: [...EFFECTS],
    data_scopes: ["task_bound_workspace", "evidence_reference"],
    entrypoints: ["profile.activate", "profile.evaluate"],
    hooks: [...PHASES],
    surfaces: ["skill", "mcp", "cli", "plugin"],
    healthcheck: "engineering-quality-profile-declared",
    eval_suite: "bug-fix-shared-caller-paired-v1",
    metadata: {
      profile_kind: "engineering_quality",
      explicit_task_binding: true,
      execution_authority: false,
      rules: ["root_cause_minimal_change", "risk_driven_verification", "independent_dual_review"],
      promotion: ["shadow", "held_out", "signoff", "canary"],
    },
  };
}

/**
 * Controlled sample operations.  The external Host/CI owns execution; this
 * kernel only verifies declarations and records sanitized receipts.
 */
export class EngineeringQualityProfileKernel {
  readonly store: CraftStore;
  readonly kits: CapabilityKitRuntime;
  constructor(store: CraftStore) { this.store = store; this.kits = new CapabilityKitRuntime(store); }

  install(): JsonObject { return this.kits.install({ builtin: true, manifest: engineeringQualityProfileManifest() }); }

  caseSave(args: JsonObject): JsonObject {
    this.profileKit();
    const identity = { case_id: text(args.case_id, "case_id"), case_kind: text(args.case_kind, "case_kind"),
      frozen_input_digest: sha256(args.frozen_input_digest, "frozen_input_digest"), allowed_workspace_ref: text(args.allowed_workspace_ref, "allowed_workspace_ref"),
      acceptance_command_digest: sha256(args.acceptance_command_digest, "acceptance_command_digest"),
      sibling_caller_assertion_digest: sha256(args.sibling_caller_assertion_digest, "sibling_caller_assertion_digest"), sanitized: boolean(args.sanitized, "sanitized") };
    if (identity.case_kind !== "bug-fix-shared-caller" || identity.sanitized !== true) throw new Error("Engineering Quality Profile Case must be a sanitized bug-fix-shared-caller Case");
    const existing = this.store.find("engineering_quality_profile_case", identity.case_id);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Engineering Quality Profile Case idempotency conflict");
      return { case: existing, idempotent: true };
    }
    return { case: this.store.create("engineering_quality_profile_case", identity.case_id, { ...identity, identity_digest: stableDigest(identity),
      raw_input_stored: false, raw_command_stored: false, status: "frozen" }), idempotent: false };
  }

  activate(args: JsonObject): JsonObject {
    const kit = this.profileKit();
    const taskId = text(args.task_id, "task_id");
    if (args.profile_version !== undefined && text(args.profile_version, "profile_version") !== ENGINEERING_QUALITY_PROFILE_VERSION) {
      throw new Error("Engineering Quality Profile version does not match the installed Kit");
    }
    return this.kits.activate({ kit_id: kit.id, task_id: taskId,
      activation_id: args.activation_id ?? `engineering_quality_profile_activation_${taskId}`,
      activation_profile_id: ENGINEERING_QUALITY_PROFILE_ID });
  }

  trialContext(args: JsonObject): JsonObject {
    const activation = this.activation(args.activation_id);
    const kit = this.profileKit();
    return {
      profile: {
        kit_id: kit.id, kit_version: kit.version, manifest_version: kit.manifest_version, manifest_digest: kit.manifest_digest,
        activation_id: activation.id, activation_version: activation.version, task_id: activation.task_id,
        allowed_effects: [...EFFECTS], phases: [...PHASES], execution_authority: false,
        host_configuration_write: false, external_effects: false, installation_required: false,
      },
    };
  }

  contribute(args: JsonObject): JsonObject {
    const activation = this.activation(args.activation_id);
    const ruleId = text(args.rule_id, "rule_id");
    const proposal = object(args.proposal, "proposal");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids");
    evidenceIds.forEach((evidenceId) => this.store.get("evidence", evidenceId));
    const phase = this.rulePhase(ruleId, proposal, evidenceIds, activation);
    const result = this.kits.contributionRecord({ kit_id: ENGINEERING_QUALITY_PROFILE_ID, activation_id: activation.id,
      phase, proposal, evidence_ids: evidenceIds, contribution_id: args.contribution_id });
    const contribution = result.contribution as JsonObject;
    if (ruleId === "independent-dual-review") {
      const axis = text(proposal.review_axis, "proposal.review_axis");
      const baselineDigest = sha256(proposal.baseline_digest, "proposal.baseline_digest");
      const reviewerId = proposal.reviewer_id === undefined ? `legacy:${axis}` : text(proposal.reviewer_id, "proposal.reviewer_id");
      const blindInputDigest = proposal.blind_input_digest === undefined ? baselineDigest : sha256(proposal.blind_input_digest, "proposal.blind_input_digest");
      const reviewId = String(args.review_id ?? `engineering_quality_review_${stableDigest({ activation_id: activation.id, axis, baseline_digest: baselineDigest }).slice(-20)}`);
      const identity = { activation_id: activation.id, activation_version: activation.version, contribution_id: contribution.id,
        contribution_version: contribution.version, axis, baseline_digest: baselineDigest, reviewer_id: reviewerId, blind_input_digest: blindInputDigest, evidence_ids: evidenceIds };
      // `rulePhase` prevents a second axis submission before this point, so an
      // independently supplied review id cannot be safely reused.  Always use
      // create rather than retaining a dead idempotency branch.
      this.store.create("engineering_quality_profile_review", reviewId, { ...identity, identity_digest: stableDigest(identity),
        visibility_scope: "axis_isolated", raw_findings_stored: false });
    }
    return result;
  }

  reviewAggregate(args: JsonObject): JsonObject {
    const activation = this.activation(args.activation_id);
    const reviews = this.store.list("engineering_quality_profile_review", 10_000, (item) => item.activation_id === activation.id);
    if (reviews.length !== REVIEW_AXES.length || !REVIEW_AXES.every((axis) => reviews.filter((review) => review.axis === axis).length === 1)) {
      throw new Error("Engineering Quality Profile requires one isolated Standards and one isolated Spec review");
    }
    const baselineDigests = new Set(reviews.map((review) => String(review.baseline_digest)));
    if (baselineDigests.size !== 1) throw new Error("Engineering Quality Profile reviews must use the same fixed baseline");
    if (new Set(reviews.map((review) => String(review.reviewer_id))).size !== REVIEW_AXES.length) throw new Error("Engineering Quality Profile review axes require independent reviewers");
    const reproductionEvidenceIds = strings(args.reproduction_evidence_ids, "reproduction_evidence_ids");
    for (const evidenceId of reproductionEvidenceIds) {
      const evidence = this.store.get("evidence", evidenceId);
      if (evidence.source_type !== "program" || evidence.confidence !== "confirmed") throw new Error("Engineering Quality Profile aggregate requires confirmed program reproduction Evidence");
    }
    const identity = { activation_id: activation.id, activation_version: activation.version, baseline_digest: [...baselineDigests][0],
      review_ids: reviews.map((review) => review.id).sort(), reproduction_evidence_ids: reproductionEvidenceIds };
    const aggregateId = String(args.aggregate_id ?? `engineering_quality_review_aggregate_${stableDigest(identity).slice(-20)}`);
    const existing = this.store.find("engineering_quality_profile_review_aggregate", aggregateId);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Engineering Quality Profile review aggregate idempotency conflict");
      return { aggregate: existing, idempotent: true };
    }
    return { aggregate: this.store.create("engineering_quality_profile_review_aggregate", aggregateId, { ...identity,
      identity_digest: stableDigest(identity), review_axes: [...REVIEW_AXES].sort(), raw_findings_stored: false, reproducible: true }), idempotent: false };
  }

  evaluationPlan(args: JsonObject): JsonObject {
    const activation = this.activation(args.activation_id);
    const caseIds = strings(args.case_ids, "case_ids");
    if (caseIds.length < 12 || caseIds.length > 20) throw new Error("Engineering Quality Profile evaluation requires 12 to 20 sanitized Cases");
    const caseContracts = caseIds.map((caseId) => {
      const testCase = this.store.get("engineering_quality_profile_case", caseId);
      if (testCase.status !== "frozen" || testCase.case_kind !== "bug-fix-shared-caller" || testCase.sanitized !== true) throw new Error("Engineering Quality Profile Case is not frozen and sanitized");
      return { case_id: testCase.id, case_version: testCase.version, identity_digest: testCase.identity_digest };
    });
    const trials = exactFive(args.trials_per_pair);
    const identity = { activation_id: activation.id, activation_version: activation.version, kit_id: ENGINEERING_QUALITY_PROFILE_ID,
      kit_version: activation.kit_version, manifest_digest: activation.manifest_digest, host_id: text(args.host_id, "host_id"), case_ids: caseIds, case_contracts: caseContracts,
      model_fingerprint: text(args.model_fingerprint, "model_fingerprint"), environment_fingerprint: text(args.environment_fingerprint, "environment_fingerprint"),
      budget_fingerprint: text(args.budget_fingerprint, "budget_fingerprint"), trials_per_pair: trials, observer_kind: text(args.observer_kind ?? "workspace", "observer_kind") };
    const planId = String(args.plan_id ?? `engineering_quality_profile_evaluation_${stableDigest(identity).slice(-20)}`);
    const existing = this.store.find("engineering_quality_profile_evaluation_plan", planId);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Engineering Quality Profile evaluation plan idempotency conflict");
      return { plan: existing, idempotent: true };
    }
    return { plan: this.store.create("engineering_quality_profile_evaluation_plan", planId, { ...identity, identity_digest: stableDigest(identity),
      status: "collecting", raw_case_content_stored: false, execution_authority: false }), idempotent: false };
  }

  evaluationRecord(args: JsonObject): JsonObject {
    // Kept only so existing local journals remain readable.  A caller-supplied
    // boolean result is not proof and is deliberately excluded from promotion.
    const plan = this.store.get("engineering_quality_profile_evaluation_plan", text(args.plan_id, "plan_id"));
    if (plan.status !== "collecting") throw new Error("Engineering Quality Profile evaluation is not collecting observations");
    const caseId = text(args.case_id, "case_id"); if (!(plan.case_ids as string[]).includes(caseId)) throw new Error("Engineering Quality Profile Case is not in the plan");
    const trialIndex = Number(args.trial_index); if (!Number.isInteger(trialIndex) || trialIndex < 1 || trialIndex > Number(plan.trials_per_pair)) throw new Error("Engineering Quality Profile trial_index is outside the plan");
    const arm = text(args.arm, "arm"); if (arm !== "baseline" && arm !== "profile") throw new Error("Engineering Quality Profile arm is unsupported");
    const identity = { plan_id: plan.id, plan_version: plan.version, case_id: caseId, trial_index: trialIndex, arm, legacy: true };
    const recordId = String(args.record_id ?? `engineering_quality_profile_evaluation_record_${stableDigest({ plan_id: plan.id, case_id: caseId, trial_index: trialIndex, arm }).slice(-20)}`);
    const existing = this.store.find("engineering_quality_profile_evaluation_record", recordId);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Engineering Quality Profile evaluation record idempotency conflict");
      return { plan, record: existing, idempotent: true };
    }
    const duplicate = this.store.list("engineering_quality_profile_evaluation_record", 10_000, (record) => record.plan_id === plan.id && record.case_id === caseId && record.trial_index === trialIndex && record.arm === arm)[0];
    if (duplicate) throw new Error("Engineering Quality Profile evaluation slot is already recorded");
    const record = this.store.create("engineering_quality_profile_evaluation_record", recordId, { ...identity, identity_digest: stableDigest(identity),
      status: "revalidation_required", deterministic_acceptance_passed: false, sibling_caller_passed: false,
      retry_count: 0, cost_units: 0, latency_ms: 0, raw_receipt_stored: false });
    return { plan, record, idempotent: false };
  }

  evaluationReceiptRecord(args: JsonObject): JsonObject {
    // Compatibility only: old callers supplied a hand-written receipt object.
    // It remains readable but never becomes promotion evidence.
    return this.evaluationRecord(args);
  }

  evaluationVerifiedReceiptImport(args: JsonObject): JsonObject {
    const plan = this.store.get("engineering_quality_profile_evaluation_plan", text(args.plan_id, "plan_id"));
    if (plan.status !== "collecting") throw new Error("Engineering Quality Profile evaluation is not collecting observations");
    const caseId = text(args.case_id, "case_id"); if (!(plan.case_ids as string[]).includes(caseId)) throw new Error("Engineering Quality Profile Case is not in the plan");
    const trialIndex = Number(args.trial_index); if (!Number.isInteger(trialIndex) || trialIndex < 1 || trialIndex > Number(plan.trials_per_pair)) throw new Error("Engineering Quality Profile trial_index is outside the plan");
    const arm = text(args.arm, "arm"); if (arm !== "baseline" && arm !== "profile") throw new Error("Engineering Quality Profile arm is unsupported");
    const session = this.store.get("host_session", text(args.host_session_id, "host_session_id"));
    if (session.status !== "terminal" || session.host_id !== plan.host_id || session.environment_fingerprint !== plan.environment_fingerprint || session.model_fingerprint !== plan.model_fingerprint || session.budget_fingerprint !== plan.budget_fingerprint) throw new Error("Engineering Quality Profile Host receipt does not match the fixed plan");
    const observation = this.store.get("outcome_observation", text(args.observation_id, "observation_id"));
    if (observation.trace_id !== session.trace_id || observation.host_id !== plan.host_id || observation.observer_kind !== plan.observer_kind || observation.observer_id === plan.host_id) throw new Error("Engineering Quality Profile Outcome Observation is not independent or does not match the Host Session");
    const receipt = verifiedEvaluationReceipt(args.verified_receipt);
    const evidenceIds = receiptEvidenceIds(receipt);
    const evidence = evidenceIds.map((id) => this.store.get("evidence", id));
    if (evidence.some((item) => item.source_type !== "program" || item.confidence !== "confirmed")) throw new Error("Engineering Quality Profile receipt requires confirmed program Evidence");
    const testCase = this.store.get("engineering_quality_profile_case", caseId);
    if (receipt.frozen_input_digest !== testCase.frozen_input_digest) throw new Error("Engineering Quality Profile receipt frozen_input_digest drifted");
    const identity = { plan_id: plan.id, plan_version: plan.version, case_id: caseId, trial_index: trialIndex, arm, host_session_id: session.id, host_session_version: session.version, observation_id: observation.id, observation_version: observation.version, receipt_digest: stableDigest(receipt), evidence_ids: evidenceIds.sort(), retry_count: receipt.retry_count, cost_units: receipt.cost_units, latency_ms: receipt.latency_ms };
    const recordId = String(args.record_id ?? `engineering_quality_profile_evaluation_record_${stableDigest({ plan_id: plan.id, case_id: caseId, trial_index: trialIndex, arm }).slice(-20)}`);
    const existing = this.store.find("engineering_quality_profile_evaluation_record", recordId); if (existing) { if (existing.identity_digest !== stableDigest(identity)) throw new Error("Engineering Quality Profile evaluation record idempotency conflict"); return { plan, record: existing, idempotent: true }; }
    if (this.store.list("engineering_quality_profile_evaluation_record", 10_000, (record) => record.plan_id === plan.id && record.case_id === caseId && record.trial_index === trialIndex && record.arm === arm).length) throw new Error("Engineering Quality Profile evaluation slot is already recorded");
    const passed = receiptPassed(receipt) && observation.verdict === "passed";
    const record = this.store.create("engineering_quality_profile_evaluation_record", recordId, { ...identity, identity_digest: stableDigest(identity), status: passed ? "verified" : "rejected", deterministic_acceptance_passed: receipt.acceptance.status === "passed", sibling_caller_passed: receipt.siblings.every((item) => item.status === "passed"), unauthorized_effect: receipt.effect_check.status !== "passed", safety_regression: receipt.safety_check.status !== "passed", factual_regression: receipt.factual_check.status !== "passed", root_cause_evidence_ids: [...receipt.root_cause_evidence_ids], raw_receipt_stored: false });
    if (!passed && !plan.rejection_id) {
      const rejection = this.store.create("engineering_quality_profile_rejection", `engineering_quality_profile_rejection_${stableDigest(identity).slice(-20)}`, { plan_id: plan.id, case_id: caseId, trial_index: trialIndex, arm, reason: "verified_evaluation_receipt_blocker", receipt_digest: stableDigest(receipt), handoff_required: true });
      this.store.save("engineering_quality_profile_evaluation_plan", String(plan.id), { ...payload(plan), rejection_id: rejection.id });
    }
    return { plan, record, idempotent: false };
  }

  evaluationEvaluate(args: JsonObject): JsonObject {
    const plan = this.store.get("engineering_quality_profile_evaluation_plan", text(args.plan_id, "plan_id"));
    const records = this.store.list("engineering_quality_profile_evaluation_record", 100_000, (record) => record.plan_id === plan.id);
    const slots = (plan.case_ids as string[]).flatMap((caseId) => Array.from({ length: Number(plan.trials_per_pair) }, (_, index) => ({ caseId, trial: index + 1 })));
    const pairs = slots.map((slot) => ({ ...slot, baseline: records.find((record) => record.case_id === slot.caseId && record.trial_index === slot.trial && record.arm === "baseline"),
      profile: records.find((record) => record.case_id === slot.caseId && record.trial_index === slot.trial && record.arm === "profile") }));
    const completePairs = pairs.filter((pair) => pair.baseline && pair.profile) as Array<{ caseId: string; trial: number; baseline: JsonObject; profile: JsonObject }>;
    const incompletePairs = pairs.length - completePairs.length;
    const average = (items: JsonObject[], field: string) => items.length ? items.reduce((total, item) => total + Number(item[field]), 0) / items.length : Infinity;
    const baseline = completePairs.map((pair) => pair.baseline); const profile = completePairs.map((pair) => pair.profile);
    const passRate = (items: JsonObject[]) => items.length ? items.filter((item) => item.deterministic_acceptance_passed === true).length / items.length : 0;
    const baselinePassRate = passRate(baseline); const profilePassRate = passRate(profile);
    const siblingCallerPassed = profile.every((item) => item.sibling_caller_passed === true);
    const nonWorse = profilePassRate >= baselinePassRate && average(profile, "retry_count") <= average(baseline, "retry_count")
      && average(profile, "cost_units") <= average(baseline, "cost_units") && average(profile, "latency_ms") <= average(baseline, "latency_ms");
    const rejection = plan.rejection_id ? this.store.get("engineering_quality_profile_rejection", String(plan.rejection_id)) : null;
    const status = rejection ? "rejected" : incompletePairs ? "inconclusive" : siblingCallerPassed && nonWorse ? "shadow_candidate" : "rejected";
    const identity = { plan_id: plan.id, total_pairs: pairs.length, complete_pairs: completePairs.length, incomplete_pairs: incompletePairs,
      baseline_pass_rate: baselinePassRate, profile_pass_rate: profilePassRate, sibling_caller_passed: siblingCallerPassed, non_worse: nonWorse, status,
      rejection_id: rejection?.id ?? null };
    const evaluationId = String(args.evaluation_id ?? `engineering_quality_profile_evaluation_${plan.id}`);
    const existing = this.store.find("engineering_quality_profile_evaluation", evaluationId);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Engineering Quality Profile evaluation idempotency conflict");
      return { evaluation: existing, idempotent: true };
    }
    const evaluation = this.store.create("engineering_quality_profile_evaluation", evaluationId, { ...identity, identity_digest: stableDigest(identity),
      routeable_candidate: status === "shadow_candidate", next_gate: status === "shadow_candidate" ? "shadow" : status === "inconclusive" ? "complete_paired_trials" : "rework_or_reject",
      execution_authority: false });
    const savedPlan = this.store.save("engineering_quality_profile_evaluation_plan", String(plan.id), { ...payload(plan), status: "evaluated", latest_evaluation_id: evaluation.id });
    return { plan: savedPlan, evaluation, idempotent: false };
  }

  evaluationGet(args: JsonObject): JsonObject {
    const plan = this.store.get("engineering_quality_profile_evaluation_plan", text(args.plan_id, "plan_id"));
    return { plan, records: this.store.list("engineering_quality_profile_evaluation_record", 100_000, (record) => record.plan_id === plan.id),
      evaluation: plan.latest_evaluation_id ? this.store.get("engineering_quality_profile_evaluation", String(plan.latest_evaluation_id)) : null,
      rejection: plan.rejection_id ? this.store.get("engineering_quality_profile_rejection", String(plan.rejection_id)) : null };
  }

  private profileKit(): JsonObject {
    const kit = this.store.get("capability_kit", ENGINEERING_QUALITY_PROFILE_ID);
    if (kit.manifest_version !== ENGINEERING_QUALITY_PROFILE_VERSION || kit.status !== "installed") throw new Error("Engineering Quality Profile Kit is unavailable");
    const manifest = object(kit.manifest, "kit.manifest");
    if (stableDigest(manifest) !== kit.manifest_digest || JSON.stringify(manifest.effects) !== JSON.stringify([...EFFECTS]) || JSON.stringify(manifest.hooks) !== JSON.stringify([...PHASES])) {
      throw new Error("Engineering Quality Profile manifest drifted");
    }
    return kit;
  }

  private activation(value: unknown): JsonObject {
    const activation = this.store.get("capability_kit_activation", text(value, "activation_id"));
    const kit = this.profileKit();
    if (activation.kit_id !== kit.id || activation.kit_version !== kit.version || activation.manifest_digest !== kit.manifest_digest
      || activation.activation_profile_id !== ENGINEERING_QUALITY_PROFILE_ID || activation.status !== "active") {
      throw new Error("Engineering Quality Profile activation is not active or is drifted");
    }
    return activation;
  }

  private rulePhase(ruleId: string, proposal: JsonObject, evidenceIds: string[], activation: JsonObject): string {
    if (ruleId === "root-cause-minimal-change") {
      ["root_cause", "reuse_candidate", "minimal_change"].forEach((key) => text(proposal[key], `proposal.${key}`));
      if (evidenceIds.length < 3) throw new Error("Root-cause, reuse, and minimum-change planning requires three Evidence references");
      return "plan.propose";
    }
    if (ruleId === "risk-driven-verification") {
      const risk = text(proposal.risk_level, "proposal.risk_level"); const mode = text(proposal.verification_mode, "proposal.verification_mode");
      text(proposal.acceptance_ref, "proposal.acceptance_ref");
      if (!new Set(["low", "medium", "high"]).has(risk) || !new Set(["tdd", "direct"]).has(mode)) throw new Error("Risk-driven verification is unsupported");
      if (risk === "high" && mode !== "tdd") throw new Error("High-risk changes require TDD");
      if (risk === "low" && mode !== "direct") throw new Error("Low-risk changes require direct verification");
      return "preflight.check";
    }
    if (ruleId === "independent-dual-review") {
      const axis = text(proposal.review_axis, "proposal.review_axis");
      if (!(REVIEW_AXES as readonly string[]).includes(axis)) throw new Error("Engineering Quality Profile review axis is unsupported");
      sha256(proposal.baseline_digest, "proposal.baseline_digest"); sha256(proposal.finding_digest, "proposal.finding_digest");
      if (proposal.blind_input_digest !== undefined) sha256(proposal.blind_input_digest, "proposal.blind_input_digest");
      if (proposal.reviewer_id !== undefined) text(proposal.reviewer_id, "proposal.reviewer_id");
      if (this.store.list("engineering_quality_profile_review", 10_000, (review) => review.activation_id === activation.id && review.axis === axis).length) {
        throw new Error("Engineering Quality Profile review axis is already recorded");
      }
      return "accept.evaluate";
    }
    throw new Error("Engineering Quality Profile rule is unsupported");
  }
}
