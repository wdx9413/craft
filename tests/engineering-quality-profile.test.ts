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
      proposal: { review_axis: "standards", baseline_digest: "sha256:baseline", finding_digest: "sha256:one" }, evidence_ids: [standard.id] });
    f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "independent-dual-review",
      proposal: { review_axis: "spec", baseline_digest: "sha256:baseline", finding_digest: "sha256:two" }, evidence_ids: [spec.id] });
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
      const sessionId = `${caseId}-${trial}-${arm}`;
      f.store.create("host_session", sessionId, { host_id: "codex", environment_fingerprint: "environment", trace_id: `trace-${sessionId}` });
      f.store.create("outcome_observation", `observation-${sessionId}`, { trace_id: `trace-${sessionId}`, host_id: "codex", observer_id: "independent-verifier", observer_kind: "workspace", verdict: "passed" });
      const cause = evidence(f.service, `cause-${sessionId}`);
      f.service.engineeringQualityProfileEvaluationRecord({ plan_id: plan.id, case_id: caseId, trial_index: trial, arm, host_session_id: sessionId,
        observation_id: `observation-${sessionId}`, deterministic_acceptance_passed: true, sibling_caller_passed: true,
        unauthorized_effect: false, safety_regression: false, factual_regression: false, root_cause_evidence_ids: [cause.id], retry_count: 0,
        cost_units: 1, latency_ms: 10 });
    }
    const result = f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: plan.id }).evaluation as JsonObject;
    assert.equal(result.status, "shadow_candidate");
    assert.equal(result.routeable_candidate, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Engineering Quality Profile rejects an unauthorized effect and preserves its rejection receipt", async () => {
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
    assert.equal((record.plan as JsonObject).status, "rejected");
    assert.equal(((record.rejection as JsonObject).reasons as string[]).includes("unauthorized_effect"), true);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ plan_id: plan.id, case_id: "bug-fix-shared-caller-1", trial_index: 1, arm: "baseline",
      host_session_id: "blocked-session", observation_id: "blocked-observation", deterministic_acceptance_passed: false, sibling_caller_passed: false,
      unauthorized_effect: false, safety_regression: false, factual_regression: false, root_cause_evidence_ids: [cause.id], retry_count: 0, cost_units: 1, latency_ms: 10 }), /collecting/u);
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

test("Engineering Quality Profile guards every declared receipt boundary and rejected promotion path", async () => {
  const f = await fixture();
  try {
    const { activation } = await activeProfile(f);
    const program = evidence(f.service, "program"); const human = evidence(f.service, "human", "human");
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "root-cause-minimal-change", proposal: {}, evidence_ids: "bad" as never }), /array/u);
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "risk-driven-verification", proposal: { risk_level: "medium", verification_mode: "tdd", acceptance_ref: "a" }, evidence_ids: [] }), /at least 1/u);
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "independent-dual-review", proposal: { review_axis: "bad", baseline_digest: "sha256:x", finding_digest: "sha256:y" }, evidence_ids: [program.id] }), /axis/u);
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "independent-dual-review", proposal: { review_axis: "standards", baseline_digest: "not-a-digest", finding_digest: "sha256:y" }, evidence_ids: [program.id] }), /sha256/u);
    f.store.create("engineering_quality_profile_review", "stored-spec", { activation_id: activation.id, activation_version: activation.version, contribution_id: "stored", contribution_version: 1,
      axis: "spec", baseline_digest: "sha256:stored", evidence_ids: [program.id], identity_digest: "sha256:stored" });
    assert.throws(() => f.service.engineeringQualityProfileContribution({ activation_id: activation.id, rule_id: "independent-dual-review", contribution_id: "mismatch-contribution", review_id: "stored-spec",
      proposal: { review_axis: "standards", baseline_digest: "sha256:baseline", finding_digest: "sha256:finding" }, evidence_ids: [program.id] }), /idempotency/u);
    f.store.create("engineering_quality_profile_review", "stored-standards", { activation_id: activation.id, activation_version: activation.version, contribution_id: "stored-2", contribution_version: 1,
      axis: "standards", baseline_digest: "sha256:other", evidence_ids: [program.id], identity_digest: "sha256:stored-2" });
    assert.throws(() => f.service.engineeringQualityProfileReviewAggregate({ activation_id: activation.id, reproduction_evidence_ids: [program.id] }), /same fixed baseline/u);
    f.store.save("engineering_quality_profile_review", "stored-standards", { ...f.store.get("engineering_quality_profile_review", "stored-standards"), baseline_digest: "sha256:stored" });
    assert.throws(() => f.service.engineeringQualityProfileReviewAggregate({ activation_id: activation.id, reproduction_evidence_ids: [human.id] }), /program reproduction/u);
    const cases = Array.from({ length: 12 }, (_, index) => `guard-case-${index + 1}`);
    const savedCases = registerCases(f, cases);
    assert.equal(f.service.engineeringQualityProfileCaseSave({ case_id: savedCases[0]!.id, case_kind: "bug-fix-shared-caller",
      frozen_input_digest: `sha256:input-${savedCases[0]!.id}`, allowed_workspace_ref: `workspace://${savedCases[0]!.id}`,
      acceptance_command_digest: `sha256:accept-${savedCases[0]!.id}`, sibling_caller_assertion_digest: `sha256:sibling-${savedCases[0]!.id}`, sanitized: true }).idempotent, true);
    assert.throws(() => f.service.engineeringQualityProfileCaseSave({ case_id: savedCases[0]!.id, case_kind: "bug-fix-shared-caller",
      frozen_input_digest: `sha256:input-${savedCases[0]!.id}`, allowed_workspace_ref: "workspace://changed",
      acceptance_command_digest: `sha256:accept-${savedCases[0]!.id}`, sibling_caller_assertion_digest: `sha256:sibling-${savedCases[0]!.id}`, sanitized: true }), /idempotency/u);
    assert.throws(() => f.service.engineeringQualityProfileCaseSave({ case_id: "unsafe-case", case_kind: "bug-fix-shared-caller", frozen_input_digest: "sha256:input",
      allowed_workspace_ref: "workspace://unsafe", acceptance_command_digest: "sha256:accept", sibling_caller_assertion_digest: "sha256:sibling", sanitized: false }), /sanitized/u);
    f.store.save("engineering_quality_profile_case", String(savedCases[0]!.id), { ...savedCases[0]!, status: "candidate" });
    assert.throws(() => f.service.engineeringQualityProfileEvaluationPlan({ plan_id: "unfrozen", activation_id: activation.id, host_id: "codex", case_ids: cases,
      model_fingerprint: "m", environment_fingerprint: "e", budget_fingerprint: "b", trials_per_pair: 5 }), /not frozen/u);
    f.store.save("engineering_quality_profile_case", String(savedCases[0]!.id), { ...f.store.get("engineering_quality_profile_case", String(savedCases[0]!.id)), status: "frozen" });
    const plan = f.service.engineeringQualityProfileEvaluationPlan({ plan_id: "guards", activation_id: activation.id, host_id: "codex", case_ids: cases,
      model_fingerprint: "m", environment_fingerprint: "e", budget_fingerprint: "b", trials_per_pair: 5 }).plan as JsonObject;
    assert.equal((f.service.engineeringQualityProfileEvaluationGet({ plan_id: plan.id }).evaluation), null);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationPlan({ plan_id: "guards", activation_id: activation.id, host_id: "codex", case_ids: cases,
      model_fingerprint: "m", environment_fingerprint: "changed", budget_fingerprint: "b", trials_per_pair: 5 }), /idempotency/u);
    f.store.create("host_session", "good-session", { host_id: "codex", environment_fingerprint: "e", trace_id: "good-trace" });
    f.store.create("host_session", "bad-session", { host_id: "other", environment_fingerprint: "e", trace_id: "bad-trace" });
    f.store.create("outcome_observation", "good-observation", { trace_id: "good-trace", host_id: "codex", observer_id: "verifier", observer_kind: "workspace", verdict: "passed" });
    f.store.create("outcome_observation", "own-observation", { trace_id: "good-trace", host_id: "codex", observer_id: "codex", observer_kind: "workspace", verdict: "passed" });
    const input = { plan_id: plan.id, case_id: "guard-case-1", trial_index: 1, arm: "baseline", host_session_id: "good-session", observation_id: "good-observation",
      deterministic_acceptance_passed: true, sibling_caller_passed: true, unauthorized_effect: false, safety_regression: false, factual_regression: false,
      root_cause_evidence_ids: [program.id], retry_count: 0, cost_units: 1, latency_ms: 1, record_id: "guard-record" };
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ ...input, case_id: "missing" }), /not in the plan/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ ...input, trial_index: 0 }), /trial_index/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ ...input, arm: "wrong" }), /arm/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ ...input, host_session_id: "bad-session" }), /Host Session/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ ...input, observation_id: "own-observation" }), /independent/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ ...input, deterministic_acceptance_passed: "yes" as never }), /boolean/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ ...input, retry_count: -1 }), /non-negative integer/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ ...input, retry_count: 0.5 }), /non-negative integer/u);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ ...input, cost_units: Number.NaN }), /non-negative number/u);
    f.service.engineeringQualityProfileEvaluationRecord(input);
    assert.throws(() => f.service.engineeringQualityProfileEvaluationRecord({ ...input, cost_units: 2 }), /idempotency/u);
    const blockerPlan = f.service.engineeringQualityProfileEvaluationPlan({ plan_id: "root-cause-blocker", activation_id: activation.id, host_id: "codex", case_ids: cases,
      model_fingerprint: "m", environment_fingerprint: "e", budget_fingerprint: "b", trials_per_pair: 5 }).plan as JsonObject;
    f.service.engineeringQualityProfileEvaluationRecord({ ...input, plan_id: blockerPlan.id, record_id: "root-cause-record", arm: "profile", root_cause_evidence_ids: [], deterministic_acceptance_passed: true, sibling_caller_passed: true });
    const blocked = f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: blockerPlan.id }).evaluation as JsonObject;
    assert.equal(blocked.status, "rejected");
    assert.ok((f.service.engineeringQualityProfileEvaluationGet({ plan_id: blockerPlan.id }).rejection as JsonObject).id);
    const regressionPlan = f.service.engineeringQualityProfileEvaluationPlan({ plan_id: "regression", activation_id: activation.id, host_id: "codex", case_ids: cases,
      model_fingerprint: "m", environment_fingerprint: "e", budget_fingerprint: "b", trials_per_pair: 5 }).plan as JsonObject;
    for (const caseId of cases) for (let trial = 1; trial <= 5; trial += 1) for (const arm of ["baseline", "profile"] as const) {
      f.store.create("engineering_quality_profile_evaluation_record", `regression-${caseId}-${trial}-${arm}`, { plan_id: regressionPlan.id, case_id: caseId, trial_index: trial, arm,
        deterministic_acceptance_passed: true, sibling_caller_passed: true, retry_count: arm === "profile" ? 1 : 0, cost_units: arm === "profile" ? 2 : 1, latency_ms: arm === "profile" ? 2 : 1 });
    }
    const regression = f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: regressionPlan.id, evaluation_id: "regression-evaluation" }).evaluation as JsonObject;
    assert.equal(regression.status, "rejected");
    assert.equal(f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: regressionPlan.id, evaluation_id: "regression-evaluation" }).idempotent, true);
    f.store.create("engineering_quality_profile_evaluation", "evaluation-conflict", { identity_digest: "sha256:wrong" });
    assert.throws(() => f.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: regressionPlan.id, evaluation_id: "evaluation-conflict" }), /idempotency/u);
    f.store.save("capability_kit_activation", String(activation.id), { ...activation, status: "needs_replan" });
    assert.throws(() => f.service.engineeringQualityProfileTrialContext({ activation_id: activation.id }), /active or is drifted/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
