import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { McpServer } from "../src/mcp.ts";
import { CraftService } from "../src/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-engineering-profile-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: new CraftService(store) };
}

function evidence(service: CraftService, id: string, sourceType = "program") {
  return service.evidenceRecord({ evidence_id: id, source_type: sourceType, confidence: "confirmed", claim: `fixture ${id}` });
}

function registerCases(f: Awaited<ReturnType<typeof fixture>>, caseIds: string[]) {
  return caseIds.map((caseId) => f.service.engineeringQualityProfileCaseSave({ case_id: caseId, case_kind: "bug-fix-shared-caller",
    frozen_input_digest: `sha256:input-${caseId}`, allowed_workspace_ref: `workspace://${caseId}`,
    acceptance_command_digest: `sha256:accept-${caseId}`, sibling_caller_assertion_digest: `sha256:sibling-${caseId}`, sanitized: true }).case as JsonObject);
}

async function activeProfile(f: Awaited<ReturnType<typeof fixture>>) {
  const task = f.service.taskOpen({ title: "Engineering quality", goal: "Bound a local change" }).task as JsonObject;
  const installed = f.service.engineeringQualityProfileInstall().kit as JsonObject;
  f.service.capabilityKitConformance({ kit_id: installed.id });
  const activation = f.service.engineeringQualityProfileActivate({ task_id: task.id }).activation as JsonObject;
  return { task, installed, activation };
}

function verifiedReceipt(f: Awaited<ReturnType<typeof fixture>>, plan: JsonObject, caseId: string, trial: number, arm: "baseline" | "profile", verdict: "passed" | "failed" = "passed") {
  const sessionId = `${caseId}-${trial}-${arm}`;
  f.store.create("host_session", sessionId, { host_id: "codex", environment_fingerprint: "environment", model_fingerprint: "model", budget_fingerprint: "budget", trace_id: `trace-${sessionId}`, status: "terminal" });
  f.store.create("outcome_observation", `observation-${sessionId}`, { trace_id: `trace-${sessionId}`, host_id: "codex", observer_id: "independent-verifier", observer_kind: "workspace", verdict });
  const proof = evidence(f.service, `proof-${sessionId}`);
  return f.service.engineeringQualityProfileEvaluationReceiptRecord({ plan_id: plan.id, case_id: caseId, trial_index: trial, arm, host_session_id: sessionId, observation_id: `observation-${sessionId}`, receipt: {
    frozen_input_digest: `sha256:input-${caseId}`, workspace_snapshot_digest: `sha256:workspace-${caseId}-${trial}-${arm}`,
    acceptance_command_digest: `sha256:accept-${caseId}`, sibling_caller_assertion_digest: `sha256:sibling-${caseId}`,
    evidence_ids: [proof.id], retry_count: 0, cost_units: 1, latency_ms: 10,
  } });
}

test("Engineering Quality Profile is an explicit, revocable Kit with only local effects and declared phases", async () => {
  const f = await fixture();
  try {
    const installed = f.service.engineeringQualityProfileInstall().kit as JsonObject;
    const manifest = installed.manifest as JsonObject;
    assert.equal(installed.id, "engineering-quality-profile");
    assert.deepEqual(manifest.effects, ["local_write", "read_only"]);
    assert.deepEqual(manifest.hooks, ["accept.evaluate", "instrument.emit", "observe.snapshot", "plan.propose", "preflight.check"]);
    assert.equal((f.service.capabilityKitDistribution({ kit_id: installed.id }).distribution as JsonObject).execution_authority, false);
    const task = f.service.taskOpen({ title: "T", goal: "T" }).task as JsonObject;
    assert.equal((f.service.capabilityKitActivate({ kit_id: installed.id, task_id: task.id }).activation as JsonObject).status, "blocked");
    f.service.capabilityKitConformance({ kit_id: installed.id });
    const activation = f.service.engineeringQualityProfileActivate({ task_id: task.id }).activation as JsonObject;
    assert.equal(activation.activation_profile_id, "engineering-quality-profile");
    const mcp = new McpServer(f.service, "full");
    assert.equal(mcp.tools.some((tool) => tool.name === "craft_engineering_quality_profile_evaluation_plan"), true);
    const context = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_engineering_quality_profile_trial_context", arguments: { activation_id: activation.id } } });
    assert.equal((context?.result as JsonObject).isError, false);
    assert.throws(() => f.service.engineeringQualityProfileActivate({ task_id: task.id, activation_id: activation.id, profile_version: "different" }), /version/u);
    f.service.capabilityKitSetState({ kit_id: installed.id, state: "revoked", actor: "user", reason: "stop" });
    assert.throws(() => f.service.engineeringQualityProfileTrialContext({ activation_id: activation.id }), /unavailable|active/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Engineering Quality Profile records all three rules as digest-only evidence-bound contributions", async () => {
  const f = await fixture();
  try {
    const { activation } = await activeProfile(f);
    const root = evidence(f.service, "root"); const reuse = evidence(f.service, "reuse"); const scope = evidence(f.service, "scope");
    const rootCause = f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "root-cause-minimal-change",
      proposal: { root_cause: "digest", reuse_candidate: "digest", minimal_change: "digest" }, evidence_ids: [root.id, reuse.id, scope.id] }).contribution as JsonObject;
    assert.equal(rootCause.raw_content_stored, false);
    assert.deepEqual(rootCause.proposal_keys, ["minimal_change", "reuse_candidate", "root_cause"]);
    const acceptance = evidence(f.service, "acceptance");
    const verification = f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "risk-driven-verification",
      proposal: { risk_level: "high", verification_mode: "tdd", acceptance_ref: "digest" }, evidence_ids: [acceptance.id] }).contribution as JsonObject;
    assert.equal(verification.phase, "preflight.check");
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "risk-driven-verification",
      proposal: { risk_level: "high", verification_mode: "direct", acceptance_ref: "digest" }, evidence_ids: [acceptance.id] }), /TDD/u);
    const standard = evidence(f.service, "standards"); const spec = evidence(f.service, "spec"); const reproduce = evidence(f.service, "reproduce");
    f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "independent-dual-review",
      proposal: { review_axis: "standards", baseline_digest: "sha256:baseline", blind_input_digest: "sha256:blind-standards", reviewer_id: "reviewer-standards", finding_digest: "sha256:one" }, evidence_ids: [standard.id] });
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "independent-dual-review",
      contribution_id: "different-review-contribution", review_id: "engineering_quality_review_fbd1a34a3b50e0e5e849", proposal: { review_axis: "standards", baseline_digest: "sha256:baseline", finding_digest: "sha256:changed" }, evidence_ids: [standard.id] }), /already recorded/u);
    f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "independent-dual-review",
      proposal: { review_axis: "spec", baseline_digest: "sha256:baseline", blind_input_digest: "sha256:blind-spec", reviewer_id: "reviewer-spec", finding_digest: "sha256:two" }, evidence_ids: [spec.id] });
    const aggregate = f.service.engineeringQualityProfileReviewAggregate({ activation_id: activation.id, reproduction_evidence_ids: [reproduce.id] }).aggregate as JsonObject;
    assert.deepEqual(aggregate.review_axes, ["spec", "standards"]);
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "independent-dual-review",
      proposal: { review_axis: "standards", baseline_digest: "sha256:baseline", finding_digest: "sha256:three" }, evidence_ids: [standard.id] }), /already recorded/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Engineering Quality Profile accepts only complete five-way Codex pairs without blockers or regressions", async () => {
  const f = await fixture();
  try {
    const { activation } = await activeProfile(f);
    const cases = Array.from({ length: 12 }, (_, index) => `bug-fix-shared-caller-${index + 1}`);
    registerCases(f, cases);
    const plan = f.service.engineeringQualityProfileEvaluationPlan({ plan_id: "profile-plan", activation_id: activation.id, host_id: "codex",
      case_ids: cases, model_fingerprint: "model", environment_fingerprint: "environment", budget_fingerprint: "budget", trials_per_pair: 5 }).plan as JsonObject;
    for (const caseId of cases) for (let trial = 1; trial <= 5; trial += 1) for (const arm of ["baseline", "profile"] as const) {
      verifiedReceipt(f, plan, caseId, trial, arm);
    }
    const result = f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: plan.id }).evaluation as JsonObject;
    assert.equal(result.status, "shadow_candidate");
    assert.equal(result.routeable_candidate, true);
    assert.equal(f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: plan.id }).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Engineering Quality Profile keeps legacy caller booleans revalidation-only", async () => {
  const f = await fixture();
  try {
    const { activation } = await activeProfile(f);
    const cases = Array.from({ length: 12 }, (_, index) => `bug-fix-shared-caller-${index + 1}`);
    registerCases(f, cases);
    const plan = f.service.engineeringQualityProfileEvaluationPlan({ activation_id: activation.id, host_id: "codex",
      case_ids: cases, model_fingerprint: "model",
      environment_fingerprint: "environment", budget_fingerprint: "budget", trials_per_pair: 5 }).plan as JsonObject;
    f.store.create("host_session", "blocked-session", { host_id: "codex", environment_fingerprint: "environment", trace_id: "blocked-trace" });
    f.store.create("outcome_observation", "blocked-observation", { trace_id: "blocked-trace", host_id: "codex", observer_id: "independent-verifier", observer_kind: "workspace", verdict: "failed" });
    const cause = evidence(f.service, "blocked-cause");
    const record = f.service.engineeringQualityProfileEvaluationRecord({ plan_id: plan.id, case_id: "bug-fix-shared-caller-1", trial_index: 1, arm: "profile",
      host_session_id: "blocked-session", observation_id: "blocked-observation", deterministic_acceptance_passed: false, sibling_caller_passed: false,
      unauthorized_effect: true, safety_regression: true, factual_regression: true, root_cause_evidence_ids: [cause.id], retry_count: 0, cost_units: 1, latency_ms: 10 });
    assert.equal((record.record as JsonObject).status, "revalidation_required");
    assert.equal((record.plan as JsonObject).status, "collecting");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Engineering Quality Profile fails closed on malformed rules, review drift, and incomplete or regressing trials", async () => {
  const f = await fixture();
  try {
    const { installed, activation } = await activeProfile(f);
    assert.equal((f.service.engineeringQualityProfileActivate({ task_id: activation.task_id }).idempotent), true);
    assert.equal(((f.service.engineeringQualityProfileTrialContext({ activation_id: activation.id }).profile as JsonObject).external_effects), false);
    const one = evidence(f.service, "one"); const two = evidence(f.service, "two"); const three = evidence(f.service, "three");
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "root-cause-minimal-change", proposal: {}, evidence_ids: [one.id] }), /root_cause/u);
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "root-cause-minimal-change", proposal: { root_cause: "x", reuse_candidate: "y", minimal_change: "z" }, evidence_ids: [one.id] }), /three Evidence/u);
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "risk-driven-verification", proposal: { risk_level: "low", verification_mode: "tdd", acceptance_ref: "x" }, evidence_ids: [one.id] }), /direct/u);
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "risk-driven-verification", proposal: { risk_level: "unknown", verification_mode: "tdd", acceptance_ref: "x" }, evidence_ids: [one.id] }), /unsupported/u);
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "unknown", proposal: {}, evidence_ids: [one.id] }), /unsupported/u);
    const reviewArgs = { activation_id: activation.id, rule_id: "independent-dual-review", contribution_id: "review-contribution", review_id: "review-standards",
      proposal: { review_axis: "standards", baseline_digest: "sha256:baseline", finding_digest: "sha256:finding" }, evidence_ids: [one.id] };
    f.service.engineeringQualityProfileContribution(reviewArgs);
    assert.throws(() => f.service.engineeringQualityProfileReviewAggregate({ activation_id: activation.id, reproduction_evidence_ids: [one.id] }), /one isolated/u);
    f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "independent-dual-review", contribution_id: "review-spec", review_id: "review-spec",
      proposal: { review_axis: "spec", baseline_digest: "sha256:baseline", finding_digest: "sha256:spec" }, evidence_ids: [two.id] });
    const aggregate = f.service.engineeringQualityProfileReviewAggregate({ aggregate_id: "aggregate", activation_id: activation.id, reproduction_evidence_ids: [three.id] });
    assert.equal(f.service.engineeringQualityProfileReviewAggregate({ aggregate_id: "aggregate", activation_id: activation.id, reproduction_evidence_ids: [three.id] }).idempotent, true);
    assert.throws(() => f.service.engineeringQualityProfileReviewAggregate({ aggregate_id: "aggregate", activation_id: activation.id, reproduction_evidence_ids: [one.id] }), /idempotency/u);
    assert.ok(aggregate.aggregate);
    const cases = Array.from({ length: 12 }, (_, index) => `case-${index + 1}`);
    registerCases(f, cases);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationPlan({ activation_id: activation.id, host_id: "codex", case_ids: ["only"], model_fingerprint: "m", environment_fingerprint: "e", budget_fingerprint: "b", trials_per_pair: 5 }), /12 to 20/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationPlan({ activation_id: activation.id, host_id: "codex", case_ids: cases, model_fingerprint: "m", environment_fingerprint: "e", budget_fingerprint: "b", trials_per_pair: 3 }), /exactly five/u);
    const planArgs = { plan_id: "incomplete", activation_id: activation.id, host_id: "codex", case_ids: cases, model_fingerprint: "m", environment_fingerprint: "e", budget_fingerprint: "b", trials_per_pair: 5 };
    const plan = f.service.engineeringQualityProfileEvaluationPlan(planArgs).plan as JsonObject;
    assert.equal(f.service.engineeringQualityProfileEvaluationPlan(planArgs).idempotent, true);
    f.store.create("host_session", "session", { host_id: "codex", environment_fingerprint: "e", trace_id: "trace" });
    f.store.create("outcome_observation", "observation", { trace_id: "trace", host_id: "codex", observer_id: "verifier", observer_kind: "workspace", verdict: "passed" });
    const recordArgs = { plan_id: plan.id, case_id: "case-1", trial_index: 1, arm: "baseline", host_session_id: "session", observation_id: "observation",
      deterministic_acceptance_passed: true, sibling_caller_passed: true, unauthorized_effect: false, safety_regression: false, factual_regression: false,
      root_cause_evidence_ids: [one.id], retry_count: 0, cost_units: 1, latency_ms: 1, record_id: "baseline-record" };
    f.service.engineeringQualityProfileEvaluationRecord(recordArgs);
    assert.equal(f.service.engineeringQualityProfileEvaluationRecord(recordArgs).idempotent, true);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ ...recordArgs, record_id: "duplicate-record" }), /slot/u);
    const incomplete = f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: plan.id }).evaluation as JsonObject;
    assert.equal(incomplete.status, "inconclusive");
    assert.equal((f.service.engineeringQualityProfileEvaluationGet({ plan_id: plan.id }).evaluation as JsonObject).id, incomplete.id);
    f.store.save("capability_kit", String(installed.id), { ...installed, manifest_digest: "sha256:drift" });
    assert.throws(() => f.service.engineeringQualityProfileTrialContext({ activation_id: activation.id }), /drifted/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Engineering Quality Profile receipt protocol rejects forged, drifted, duplicate, and non-reproducible trial facts", async () => {
  const f = await fixture();
  try {
    const { activation } = await activeProfile(f);
    const cases = Array.from({ length: 12 }, (_, index) => `receipt-case-${index + 1}`);
    const frozen = registerCases(f, cases)[0]!;
    assert.equal(f.service.engineeringQualityProfileCaseSave({ case_id: frozen.id, case_kind: "bug-fix-shared-caller", frozen_input_digest: frozen.frozen_input_digest,
      allowed_workspace_ref: frozen.allowed_workspace_ref, acceptance_command_digest: frozen.acceptance_command_digest,
      sibling_caller_assertion_digest: frozen.sibling_caller_assertion_digest, sanitized: true }).idempotent, true);
    assert.throws(() => f.service.engineeringQualityProfileCaseSave({ case_id: frozen.id, case_kind: "bug-fix-shared-caller", frozen_input_digest: "sha256:other",
      allowed_workspace_ref: frozen.allowed_workspace_ref, acceptance_command_digest: frozen.acceptance_command_digest,
      sibling_caller_assertion_digest: frozen.sibling_caller_assertion_digest, sanitized: true }), /idempotency/u);
    assert.throws(() => f.service.engineeringQualityProfileCaseSave({ case_id: "not-sanitized", case_kind: "other", frozen_input_digest: "sha256:input",
      allowed_workspace_ref: "workspace://x", acceptance_command_digest: "sha256:accept", sibling_caller_assertion_digest: "sha256:sibling", sanitized: false }), /sanitized/u);
    const plan = f.service.engineeringQualityProfileEvaluationPlan({ plan_id: "receipt-plan", activation_id: activation.id, host_id: "codex", case_ids: cases,
      model_fingerprint: "model", environment_fingerprint: "environment", budget_fingerprint: "budget", trials_per_pair: 5 }).plan as JsonObject;
    const make = (suffix: string, overrides: JsonObject = {}) => {
      const sessionId = `receipt-session-${suffix}`;
      f.store.create("host_session", sessionId, { host_id: "codex", environment_fingerprint: "environment", model_fingerprint: "model", budget_fingerprint: "budget",
        trace_id: `receipt-trace-${suffix}`, status: "terminal", ...overrides });
      f.store.create("outcome_observation", `receipt-observation-${suffix}`, { trace_id: `receipt-trace-${suffix}`, host_id: "codex", observer_id: "verifier", observer_kind: "workspace", verdict: "passed", ...overrides });
      const proof = evidence(f.service, `receipt-proof-${suffix}`);
      return { sessionId, observationId: `receipt-observation-${suffix}`, proof };
    };
    const valid = make("valid");
    const base = { plan_id: plan.id, case_id: cases[0], trial_index: 1, arm: "baseline", host_session_id: valid.sessionId, observation_id: valid.observationId,
      receipt: { frozen_input_digest: "sha256:input-receipt-case-1", workspace_snapshot_digest: "sha256:workspace", acceptance_command_digest: "sha256:accept-receipt-case-1",
        sibling_caller_assertion_digest: "sha256:sibling-receipt-case-1", evidence_ids: [valid.proof.id], retry_count: 0, cost_units: 1, latency_ms: 1 } };
    assert.equal((f.service.engineeringQualityProfileEvaluationReceiptRecord(base).record as JsonObject).status, "verified");
    assert.equal(f.service.engineeringQualityProfileEvaluationReceiptRecord(base).idempotent, true);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ ...base, receipt: { ...(base.receipt as JsonObject), cost_units: 2 } }), /idempotency/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ ...base, record_id: "other" }), /slot/u);
    const invalidSession = make("running", { status: "running" });
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ ...base, case_id: cases[1], host_session_id: invalidSession.sessionId, observation_id: invalidSession.observationId,
      receipt: { ...(base.receipt as JsonObject), frozen_input_digest: "sha256:input-receipt-case-2", acceptance_command_digest: "sha256:accept-receipt-case-2", sibling_caller_assertion_digest: "sha256:sibling-receipt-case-2", evidence_ids: [invalidSession.proof.id] } }), /fixed plan/u);
    const driftedSession = make("drift", { model_fingerprint: "other" });
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ ...base, case_id: cases[2], host_session_id: driftedSession.sessionId, observation_id: driftedSession.observationId,
      receipt: { ...(base.receipt as JsonObject), frozen_input_digest: "sha256:input-receipt-case-3", acceptance_command_digest: "sha256:accept-receipt-case-3", sibling_caller_assertion_digest: "sha256:sibling-receipt-case-3", evidence_ids: [driftedSession.proof.id] } }), /fixed plan/u);
    const nonIndependent = make("self", { observer_id: "codex" });
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ ...base, case_id: cases[3], host_session_id: nonIndependent.sessionId, observation_id: nonIndependent.observationId,
      receipt: { ...(base.receipt as JsonObject), frozen_input_digest: "sha256:input-receipt-case-4", acceptance_command_digest: "sha256:accept-receipt-case-4", sibling_caller_assertion_digest: "sha256:sibling-receipt-case-4", evidence_ids: [nonIndependent.proof.id] } }), /independent/u);
    const badEvidence = make("evidence");
    const weak = evidence(f.service, "weak-receipt", "human");
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ ...base, case_id: cases[4], host_session_id: badEvidence.sessionId, observation_id: badEvidence.observationId,
      receipt: { ...(base.receipt as JsonObject), frozen_input_digest: "sha256:input-receipt-case-5", acceptance_command_digest: "sha256:accept-receipt-case-5", sibling_caller_assertion_digest: "sha256:sibling-receipt-case-5", evidence_ids: [weak.id] } }), /program Evidence/u);
    const digestDrift = make("digest");
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ ...base, case_id: cases[5], host_session_id: digestDrift.sessionId, observation_id: digestDrift.observationId,
      receipt: { ...(base.receipt as JsonObject), frozen_input_digest: "sha256:drift", acceptance_command_digest: "sha256:accept-receipt-case-6", sibling_caller_assertion_digest: "sha256:sibling-receipt-case-6", evidence_ids: [digestDrift.proof.id] } }), /frozen_input_digest drifted/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationPlan({ plan_id: plan.id, activation_id: activation.id, host_id: "other", case_ids: cases,
      model_fingerprint: "model", environment_fingerprint: "environment", budget_fingerprint: "budget", trials_per_pair: 5 }), /idempotency/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ ...base, arm: "unsupported" }), /unsupported/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ ...base, case_id: "unknown" }), /not in the plan/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ ...base, trial_index: 6 }), /outside/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Engineering Quality Profile rejects an activation whose durable state changes after install", async () => {
  const f = await fixture();
  try {
    const { activation } = await activeProfile(f);
    f.store.save("capability_kit_activation", String(activation.id), { ...activation, status: "disabled" });
    assert.throws(() => f.service.engineeringQualityProfileTrialContext({ activation_id: activation.id }), /not active|drifted/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Engineering Quality Profile covers invalid receipt forms and every terminal evaluation verdict", async () => {
  const f = await fixture();
  try {
    const { activation } = await activeProfile(f);
    const cases = Array.from({ length: 12 }, (_, index) => `verdict-case-${index + 1}`);
    registerCases(f, cases);
    const plan = f.service.engineeringQualityProfileEvaluationPlan({ plan_id: "verdict-plan", activation_id: activation.id, host_id: "codex", case_ids: cases,
      model_fingerprint: "model", environment_fingerprint: "environment", budget_fingerprint: "budget", trials_per_pair: 5 }).plan as JsonObject;
    const proof = evidence(f.service, "verdict-proof");
    const review = (axis: "standards" | "spec", baseline: string, reviewer: string, evidenceId: string) => f.service.engineeringQualityProfileContribution({
      activation_id: activation.id, rule_id: "independent-dual-review", review_id: `verdict-${axis}`, contribution_id: `verdict-contribution-${axis}`,
      proposal: { review_axis: axis, baseline_digest: baseline, blind_input_digest: `sha256:blind-${axis}`, reviewer_id: reviewer, finding_digest: `sha256:finding-${axis}` }, evidence_ids: [evidenceId],
    });
    const two = evidence(f.service, "verdict-two"); const human = evidence(f.service, "verdict-human", "human");
    review("standards", "sha256:baseline-one", "same-reviewer", String(proof.id));
    review("spec", "sha256:baseline-two", "same-reviewer", String(two.id));
    assert.throws(() => f.service.engineeringQualityProfileReviewAggregate({ activation_id: activation.id, reproduction_evidence_ids: [proof.id] }), /same fixed baseline/u);
    f.store.save("engineering_quality_profile_review", "verdict-spec", { ...f.store.get("engineering_quality_profile_review", "verdict-spec"), baseline_digest: "sha256:baseline-one", reviewer_id: "same-reviewer" });
    assert.throws(() => f.service.engineeringQualityProfileReviewAggregate({ activation_id: activation.id, reproduction_evidence_ids: [proof.id] }), /independent reviewers/u);
    f.store.save("engineering_quality_profile_review", "verdict-spec", { ...f.store.get("engineering_quality_profile_review", "verdict-spec"), reviewer_id: "different-reviewer" });
    assert.throws(() => f.service.engineeringQualityProfileReviewAggregate({ activation_id: activation.id, reproduction_evidence_ids: [human.id] }), /program reproduction/u);
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "independent-dual-review",
      proposal: { review_axis: "other", baseline_digest: "sha256:x", finding_digest: "sha256:y" }, evidence_ids: [proof.id] }), /unsupported/u);
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "root-cause-minimal-change", proposal: { root_cause: "x", reuse_candidate: "y", minimal_change: "z" }, evidence_ids: "bad" as never }), /array/u);
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "root-cause-minimal-change", proposal: { root_cause: "x", reuse_candidate: "y", minimal_change: "z" }, evidence_ids: [proof.id, proof.id, two.id] }), /unique/u);
    assert.throws(() => f.service.engineeringQualityProfileCaseSave({ case_id: "bad-boolean", case_kind: "bug-fix-shared-caller", frozen_input_digest: "not-a-digest",
      allowed_workspace_ref: "workspace://bad", acceptance_command_digest: "sha256:accept", sibling_caller_assertion_digest: "sha256:sibling", sanitized: "yes" as never }), /sha256 digest/u);
    assert.throws(() => f.service.engineeringQualityProfileCaseSave({ case_id: "bad-boolean", case_kind: "bug-fix-shared-caller", frozen_input_digest: "sha256:input",
      allowed_workspace_ref: "workspace://bad", acceptance_command_digest: "sha256:accept", sibling_caller_assertion_digest: "sha256:sibling", sanitized: "yes" as never }), /boolean/u);
    assert.equal((f.service.engineeringQualityProfileEvaluationRecord({ plan_id: plan.id, case_id: cases[0], trial_index: 1, arm: "baseline", record_id: "legacy" }).record as JsonObject).status, "revalidation_required");
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ plan_id: plan.id, case_id: "unknown", trial_index: 1, arm: "baseline" }), /not in the plan/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ plan_id: plan.id, case_id: cases[1], trial_index: 0, arm: "baseline" }), /outside/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ plan_id: plan.id, case_id: cases[1], trial_index: 1, arm: "unsupported" }), /unsupported/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ plan_id: plan.id, case_id: cases[1], trial_index: 1, arm: "baseline", record_id: "legacy" }), /idempotency/u);
    const session = "receipt-session";
    f.store.create("host_session", session, { host_id: "codex", environment_fingerprint: "environment", model_fingerprint: "model", budget_fingerprint: "budget", trace_id: "receipt-trace", status: "terminal" });
    f.store.create("outcome_observation", "receipt-observation", { trace_id: "receipt-trace", host_id: "codex", observer_id: "verifier", observer_kind: "workspace", verdict: "passed" });
    const receipt = { frozen_input_digest: "sha256:input-verdict-case-1", workspace_snapshot_digest: "sha256:workspace", acceptance_command_digest: "sha256:accept-verdict-case-1", sibling_caller_assertion_digest: "sha256:sibling-verdict-case-1", evidence_ids: [proof.id], retry_count: 0, cost_units: 1, latency_ms: 1 };
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ plan_id: plan.id, case_id: cases[0], trial_index: 1, arm: "baseline", host_session_id: session, observation_id: "receipt-observation", receipt: { ...receipt, evidence_ids: "bad" } }), /array/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ plan_id: plan.id, case_id: cases[0], trial_index: 1, arm: "baseline", host_session_id: session, observation_id: "receipt-observation", receipt: { ...receipt, retry_count: -1 } }), /non-negative/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ plan_id: plan.id, case_id: cases[0], trial_index: 1, arm: "baseline", host_session_id: session, observation_id: "receipt-observation", receipt: { ...receipt, cost_units: -1 } }), /non-negative/u);
    f.store.save("engineering_quality_profile_evaluation_plan", String(plan.id), { ...plan, rejection_id: "manual-rejection" });
    f.store.create("engineering_quality_profile_rejection", "manual-rejection", { reason: "fixture" });
    const rejected = f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: plan.id, evaluation_id: "rejected-evaluation" }).evaluation as JsonObject;
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.next_gate, "rework_or_reject");
    assert.equal((f.service.engineeringQualityProfileEvaluationGet({ plan_id: plan.id }).rejection as JsonObject).id, "manual-rejection");
    assert.equal(f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: plan.id, evaluation_id: "rejected-evaluation" }).idempotent, true);
    f.store.create("engineering_quality_profile_evaluation_record", "changed-evaluation-input", { plan_id: plan.id, case_id: cases[0], trial_index: 1, arm: "profile",
      deterministic_acceptance_passed: true, sibling_caller_passed: true, retry_count: 0, cost_units: 0, latency_ms: 0 });
    assert.throws(() => f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: plan.id, evaluation_id: "rejected-evaluation" }), /idempotency/u);
    f.store.save("engineering_quality_profile_evaluation_plan", String(plan.id), { ...f.store.get("engineering_quality_profile_evaluation_plan", String(plan.id)), status: "evaluated" });
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ plan_id: plan.id, case_id: cases[0], trial_index: 1, arm: "baseline" }), /not collecting/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationReceiptRecord({ plan_id: plan.id, case_id: cases[0], trial_index: 1, arm: "baseline", host_session_id: session, observation_id: "receipt-observation", receipt }), /not collecting/u);
    const unevaluated = f.service.engineeringQualityProfileEvaluationPlan({ plan_id: "unevaluated", activation_id: activation.id, host_id: "codex", case_ids: cases,
      model_fingerprint: "model", environment_fingerprint: "environment", budget_fingerprint: "budget", trials_per_pair: 5 }).plan as JsonObject;
    assert.equal(f.service.engineeringQualityProfileEvaluationGet({ plan_id: unevaluated.id }).evaluation, null);
    f.store.save("engineering_quality_profile_case", cases[0], { ...f.store.get("engineering_quality_profile_case", cases[0]), status: "candidate" });
    assert.throws(() => f.service.engineeringQualityProfileEvaluationPlan({ plan_id: "unfrozen", activation_id: activation.id, host_id: "codex", case_ids: cases,
      model_fingerprint: "model", environment_fingerprint: "environment", budget_fingerprint: "budget", trials_per_pair: 5 }), /not frozen/u);
    f.store.save("engineering_quality_profile_case", cases[0], { ...f.store.get("engineering_quality_profile_case", cases[0]), status: "frozen" });
    const failedPlan = f.service.engineeringQualityProfileEvaluationPlan({ plan_id: "failed-plan", activation_id: activation.id, host_id: "codex", case_ids: cases.slice(1).concat(cases[0]),
      model_fingerprint: "model", environment_fingerprint: "environment", budget_fingerprint: "budget", trials_per_pair: 5 }).plan as JsonObject;
    for (const caseId of failedPlan.case_ids as string[]) for (let trial = 1; trial <= 5; trial += 1) for (const arm of ["baseline", "profile"] as const) {
      f.store.create("engineering_quality_profile_evaluation_record", `failed-${caseId}-${trial}-${arm}`, { plan_id: failedPlan.id, case_id: caseId, trial_index: trial, arm,
        deterministic_acceptance_passed: !(caseId === cases[0] && trial === 1 && arm === "profile"), sibling_caller_passed: true, retry_count: 0, cost_units: 0, latency_ms: 0 });
    }
    assert.equal((f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: failedPlan.id }).evaluation as JsonObject).status, "rejected");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
