import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { projectPilotTaskResult, reviewPilotResults } from "../core/pilot-results.ts";

function route(overrides: JsonObject = {}): JsonObject {
  return { id: "route-1", task_id: "task-1", queue_state: "finished",
    worker: { state: "completed", provider: "codex", reason: null }, ...overrides };
}

function taskView(overrides: JsonObject = {}): JsonObject {
  return { messages: [], outcomes: [], evidence: [], artifacts: [], attention: [],
    acceptance_checks: [], acceptance_assessments: [], work_launches: [], ...overrides };
}

test("Pilot result projection stays quiet until independent verification exists", () => {
  const working = projectPilotTaskResult({ id: "task-1" }, { task_id: "task-1", queue_state: "running" }, taskView());
  assert.equal(working.verdict, "working");
  assert.equal(working.provenance, "none");
  const awaiting = projectPilotTaskResult({ id: "task-1" }, route(), taskView({
    messages: [{ role: "assistant", content: "我已修改" }],
  }));
  assert.equal(awaiting.verdict, "awaiting_verification");
  assert.equal(awaiting.headline, "待验收");
  assert.equal(awaiting.latest_message, "我已修改");
  const noBasis = projectPilotTaskResult({ id: "task-1" }, route(), taskView());
  assert.equal(noBasis.verdict, "needs_attention");
  assert.equal(noBasis.headline, "需要你核对");
});

test("Pilot result projection prefers verified outcome, acceptance and evidence", () => {
  const result = projectPilotTaskResult({ id: "task-1" }, route(), taskView({
    messages: [{ role: "assistant", content: "模型说完成了" }],
    outcomes: [{ id: "outcome", verdict: "passed", summary: "程序验收通过", created_at: "2026-11-05T00:00:00Z" }],
    evidence: [{ id: "evidence", source_type: "program", claim: "测试通过", confidence: "confirmed", created_at: "2026-11-05T00:00:00Z" }],
    artifacts: [{ id: "artifact", kind: "report", name: "report.md", uri: "craft://report", created_at: "2026-11-05T00:00:00Z" }],
    acceptance_checks: [{ id: "check", criterion_id: "tests", result: "passed", summary: "回归通过", created_at: "2026-11-05T00:00:00Z" }],
    acceptance_assessments: [{ id: "assessment", status: "passed", checked: 1, total: 1, created_at: "2026-11-05T00:00:00Z" }],
    work_launches: [{ id: "launch", effective_status: "completed", acceptance_status: "passed", delivery_status: "delivered", updated_at: "2026-11-05T00:00:00Z" }],
  }));
  assert.equal(result.verdict, "passed");
  assert.equal(result.headline, "已交付");
  assert.equal(result.provenance, "task_outcome");
  assert.equal(result.summary, "程序验收通过");
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.acceptance.length, 3);
  assert.equal(result.attention.length, 0);
});

test("Pilot result projection never hides failures or human attention", () => {
  const failed = projectPilotTaskResult({ id: "task-1" }, route({ worker: { state: "failed", reason: "CLI missing" }, queue_state: "finished" }),
    taskView({ outcomes: [{ id: "outcome", verdict: "passed", summary: "局部完成" }] }));
  assert.equal(failed.verdict, "needs_attention");
  assert.equal(failed.summary, "局部完成");
  const attention = projectPilotTaskResult({ id: "task-1" }, route(), taskView({
    attention: [{ id: "attention", status: "open", reason: "等待人工决定", action: "review", priority: 95 }],
    outcomes: [{ id: "outcome", verdict: "passed", summary: "已有结果" }],
  }));
  assert.equal(attention.verdict, "needs_attention");
  assert.equal(attention.attention.length, 1);
  const blocked = projectPilotTaskResult({ id: "task-1" }, route(), taskView({
    acceptance_assessments: [{ id: "assessment", status: "blocked" }],
    outcomes: [{ id: "outcome", verdict: "passed", summary: "已有结果" }],
  }));
  assert.equal(blocked.verdict, "needs_attention");
});

test("Pilot final review requires terminal results and an evidence basis", () => {
  const passed = projectPilotTaskResult({ id: "task-1" }, route(), taskView({
    outcomes: [{ id: "outcome", verdict: "passed", summary: "完成" }],
  }));
  assert.deepEqual(reviewPilotResults([passed]).map((check) => [check.id, check.ok]), [
    ["result_terminal", true], ["result_basis", true], ["result_acceptance", false],
  ]);
  const working = projectPilotTaskResult({ id: "task-2" }, { task_id: "task-2", queue_state: "running" }, taskView());
  const noBasis = projectPilotTaskResult({ id: "task-3" }, { task_id: "task-3", queue_state: "finished" }, taskView());
  const checks = reviewPilotResults([passed, working, noBasis]);
  assert.equal(checks.find((check) => check.id === "result_terminal")?.ok, false);
  assert.equal(checks.find((check) => check.id === "result_basis")?.ok, false);
});

test("Pilot session status exposes result refs and records a final review", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-pilot-results-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const session = (service.pilotSessionOpen({ input: "结果闭环" }) as JsonObject).session as JsonObject;
    const turn = (service.pilotTurnAuto({ session_id: session.id, input: "交付一份报告",
      executor: "codex", executors: ["codex"] }) as JsonObject).turn as JsonObject;
    const taskId = String((turn.task_ids as string[])[0]);
    const routeId = String((turn.route_ids as string[])[0]);
    service.pilotSchedule({ session_id: String(session.id) });
    service.pilotWorkerBind({ route_id: routeId, provider: "codex", state: "started" });
    service.pilotWorkerBind({ route_id: routeId, provider: "codex", state: "completed" });
    service.store.create("trial", "trial-1", { task_id: taskId, subject_type: "acceptance_plan",
      subject_id: "plan-1", subject_version: 1, status: "completed" });
    service.store.create("evidence", "evidence-1", { source_type: "program", claim: "文件存在",
      confidence: "confirmed", artifact_id: "artifact-1", locator: "report.md", observed_at: new Date().toISOString() });
    service.store.create("artifact", "artifact-1", { kind: "report", name: "report.md", uri: "craft://report",
      media_type: "text/markdown", digest: "sha256:ok", created_at: new Date().toISOString() });
    service.store.create("outcome", "outcome_trial-1", { trial_id: "trial-1", verdict: "passed",
      summary: "验收通过", evidence_ids: ["evidence-1"], created_at: new Date().toISOString() });
    service.store.create("acceptance_plan", "plan-1", { task_id: taskId, launch_id: "launch-1",
      name: "报告验收", criteria: [{ id: "exists", method: "program", required: true }], status: "active" });
    service.store.create("acceptance_check", "check-1", { plan_id: "plan-1", criterion_id: "exists",
      evaluator_type: "program", result: "passed", summary: "报告存在", evidence_ids: ["evidence-1"],
      created_at: new Date().toISOString() });
    service.store.create("acceptance_assessment", "assessment_plan-1", { plan_id: "plan-1", task_id: taskId,
      launch_id: "launch-1", status: "passed", checked: 1, total: 1, missing: [], failed: [], blocked: [],
      created_at: new Date().toISOString() });

    const settled = service.pilotSessionReconcile({ session_id: String(session.id) }) as JsonObject;
    assert.ok((settled.reviews as JsonObject[]).some((item) => item.phase === "final"));
    const status = service.pilotSessionStatus({ session_id: session.id }) as JsonObject;
    const result = (status.results as JsonObject[]).find((item) => item.task_id === taskId) as JsonObject;
    assert.equal(result.verdict, "passed");
    assert.equal((result.artifacts as JsonObject[]).length, 1);
    assert.equal((result.evidence as JsonObject[]).length, 1);
    assert.equal((result.acceptance as JsonObject[]).length, 2);
    const finalReview = (status.reviews as JsonObject[]).find((item) => item.phase === "final") as JsonObject;
    assert.equal(finalReview.verdict, "pass");
    assert.equal(finalReview.model_has_authority, false);
    assert.equal((finalReview.checks as JsonObject[]).find((check) => check.id === "result_acceptance")?.ok, true);
    const designs = service.store.list("workflow_design", 10) as JsonObject[];
    assert.equal(designs.length, 1);
    assert.equal(designs[0]?.lifecycle, "draft");
    assert.equal(designs[0]?.routeable, false);
    assert.equal(service.store.list("experience_observation", 10).length, 1);
    service.pilotSessionReconcile({ session_id: String(session.id) });
    assert.equal(service.store.list("pilot_review", 10, (item) => item.phase === "final").length, 1);
    assert.equal(service.store.list("workflow_design", 10).length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Pilot background reconcile covers every active session and accepts bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-pilot-reconcile-all-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const first = (service.pilotSessionOpen({ input: "background one" }) as JsonObject).session as JsonObject;
    const second = (service.pilotSessionOpen({ input: "background two" }) as JsonObject).session as JsonObject;
    for (const session of [first, second]) {
      const turn = (service.pilotTurnAuto({ session_id: session.id, input: "后台收口",
        executor: "codex", executors: ["codex"] }) as JsonObject).turn as JsonObject;
      const routeId = String((turn.route_ids as string[])[0]);
      service.pilotSchedule({ session_id: String(session.id) });
      service.pilotWorkerBind({ route_id: routeId, provider: "codex", state: "started" });
      service.store.create("workbench_agent_session_link", `link_${String(session.id)}`, {
        task_id: String((turn.task_ids as string[])[0]), provider: "codex", native_session_id: "native",
        workspace: root, model: null, permission: "auto", turn_state: "idle", operation_id: null,
        turn_id: null, last_turn_id: "turn", last_turn_status: "completed",
      });
    }
    const result = service.pilotReconcileAll() as JsonObject;
    assert.equal(result.sessions, 2);
    assert.equal(service.pilotReconcileAll({ limit: 1 }).sessions, 0);
    assert.throws(() => service.pilotReconcileAll({ limit: 0 }), /limit/u);
    assert.throws(() => service.pilotReconcileAll({ limit: 1001 }), /limit/u);
    const firstStatus = service.pilotSessionStatus({ session_id: first.id }) as JsonObject;
    assert.equal((firstStatus.routes as JsonObject[])[0]?.queue_state, "finished");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("Release gate stays quiet without evaluation, signoff, canary and publication", () => {
  const base = projectPilotTaskResult({ id: "task-1" }, route(), taskView({
    outcomes: [{ id: "outcome", verdict: "passed", summary: "完成" }],
  }), null, null, null, null);
  assert.equal(base.verdict, "passed");
  assert.equal(base.release.status, "pending_evaluation");
  assert.equal(base.release.publication_allowed, false);
});

test("Release gate walks evaluation -> signoff -> canary -> publication in order", () => {
  const run = { id: "run-1", subject_type: "task", subject_id: "task-1", split: "held_out", verdict: "passed" };
  const signoff = { id: "signoff-1", subject_type: "pilot_delivery", subject_id: "task-1", evaluation_run_id: "run-1", decision: "passed" };
  const canary = { id: "canary-1", candidate_id: "task-1", status: "passed" };
  const publication = { status: "published" };
  const result = projectPilotTaskResult({ id: "task-1" }, route(), taskView({
    outcomes: [{ id: "outcome", verdict: "passed", summary: "完成" }],
  }), run, signoff, canary, publication);
  assert.equal(result.release.status, "released");
  assert.equal(result.release.evaluation_run_id, "run-1");
  assert.equal(result.release.signoff_id, "signoff-1");
  assert.equal(result.release.canary_id, "canary-1");
  assert.equal(result.release.publication_allowed, false);
});

test("Release gate blocks on mismatched or incomplete gate records", () => {
  const run = { id: "run-1", subject_type: "task", subject_id: "task-1", split: "held_out", verdict: "passed" };
  const wrongSubject = projectPilotTaskResult({ id: "task-1" }, route(), taskView({
    outcomes: [{ id: "outcome", verdict: "passed", summary: "完成" }],
  }), { ...run, subject_id: "task-other" }, null, null, null);
  assert.equal(wrongSubject.release.status, "blocked");
  const noCanary = projectPilotTaskResult({ id: "task-1" }, route(), taskView({
    outcomes: [{ id: "outcome", verdict: "passed", summary: "完成" }],
  }), run, { id: "signoff-1", subject_type: "pilot_delivery", subject_id: "task-1", evaluation_run_id: "run-1", decision: "passed" }, null, null);
  assert.equal(noCanary.release.status, "canary_ready");
});

test("Release gate only applies to delivered tasks", () => {
  const run = { id: "run-1", subject_type: "task", subject_id: "task-1", split: "held_out", verdict: "passed" };
  const awaiting = projectPilotTaskResult({ id: "task-1" }, { task_id: "task-1", queue_state: "running" }, taskView(), run, null, null, null);
  assert.equal(awaiting.verdict, "working");
  assert.equal(awaiting.release.status, "not_applicable");
});
