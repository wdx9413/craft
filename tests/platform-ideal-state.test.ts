import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { ReleaseQualificationKernel } from "../src/release-qualification.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { UncertaintyPolicyKernel } from "../src/uncertainty-policy.ts";

async function fixture() { const store = await new CraftStore(craftPaths(mkdtempSync(join(tmpdir(), "craft-121-")))).open(); store.create("evidence", "confirmed", { confidence: "confirmed" }); store.create("evidence", "bounded", { confidence: "bounded" }); store.create("evidence", "bad", { confidence: "unverified" }); return { store, uncertainty: new UncertaintyPolicyKernel(store), qualification: new ReleaseQualificationKernel(store) }; }

test("v0.12.23 resolves uncertainty by layered policy without granting execution authority", async () => {
  const f = await fixture(); const core = f.uncertainty.save({ policy_id: "core", scope: "core", mode: "bounded_autonomous", on_uncertain: "collecting", fallback: "unchanged", escalations: ["deterministic_check", "independent_evaluator"], max_attempts: 2 }).policy as JsonObject;
  const global = f.uncertainty.save({ policy_id: "global", scope: "global", mode: "autonomous", on_uncertain: "collecting", fallback: "abstained", escalations: ["additional_trial"], confidence_threshold: 0.8, consistency_threshold: 0.9, max_attempts: 1 }).policy as JsonObject;
  assert.equal((f.uncertainty.save({ policy_id: "core", scope: "core", mode: "bounded_autonomous", on_uncertain: "collecting", fallback: "unchanged", escalations: ["deterministic_check", "independent_evaluator"], max_attempts: 2 }).policy as JsonObject).id, core.id);
  const collecting = f.uncertainty.resolve({ policy_ids: [global.id, core.id], subject_ref: "acceptance:1", confidence: 0.7, consistency: 0.7, evidence_confidences: ["bounded"], attempt: 0 }).resolution as JsonObject; assert.equal(collecting.status, "collecting"); assert.deepEqual(collecting.next_escalations, ["additional_trial"]); assert.equal(collecting.execution_authority, false);
  const repeated = f.uncertainty.resolve({ policy_ids: [global.id, core.id], subject_ref: "acceptance:1", confidence: 0.7, consistency: 0.7, evidence_confidences: ["bounded"], attempt: 0 }); assert.equal(repeated.idempotent, true);
  assert.equal((f.uncertainty.resolve({ policy_ids: [core.id, global.id], subject_ref: "acceptance:2", confidence: 0.9, consistency: 0.95, evidence_confidences: ["confirmed"] }).resolution as JsonObject).status, "unchanged");
  assert.equal((f.uncertainty.resolve({ policy_ids: [core.id, global.id], subject_ref: "acceptance:3", confidence: 0.1, consistency: 0.1, evidence_confidences: [], conflict: true, attempt: 1 }).resolution as JsonObject).status, "abstained");
  assert.equal((f.uncertainty.resolve({ policy_ids: [core.id], subject_ref: "effect:1", safety_floor_violation: true }).resolution as JsonObject).status, "blocked");
  const supervised = f.uncertainty.save({ scope: "task", scope_id: "task", mode: "supervised", human_fallback: true, escalations: [] }).policy as JsonObject; const human = f.uncertainty.resolve({ policy_ids: [core.id, supervised.id], subject_ref: "quality:1", evidence_confidences: ["unverified"] }).resolution as JsonObject; assert.equal(human.status, "human_required");
  const adjudication = f.uncertainty.adjudicate({ adjudication_id: "a", resolution_id: human.id, decision: "accepted", actor: "owner", reason: "Reviewed conflicting quality evidence", scope: "task", valid_until: "2030-01-01T00:00:00Z", evidence_ids: ["confirmed"] }).adjudication as JsonObject; assert.equal(adjudication.preserves_conflicting_evidence, true); assert.equal(f.uncertainty.adjudicate({ adjudication_id: "a", resolution_id: human.id, decision: "accepted", actor: "owner", reason: "Reviewed conflicting quality evidence", scope: "task", valid_until: "2030-01-01T00:00:00Z", evidence_ids: ["confirmed"] }).idempotent, true);
  assert.throws(() => f.uncertainty.adjudicate({ resolution_id: collecting.id, decision: "accepted", actor: "x", reason: "x", scope: "x", valid_until: "x", evidence_ids: ["confirmed"] }), /not eligible/);
  const hard = f.uncertainty.resolve({ policy_ids: [core.id], subject_ref: "effect:2", safety_floor_violation: true, resolution_id: "hard" }).resolution as JsonObject; assert.throws(() => f.uncertainty.adjudicate({ resolution_id: hard.id }), /Safety Floor/);
  assert.throws(() => f.uncertainty.adjudicate({ resolution_id: human.id, decision: "accepted", actor: "x", reason: "x", scope: "x", valid_until: "x", evidence_ids: ["bad"] }), /confirmed or bounded/);
  assert.throws(() => f.uncertainty.save({ scope: "wrong" }), /scope/); assert.throws(() => f.uncertainty.save({ scope: "global", mode: "bad" }), /mode/); assert.throws(() => f.uncertainty.save({ scope: "global", mode: "autonomous", on_uncertain: "human_required", human_fallback: false }), /disabled/); assert.throws(() => f.uncertainty.resolve({ policy_ids: [global.id], subject_ref: "x" }), /Core Safety Floor/);
});

test("v0.12.23 qualifies two content-free five-pair Reference Pilots", async () => {
  const f = await fixture(); const dev = f.qualification.pilotSave({ pilot_id: "dev", kind: "development", name: "Codex development", case_ref: "fixture:repo", primary_metric: "human_intervention_minutes", direction: "lower_is_better", effect_threshold: 1, guardrail_names: ["quality", "safety"], sanitized: true }).pilot as JsonObject;
  const file = f.qualification.pilotSave({ pilot_id: "file", kind: "file_delivery", name: "File package", case_ref: "fixture:file", primary_metric: "ready_for_next_stage", direction: "higher_is_better", effect_threshold: 0.1, sanitized: true }).pilot as JsonObject;
  assert.equal(f.qualification.pilotSave({ pilot_id: "dev", kind: "development", name: "Codex development", case_ref: "fixture:repo", primary_metric: "human_intervention_minutes", direction: "lower_is_better", effect_threshold: 1, guardrail_names: ["safety", "quality"], sanitized: true }).idempotent, true);
  const devPlan = f.qualification.plan({ qualification_id: "q-dev", pilot_id: dev.id, baseline_ref: "codex", candidate_ref: "craft", environment_fingerprint: "env", budget_fingerprint: "budget" }); assert.equal((devPlan.slots as JsonObject[]).length, 10); assert.equal(f.qualification.plan({ qualification_id: "q-dev", pilot_id: dev.id, baseline_ref: "codex", candidate_ref: "craft", environment_fingerprint: "env", budget_fingerprint: "budget" }).idempotent, true);
  const filePlan = f.qualification.plan({ qualification_id: "q-file", pilot_id: file.id, baseline_ref: "codex", candidate_ref: "craft", environment_fingerprint: "env", budget_fingerprint: "budget" });
  assert.equal(f.qualification.evaluate({ qualification_id: "q-dev" }).conclusion, "inconclusive");
  for (const slot of devPlan.slots as JsonObject[]) { const candidate = slot.arm === "candidate"; f.qualification.record({ slot_id: slot.id, mechanism_passed: true, primary_value: candidate ? 4 : 8, guardrails: { quality: true, safety: true }, evidence_ids: ["confirmed"], environment_fingerprint: "env", budget_fingerprint: "budget" }); }
  const eligible = f.qualification.evaluate({ qualification_id: "q-dev" }); assert.equal(eligible.conclusion, "eligible"); assert.equal(f.qualification.evaluate({ qualification_id: "q-dev" }).idempotent, true);
  for (const slot of filePlan.slots as JsonObject[]) f.qualification.record({ slot_id: slot.id, mechanism_passed: true, primary_value: 1, guardrails: {}, evidence_ids: ["bounded"], environment_fingerprint: "env", budget_fingerprint: "budget" });
  assert.equal(f.qualification.evaluate({ qualification_id: "q-file" }).conclusion, "inconclusive"); const platform = f.qualification.platformAssess({ development_qualification_id: "q-dev", file_qualification_id: "q-file" }); assert.equal(platform.status, "eligible"); assert.equal(platform.platform_ideal_state_v1, true);
  assert.throws(() => f.qualification.pilotSave({ kind: "video", name: "x", case_ref: "x", primary_metric: "x", sanitized: true }), /kind/); assert.throws(() => f.qualification.pilotSave({ kind: "development", name: "x", case_ref: "x", primary_metric: "x", sanitized: false }), /sanitized/); assert.throws(() => f.qualification.pilotSave({ kind: "development", name: "x", case_ref: "x", primary_metric: "x", direction: "sideways", sanitized: true }), /direction/);
});

test("v0.12.23 rejects non-comparable, unsafe and unsupported qualification evidence", async () => {
  const f = await fixture(); const pilot = f.qualification.pilotSave({ pilot_id: "p", kind: "development", name: "P", case_ref: "case", primary_metric: "minutes", direction: "lower_is_better", effect_threshold: 1, sanitized: true }).pilot as JsonObject;
  const plans = ["drift", "regress"].map((id) => f.qualification.plan({ qualification_id: id, pilot_id: pilot.id, baseline_ref: "b", candidate_ref: "c", environment_fingerprint: "env", budget_fingerprint: "budget" })); const filePilot = f.qualification.pilotSave({ pilot_id: "file", kind: "file_delivery", name: "File", case_ref: "case:file", primary_metric: "ready", sanitized: true }).pilot as JsonObject; const pending = f.qualification.plan({ qualification_id: "pending", pilot_id: filePilot.id, baseline_ref: "b", candidate_ref: "c", environment_fingerprint: "env", budget_fingerprint: "budget" });
  for (const slot of plans[0]!.slots as JsonObject[]) f.qualification.record({ slot_id: slot.id, mechanism_passed: true, primary_value: 1, guardrails: {}, evidence_ids: ["confirmed"], environment_fingerprint: slot.arm === "candidate" ? "drift" : "env", budget_fingerprint: "budget" }); assert.equal(f.qualification.evaluate({ qualification_id: "drift" }).conclusion, "inconclusive");
  for (const slot of plans[1]!.slots as JsonObject[]) f.qualification.record({ slot_id: slot.id, mechanism_passed: slot.arm === "baseline", primary_value: slot.arm === "candidate" ? 9 : 4, guardrails: { safety: slot.arm === "baseline" }, evidence_ids: ["confirmed"], environment_fingerprint: "env", budget_fingerprint: "budget" }); assert.equal(f.qualification.evaluate({ qualification_id: "regress" }).conclusion, "rejected");
  assert.equal(f.qualification.platformAssess({ development_qualification_id: "regress", file_qualification_id: "pending" }).status, "inconclusive");
  const slot = (pending.slots as JsonObject[])[0]!; assert.throws(() => f.qualification.record({ slot_id: slot.id, mechanism_passed: true, primary_value: 1, guardrails: { x: 1 }, evidence_ids: ["confirmed"], environment_fingerprint: "env", budget_fingerprint: "budget" }), /booleans/); assert.throws(() => f.qualification.record({ slot_id: slot.id, mechanism_passed: true, primary_value: 1, guardrails: {}, evidence_ids: ["bad"], environment_fingerprint: "env", budget_fingerprint: "budget" }), /confirmed or bounded/);
});

test("v0.12.23 validates uncertainty policy boundaries and idempotency", async () => {
  const f = await fixture();
  assert.throws(() => f.uncertainty.save({ scope: " " }), /must not be empty/);
  assert.throws(() => f.uncertainty.save({ scope: "global", on_uncertain: "invent" }), /action/);
  assert.throws(() => f.uncertainty.save({ scope: "global", fallback: "collecting" }), /fallback/);
  assert.throws(() => f.uncertainty.save({ scope: "global", escalations: "check" }), /array/);
  assert.throws(() => f.uncertainty.save({ scope: "global", escalations: ["additional_trial", "additional_trial"] }), /unique/);
  assert.throws(() => f.uncertainty.save({ scope: "global", escalations: ["more_power"] }), /escalation/);
  assert.throws(() => f.uncertainty.save({ scope: "global", confidence_threshold: 2 }), /between/);
  assert.throws(() => f.uncertainty.save({ scope: "global", consistency_threshold: Number.NaN }), /between/);
  assert.throws(() => f.uncertainty.save({ scope: "global", max_attempts: 1.5 }), /integer/);
  assert.throws(() => f.uncertainty.save({ scope: "global", max_attempts: 101 }), /integer/);
  const core = f.uncertainty.save({ policy_id: "core-x", scope: "core", mode: "locked", on_uncertain: "human_required", fallback: "rejected", human_fallback: false }).policy as JsonObject;
  assert.throws(() => f.uncertainty.save({ policy_id: "core-x", scope: "core", mode: "locked", fallback: "blocked" }), /idempotency/);
  const project = f.uncertainty.save({ policy_id: "project-x", scope: "project", on_uncertain: "collecting", fallback: "rejected", escalations: [] }).policy as JsonObject;
  assert.throws(() => f.uncertainty.resolve({ policy_ids: [], subject_ref: "x" }), /Core Safety Floor/);
  assert.throws(() => f.uncertainty.resolve({ policy_ids: [core.id, core.id], subject_ref: "x" }), /unique/);
  assert.throws(() => f.uncertainty.resolve({ policy_ids: [core.id], subject_ref: "x", confidence: -1 }), /between/);
  assert.throws(() => f.uncertainty.resolve({ policy_ids: [core.id], subject_ref: "x", evidence_confidences: "confirmed" }), /array/);
  assert.equal((f.uncertainty.resolve({ policy_ids: [core.id], subject_ref: "human-disabled", evidence_confidences: ["unverified"] }).resolution as JsonObject).status, "rejected");
  assert.equal((f.uncertainty.resolve({ policy_ids: [core.id, project.id], subject_ref: "no-escalation", evidence_confidences: ["bounded"] }).resolution as JsonObject).status, "rejected");
  f.uncertainty.resolve({ resolution_id: "fixed", policy_ids: [core.id], subject_ref: "stable", confidence: 1, consistency: 1, evidence_confidences: ["confirmed"] });
  assert.throws(() => f.uncertainty.resolve({ resolution_id: "fixed", policy_ids: [core.id], subject_ref: "changed", confidence: 1, consistency: 1, evidence_confidences: ["confirmed"] }), /idempotency/);
  const eligible = f.uncertainty.resolve({ policy_ids: [core.id], subject_ref: "adjudicate", confidence: 1, consistency: 1, evidence_confidences: ["confirmed"] }).resolution as JsonObject;
  assert.throws(() => f.uncertainty.adjudicate({ resolution_id: eligible.id, decision: "invent" }), /decision/);
  assert.throws(() => f.uncertainty.adjudicate({ resolution_id: eligible.id, decision: "unchanged", actor: "x", reason: "x", scope: "x", valid_until: "x", evidence_ids: [] }), /requires Evidence/);
  f.uncertainty.adjudicate({ adjudication_id: "fixed-a", resolution_id: eligible.id, decision: "unchanged", actor: "x", reason: "x", scope: "x", valid_until: "x", evidence_ids: ["bounded"] });
  assert.throws(() => f.uncertainty.adjudicate({ adjudication_id: "fixed-a", resolution_id: eligible.id, decision: "rejected", actor: "x", reason: "x", scope: "x", valid_until: "x", evidence_ids: ["bounded"] }), /idempotency/);
});

test("v0.12.23 validates qualification inputs and both metric directions", async () => {
  const f = await fixture();
  assert.throws(() => f.qualification.pilotSave({ kind: "development", name: " ", case_ref: "x", primary_metric: "x", sanitized: true }), /must not be empty/);
  assert.throws(() => f.qualification.pilotSave({ kind: "development", name: "x", case_ref: "x", primary_metric: "x", effect_threshold: -1, sanitized: true }), /non-negative/);
  assert.throws(() => f.qualification.pilotSave({ kind: "development", name: "x", case_ref: "x", primary_metric: "x", effect_threshold: Number.NaN, sanitized: true }), /non-negative/);
  const higher = f.qualification.pilotSave({ pilot_id: "higher", kind: "development", name: "Higher", case_ref: "case", primary_metric: "score", direction: "higher_is_better", effect_threshold: 2, guardrail_names: "ignored", sanitized: true }).pilot as JsonObject;
  assert.deepEqual(higher.guardrail_names, []);
  assert.throws(() => f.qualification.pilotSave({ pilot_id: "higher", kind: "development", name: "Changed", case_ref: "case", primary_metric: "score", direction: "higher_is_better", effect_threshold: 2, sanitized: true }), /idempotency/);
  const plan = f.qualification.plan({ qualification_id: "higher-q", pilot_id: higher.id, baseline_ref: "b", candidate_ref: "c", environment_fingerprint: "env", budget_fingerprint: "budget" });
  assert.throws(() => f.qualification.plan({ qualification_id: "higher-q", pilot_id: higher.id, baseline_ref: "other", candidate_ref: "c", environment_fingerprint: "env", budget_fingerprint: "budget" }), /idempotency/);
  assert.throws(() => f.qualification.record({ slot_id: (plan.slots as JsonObject[])[0]!.id, mechanism_passed: true, primary_value: 1, guardrails: {}, evidence_ids: [], environment_fingerprint: "env", budget_fingerprint: "budget" }), /requires Evidence/);
  for (const slot of plan.slots as JsonObject[]) {
    const result = f.qualification.record({ slot_id: slot.id, mechanism_passed: true, primary_value: slot.arm === "candidate" ? 12 : 9, guardrails: { safety: true }, evidence_ids: ["confirmed"], environment_fingerprint: "env", budget_fingerprint: "budget" });
    assert.equal(f.qualification.record({ slot_id: slot.id }).idempotent, true); assert.equal((result.slot as JsonObject).status, "completed");
  }
  assert.equal(f.qualification.evaluate({ qualification_id: "higher-q" }).conclusion, "eligible");
  const lower = f.qualification.pilotSave({ pilot_id: "lower", kind: "file_delivery", name: "Lower", case_ref: "case", primary_metric: "errors", effect_threshold: 1, sanitized: true }).pilot as JsonObject;
  const negative = f.qualification.plan({ qualification_id: "negative", pilot_id: lower.id, baseline_ref: "b", candidate_ref: "c", environment_fingerprint: "env", budget_fingerprint: "budget" });
  for (const slot of negative.slots as JsonObject[]) f.qualification.record({ slot_id: slot.id, mechanism_passed: true, primary_value: slot.arm === "candidate" ? 8 : 2, guardrails: {}, evidence_ids: ["confirmed"], environment_fingerprint: "env", budget_fingerprint: "budget" });
  assert.equal(f.qualification.evaluate({ qualification_id: "negative" }).conclusion, "rejected");
  assert.throws(() => f.qualification.platformAssess({ development_qualification_id: "negative", file_qualification_id: "higher-q" }), /development and file-delivery/);
  const generatedPilot = f.qualification.pilotSave({ kind: "file_delivery", name: "Generated", case_ref: "case:g", primary_metric: "ready", sanitized: true }).pilot as JsonObject;
  const generatedPlan = f.qualification.plan({ pilot_id: generatedPilot.id, baseline_ref: "b", candidate_ref: "c", environment_fingerprint: "env", budget_fingerprint: "budget" });
  assert.match(String((generatedPlan.qualification as JsonObject).id), /^release_qualification_/);
  const pendingSlot = (generatedPlan.slots as JsonObject[])[0]!;
  f.store.save("release_qualification_slot", String(pendingSlot.id), { ...pendingSlot, status: "cancelled" });
  assert.throws(() => f.qualification.record({ slot_id: pendingSlot.id }), /not pending/);
  const missingCollections = f.qualification.plan({ qualification_id: "missing-collections", pilot_id: generatedPilot.id, baseline_ref: "b", candidate_ref: "c", environment_fingerprint: "env", budget_fingerprint: "budget" });
  const missingSlot = (missingCollections.slots as JsonObject[])[0]!;
  assert.throws(() => f.qualification.record({ slot_id: missingSlot.id, mechanism_passed: true, primary_value: 1, environment_fingerprint: "env", budget_fingerprint: "budget" }), /requires Evidence/);
  const rejectedFile = f.qualification.plan({ qualification_id: "file-rejected", pilot_id: generatedPilot.id, baseline_ref: "b", candidate_ref: "c", environment_fingerprint: "env", budget_fingerprint: "budget" });
  for (const item of rejectedFile.slots as JsonObject[]) f.qualification.record({ slot_id: item.id, mechanism_passed: false, primary_value: 1, evidence_ids: ["confirmed"], environment_fingerprint: "env", budget_fingerprint: "budget" });
  f.qualification.evaluate({ qualification_id: "file-rejected" });
  assert.equal(f.qualification.platformAssess({ development_qualification_id: "higher-q", file_qualification_id: "file-rejected" }).status, "rejected");
});

test("v0.12.23 keeps defensive persisted-state guards reachable", async () => {
  const f = await fixture();
  const core = f.uncertainty.save({ policy_id: "def-core", scope: "core", on_uncertain: "collecting", fallback: "unchanged", escalations: ["deterministic_check"] }).policy as JsonObject;
  const global = f.uncertainty.save({ policy_id: "def-global", scope: "global" }).policy as JsonObject;
  f.store.save("uncertainty_policy", String(global.id), { ...global, rank: 0 });
  assert.throws(() => f.uncertainty.resolve({ policy_ids: [core.id, global.id], subject_ref: "rank" }), /scope order/);
  const broken = f.uncertainty.save({ policy_id: "broken", scope: "task" }).policy as JsonObject;
  f.store.save("uncertainty_policy", String(broken.id), { ...broken, on_uncertain: "unsupported" });
  assert.throws(() => f.uncertainty.resolve({ policy_ids: [core.id, broken.id], subject_ref: "status" }), /status is unsupported/);
  const generated = f.uncertainty.resolve({ policy_ids: [core.id], subject_ref: "generated", confidence: 1, consistency: 1, evidence_confidences: ["confirmed"] }).resolution as JsonObject;
  assert.match(String(generated.id), /^uncertainty_resolution_/);
  const adjudication = f.uncertainty.adjudicate({ resolution_id: generated.id, decision: "unchanged", actor: "owner", reason: "verified", scope: "task", valid_until: "2030-01-01T00:00:00Z", evidence_ids: ["confirmed"] }).adjudication as JsonObject;
  assert.match(String(adjudication.id), /^adjudication_/);
});

test("v0.12.23 exposes the complete platform qualification protocol through CraftService", async () => {
  const f = await fixture(); const service = new CraftService(f.store);
  const core = service.uncertaintyPolicySave({ policy_id: "svc-core", scope: "core", on_uncertain: "human_required", fallback: "unchanged", human_fallback: true }).policy as JsonObject;
  const resolution = service.uncertaintyResolve({ policy_ids: [core.id], subject_ref: "svc", evidence_confidences: ["unverified"] }).resolution as JsonObject;
  assert.equal((service.uncertaintyAdjudicate({ resolution_id: resolution.id, decision: "unchanged", actor: "owner", reason: "reviewed", scope: "task", valid_until: "2030-01-01T00:00:00Z", evidence_ids: ["confirmed"] }).adjudication as JsonObject).overrides_safety_floor, false);
  const development = service.referencePilotSave({ pilot_id: "svc-dev", kind: "development", name: "Dev", case_ref: "fixture:dev", primary_metric: "score", direction: "higher_is_better", sanitized: true }).pilot as JsonObject;
  const file = service.referencePilotSave({ pilot_id: "svc-file", kind: "file_delivery", name: "File", case_ref: "fixture:file", primary_metric: "score", direction: "higher_is_better", sanitized: true }).pilot as JsonObject;
  for (const [id, pilot] of [["svc-q-dev", development], ["svc-q-file", file]] as [string, JsonObject][]) {
    const planned = service.releaseQualificationPlan({ qualification_id: id, pilot_id: pilot.id, baseline_ref: "b", candidate_ref: "c", environment_fingerprint: "env", budget_fingerprint: "budget" });
    for (const slot of planned.slots as JsonObject[]) service.releaseQualificationRecord({ slot_id: slot.id, primary_value: slot.arm === "candidate" ? 2 : 1, mechanism_passed: true, guardrails: {}, evidence_ids: ["confirmed"], environment_fingerprint: "env", budget_fingerprint: "budget" });
    assert.equal(service.releaseQualificationEvaluate({ qualification_id: id }).conclusion, "eligible");
  }
  assert.equal(service.platformIdealStateAssess({ development_qualification_id: "svc-q-dev", file_qualification_id: "svc-q-file" }).platform_ideal_state_v1, true);
});
