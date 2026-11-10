import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

async function fixture(name: string) { const root = join(tmpdir(), `craft-acceptance-${name}-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store); service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, stderr: "", timedOut: false, cancelled: false, outputLimited: false }); return { root, store, service }; }
const criteria = [
  { id: "tests", name: "Automated tests", method: "program", instructions: "Run the declared suite" },
  { id: "quality", name: "Quality review", method: "model" },
  { id: "approval", name: "Owner approval", method: "human" },
  { id: "signal", name: "Observed business signal", method: "business_signal", required: false },
];

test("multi-method acceptance remains separate from Host execution and produces an evidence-backed business outcome", async () => {
  const f = await fixture("pass"); try {
    const launched = f.service.workLaunchPrepare({ launch_id: "launch", title: "Deliver", goal: "Accepted result", host: "codex-cli", workspace: f.root, prompt: "work", acceptance_name: "Definition of done", acceptance_criteria: criteria }).launch as JsonObject; await f.service.hostRuns.wait(String(launched.run_id)); const current = f.service.workLaunchGet({ launch_id: launched.id }); const plan = (current.acceptance as JsonObject).plan as JsonObject; assert.equal(f.store.get("outcome", `outcome_${launched.trial_id}`).verdict, "passed"); assert.equal((current.acceptance as JsonObject).outcome, null);
    f.service.attentionRefresh({}); assert.equal((f.service.attentionList({ audience: "human" }).items as JsonObject[]).some((item) => item.action === "complete_acceptance"), true);
    assert.equal((f.service.acceptanceAssess({ plan_id: plan.id }).assessment as JsonObject).status, "pending");
    const evidence = criteria.map((item) => f.service.evidenceRecord({ evidence_id: `e_${item.id}`, source_type: item.method, confidence: "confirmed", claim: `${item.name} observed` })); const mcp = new McpServer(f.service, "full");
    for (let index = 0; index < criteria.length; index += 1) { const item = criteria[index]; const args = { check_id: `c_${item.id}`, plan_id: plan.id, criterion_id: item.id, evaluator_type: item.method, evaluator_id: `${item.method}-1`, result: item.id === "signal" ? "failed" : "passed", summary: `${item.name} result`, evidence_ids: [evidence[index].id] }; const recorded = await mcp.handlers.craft_acceptance_check_record(args); assert.equal(recorded.idempotent, false); assert.equal((await mcp.handlers.craft_acceptance_check_record(args)).idempotent, true); }
    const assessed = await mcp.handlers.craft_acceptance_assess({ plan_id: plan.id }); assert.equal((assessed.outcome as JsonObject).verdict, "passed"); assert.equal(((assessed.outcome as JsonObject).scores as JsonObject).required_pass_rate, 1); const reassessed = await mcp.handlers.craft_acceptance_assess({ plan_id: plan.id }); assert.equal((reassessed.outcome as JsonObject).id, (assessed.outcome as JsonObject).id); assert.equal(((await mcp.handlers.craft_acceptance_plan_get({ plan_id: plan.id })).checks as JsonObject[]).length, 4);
    f.service.attentionRefresh({}); assert.equal((f.service.attentionList({ audience: "human" }).items as JsonObject[]).some((item) => item.action === "complete_acceptance"), false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("acceptance aggregation distinguishes failed and blocked required criteria", async () => {
  const f = await fixture("verdicts"); try {
    const task = f.service.taskOpen({ title: "Review", goal: "Review" }).task as JsonObject; f.store.create("work_launch", "launch", { task_id: task.id, status: "prepared" }); const evidence = f.service.evidenceRecord({ evidence_id: "e", source_type: "human", confidence: "confirmed", claim: "Reviewed" });
    for (const result of ["failed", "blocked"] as const) { const plan = f.service.acceptancePlanSave({ plan_id: `plan-${result}`, task_id: task.id, launch_id: "launch", name: result, criteria: [{ id: "one", name: "One", method: "human" }] }).plan as JsonObject; f.service.acceptanceCheckRecord({ plan_id: plan.id, criterion_id: "one", evaluator_type: "human", evaluator_id: "owner", result, summary: result, evidence_ids: [evidence.id] }); const assessed = f.service.acceptanceAssess({ plan_id: plan.id }); assert.equal((assessed.assessment as JsonObject).status, result); assert.equal((assessed.outcome as JsonObject).verdict, result === "blocked" ? "blocked" : "failed"); }
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("human review creates typed evidence and reassesses without impersonating other evaluators", async () => {
  const f = await fixture("human-review"); try {
    const task = f.service.taskOpen({ title: "Review", goal: "Approve" }).task as JsonObject; f.store.create("work_launch", "launch", { task_id: task.id });
    const plan = f.service.acceptancePlanSave({ task_id: task.id, launch_id: "launch", criteria: [{ id: "human", name: "Owner approves", method: "human" }, { id: "program", name: "Checker passes", method: "program" }] }).plan as JsonObject;
    const first = f.service.acceptanceHumanReview({ review_id: "review-pass", plan_id: plan.id, criterion_id: "human", reviewer: "owner", result: "passed", summary: "Looks correct" }); assert.equal((first.evidence as JsonObject).confidence, "confirmed"); assert.equal((first.assessment as JsonObject).status, "pending");
    const failed = f.service.acceptanceHumanReview({ plan_id: plan.id, criterion_id: "human", reviewer: "owner", result: "failed", summary: "Needs revision" }); assert.equal((failed.evidence as JsonObject).confidence, "rejected");
    const blocked = new McpServer(f.service, "full").handlers.craft_acceptance_human_review({ review_id: "review-blocked", plan_id: plan.id, criterion_id: "human", reviewer: "owner", result: "blocked", summary: "Waiting for owner" }) as Promise<JsonObject>; assert.equal(((await blocked).evidence as JsonObject).confidence, "bounded");
    assert.throws(() => f.service.acceptanceHumanReview({ plan_id: plan.id, criterion_id: "missing", reviewer: "owner", result: "passed", summary: "x" }), /unknown/); assert.throws(() => f.service.acceptanceHumanReview({ plan_id: plan.id, criterion_id: "program", reviewer: "owner", result: "passed", summary: "x" }), /only accepts human/); assert.throws(() => f.service.acceptanceHumanReview({ plan_id: plan.id, criterion_id: "human", reviewer: "owner", result: "maybe", summary: "x" }), /unsupported/);
  } finally { f.store.close(); }
});

test("acceptance plans and checks reject ambiguous, mismatched, or evidence-free claims", async () => {
  const f = await fixture("guards"); try {
    const task = f.service.taskOpen({ title: "Review", goal: "Review" }).task as JsonObject; const other = f.service.taskOpen({ title: "Other", goal: "Other" }).task as JsonObject; f.store.create("work_launch", "launch", { task_id: task.id, status: "prepared" });
    assert.throws(() => f.service.acceptancePlanSave({ task_id: other.id, launch_id: "launch", name: "x", criteria }), /does not match/); assert.throws(() => f.service.acceptancePlanSave({ task_id: task.id, launch_id: "launch", name: "x", criteria: [] }), /non-empty/); assert.throws(() => f.service.acceptancePlanSave({ task_id: task.id, launch_id: "launch", name: "x", criteria: [{ id: "x", name: "x", method: "magic" }] }), /unsupported/); assert.throws(() => f.service.acceptancePlanSave({ task_id: task.id, launch_id: "launch", name: "x", criteria: [{ id: "x", name: "x", method: "human" }, { id: "x", name: "x", method: "human" }] }), /unique/);
    const input = { plan_id: "plan", task_id: task.id, launch_id: "launch", name: "Plan", criteria: [{ id: "one", name: "One", method: "human" }] }; const plan = f.service.acceptancePlanSave(input).plan as JsonObject; assert.equal(f.service.acceptancePlanSave(input).idempotent, true); assert.throws(() => f.service.acceptancePlanSave({ ...input, criteria: [{ id: "two", name: "Two", method: "human" }] }), /conflict/);
    const evidence = f.service.evidenceRecord({ evidence_id: "e", source_type: "human", confidence: "confirmed", claim: "Reviewed" }); const valid = { check_id: "check", plan_id: plan.id, criterion_id: "one", evaluator_type: "human", evaluator_id: "owner", result: "passed", summary: "ok", evidence_ids: [evidence.id] }; f.service.acceptanceCheckRecord(valid); assert.throws(() => f.service.acceptanceCheckRecord({ ...valid, summary: "drift" }), /conflict/); assert.throws(() => f.service.acceptanceCheckRecord({ ...valid, check_id: "unknown", criterion_id: "missing" }), /unknown/); assert.throws(() => f.service.acceptanceCheckRecord({ ...valid, check_id: "type", evaluator_type: "model" }), /does not match/); assert.throws(() => f.service.acceptanceCheckRecord({ ...valid, check_id: "result", result: "maybe" }), /unsupported/); assert.throws(() => f.service.acceptanceCheckRecord({ ...valid, check_id: "empty", evidence_ids: [] }), /requires evidence/); assert.throws(() => f.service.acceptanceCheckRecord({ ...valid, check_id: "missing-e", evidence_ids: ["missing"] }), /Unknown/);
    const mcp = new McpServer(f.service, "full"); const optionalPlan = (await mcp.handlers.craft_acceptance_plan_save({ plan_id: "optional", task_id: task.id, launch_id: "launch", name: "Optional", criteria: [{ id: "signal", name: "Signal", method: "business_signal", required: false }] })).plan as JsonObject; f.service.acceptanceCheckRecord({ plan_id: optionalPlan.id, criterion_id: "signal", evaluator_type: "business_signal", evaluator_id: "metric", result: "passed", summary: "ok", evidence_ids: [evidence.id] }); assert.equal(((f.service.acceptanceAssess({ plan_id: optionalPlan.id }).outcome as JsonObject).scores as JsonObject).required_pass_rate, 1); const defaultName = f.service.acceptancePlanSave({ plan_id: "default-name", task_id: task.id, launch_id: "launch", criteria: [{ id: "one", name: "One", method: "human" }] }).plan as JsonObject; assert.equal(defaultName.name, "Work acceptance");
    f.store.save("acceptance_plan", String(plan.id), { ...plan, status: "retired" }); assert.throws(() => f.service.acceptanceCheckRecord({ ...valid, check_id: "retired" }), /not active/); f.store.create("acceptance_plan", "legacy", { status: "active" }); assert.equal(f.service.acceptancePlanGet({ plan_id: "legacy" }).outcome, null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("reassessment supports legacy outcomes and optional criteria without rewriting history", async () => {
  const f = await fixture("reassessment");
  try {
    const launch = f.service.workLaunchPrepare({ title: "Optional acceptance", goal: "Review result", host: "codex-cli", workspace: f.root, prompt: "read", acceptance_criteria: [{ id: "review", name: "Optional review", method: "human", required: false }] }).launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const plan = f.store.get("acceptance_plan", String(launch.acceptance_plan_id));
    const old = f.service.outcomeRecord({ trial_id: plan.trial_id, verdict: "failed", summary: "Historical result", evidence_ids: [] });
    const current = f.service.acceptanceAssess({ plan_id: plan.id });
    assert.equal((current.outcome as JsonObject).verdict, "passed");
    assert.notEqual((current.outcome as JsonObject).id, old.id);
    assert.deepEqual(f.store.get("outcome", String(old.id)), old);
    assert.equal(((current.outcome as JsonObject).scores as JsonObject).required_pass_rate, 1);
    const assessment = current.assessment as JsonObject;
    f.store.save("acceptance_assessment", String(assessment.id), { ...assessment, status: "pending" });
    assert.equal(f.service.acceptancePlanGet({ plan_id: plan.id }).outcome, null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("new acceptance rounds require renewed human evidence and reject stale approvals", async () => {
  const f = await fixture("human-recheck");
  try {
    const launch = f.service.workLaunchPrepare({ title: "Review", goal: "Human review", host: "codex-cli", workspace: f.root, prompt: "read", acceptance_criteria: [{ id: "human", name: "Owner review", method: "human" }] }).launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const plan = f.store.get("acceptance_plan", String(launch.acceptance_plan_id));
    const first = f.service.acceptanceHumanReview({ plan_id: plan.id, plan_version: plan.version, criterion_id: "human", reviewer: "user", result: "passed", summary: "checked first output" });
    const recheck = f.service.acceptanceRecheck({ plan_id: plan.id, plan_version: plan.version });
    assert.deepEqual(recheck.jobs, []);
    assert.equal((recheck.assessment as JsonObject).status, "pending");
    assert.equal(recheck.outcome, null);
    assert.throws(() => f.service.acceptanceHumanReview({ plan_id: plan.id, plan_version: plan.version, criterion_id: "human", reviewer: "user", result: "passed", summary: "stale screen" }), /version changed/u);
    assert.throws(() => f.service.acceptanceHumanReview({ plan_id: plan.id, criterion_id: "human", reviewer: "user", result: "passed", summary: "unversioned old caller" }), /requires plan_version/u);
    assert.throws(() => f.service.acceptanceCheckRecord({ plan_id: plan.id, criterion_id: "human", evaluator_type: "human", evaluator_id: "user", result: "passed", summary: "unversioned check", evidence_ids: [(first.evidence as JsonObject).id] }), /requires plan_version/u);
    const second = f.service.acceptanceHumanReview({ plan_id: plan.id, plan_version: (recheck.plan as JsonObject).version, criterion_id: "human", reviewer: "user", result: "failed", summary: "checked changed output" });
    assert.equal((second.outcome as JsonObject).verdict, "failed");
    assert.deepEqual(f.store.get("outcome", String((first.outcome as JsonObject).id)), first.outcome);
    const view = f.service.homeTask({ task_id: launch.task_id });
    const projected = (view.acceptance_plans as JsonObject[])[0];
    assert.equal(projected.status, "failed");
    assert.deepEqual(projected.human_criteria, [{ id: "human", name: "Owner review", frozen_review_required: false }]);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("human acceptance failure leaves no orphan evidence or partially updated conclusion", async t => {
  const f = await fixture("atomic-human");
  try {
    const launch = f.service.workLaunchPrepare({ title: "Atomic review", goal: "Review output", host: "codex-cli", workspace: f.root, prompt: "read", acceptance_criteria: [{ id: "human", name: "Owner review", method: "human" }] }).launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const plan = f.store.get("acceptance_plan", String(launch.acceptance_plan_id));
    const kinds = ["evidence", "acceptance_check", "acceptance_assessment", "outcome", "delivery_loop", "work_delivery"];
    const before = kinds.map(kind => f.store.list(kind, 1000));
    const save = f.store.save.bind(f.store);
    const injected = t.mock.method(f.store, "save", (...args: Parameters<CraftStore["save"]>) => {
      const saved = save(...args);
      if (args[0] === "acceptance_assessment") throw new Error("simulated assessment persistence failure");
      return saved;
    });
    const review = { review_id: "atomic-review", plan_id: plan.id, plan_version: plan.version, criterion_id: "human", reviewer: "user:reviewer", result: "passed", summary: "read actual artifact" };
    assert.throws(() => f.service.acceptanceHumanReview(review), /persistence failure/u);
    injected.mock.restore();
    assert.deepEqual(kinds.map(kind => f.store.list(kind, 1000)), before);
    assert.equal((f.service.acceptanceHumanReview(review).assessment as JsonObject).status, "passed");
    assert.throws(() => f.service.acceptanceCheckRecord({ ...review, evaluator_type: "human", evaluator_id: "user:reviewer", plan_version: Number(plan.version) + 1, evidence_ids: ["evidence_atomic-review"] }), /plan version changed/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("acceptance Trace sync retries committed outcomes after shard or acknowledgement failures", async t => {
  for (const failure of ["trace", "acknowledgement"]) {
    const f = await fixture(`trace-outbox-${failure}`);
    try {
      const launch = f.service.workLaunchPrepare({ title: "Trace retry", goal: "Review output", host: "codex-cli", workspace: f.root, prompt: "read", acceptance_criteria: [{ id: "human", name: "Owner review", method: "human" }] }).launch as JsonObject;
      await f.service.hostRuns.wait(String(launch.run_id));
      const plan = f.store.get("acceptance_plan", String(launch.acceptance_plan_id));
      const save = f.store.save.bind(f.store);
      const injected = failure === "trace"
        ? t.mock.method(f.service.trace, "finalize", () => { throw new Error("simulated Trace outage"); })
        : t.mock.method(f.store, "save", (...args: Parameters<CraftStore["save"]>) => {
          if (args[0] === "acceptance_trace_outbox" && args[2].status === "delivered") throw new Error("simulated acknowledgement outage");
          return save(...args);
        });
      const review = f.service.acceptanceHumanReview({ plan_id: plan.id, criterion_id: "human", reviewer: "user:reviewer", result: "passed", summary: "checked output" });
      assert.equal((review.outcome as JsonObject).verdict, "passed");
      assert.equal(f.store.list("acceptance_trace_outbox", 100, item => item.status === "pending").length, 1);
      injected.mock.restore();
      assert.deepEqual(f.service.acceptanceTraceSync(), { delivered: 1, failed: 0 });
      const traceId = `trial:${plan.trial_id}`;
      const events = f.store.list("trace_event", 1000, item => item.trace_id === traceId);
      assert.equal(f.store.get("trace", traceId).status, "completed");
      assert.deepEqual(f.service.acceptanceTraceSync(), { delivered: 0, failed: 0 });
      assert.deepEqual(f.store.list("trace_event", 1000, item => item.trace_id === traceId), events);
      if (failure === "acknowledgement") {
        const outcome = review.outcome as JsonObject;
        const conflicting = f.store.create("outcome", "simulated-conflicting-outcome", { ...outcome, verdict: "failed" });
        const outbox = f.store.list("acceptance_trace_outbox", 100)[0];
        f.store.save("acceptance_trace_outbox", String(outbox.id), { ...outbox, status: "pending", outcome_id: conflicting.id });
        assert.deepEqual(f.service.acceptanceTraceSync(), { delivered: 0, failed: 1 });
        assert.deepEqual(f.store.list("trace_event", 1000, item => item.trace_id === traceId), events);
      }
    } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
  }
});
