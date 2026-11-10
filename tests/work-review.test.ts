import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { runBuiltinAcceptanceTicks } from "../core/acceptance-worker.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { McpServer } from "../core/mcp.ts";
import { linkDirectory, supportsFileSymlinks } from "./symlink-support.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-frozen-review-"));
  const store = await new CraftStore(craftPaths(root)).open(), service = new CraftService(store);
  const task = service.taskOpen({ title: "Review", goal: "deliver verified bytes" }).task as JsonObject;
  service.codexHost.executor = async () => { await writeFile(join(root, "result.txt"), "ready"); return { exitCode: 0, signal: null, stdout: JSON.stringify({ type: "turn.completed", usage: {} }) + "\n", stderr: "", timedOut: false, cancelled: false, outputLimited: false }; };
  const control = service.taskControlSave({ task_id: task.id, workspace: root, allowed_effects: ["local_write"], acceptance_required: true }).contract as JsonObject;
  const prepared = service.taskRunPrepare({ task_run_id: "review-source", contract_id: control.id, host: "codex-cli", prompt: "produce file", sandbox: "workspace-write", acceptance_criteria: [{ id: "bytes", name: "File bytes", method: "program" }, { id: "review", name: "Independent review", method: "human" }] });
  const launch = service.workLaunchDecide({ launch_id: (prepared.launch as JsonObject).id, approved: true, actor: "worker", prompt: "produce file" }).launch as JsonObject;
  await service.hostRuns.wait(String(launch.run_id));
  service.acceptanceFileEvaluationPrepare({ plan_id: launch.acceptance_plan_id, criterion_id: "bytes", workspace: root, relative_path: "result.txt", expected_sha256: createHash("sha256").update("ready").digest("hex") });
  await runBuiltinAcceptanceTicks(service);
  const request = (id: string) => ({ candidate_id: id, task_run_id: "review-source", task_run_version: store.get("task_run", "review-source").version, launch_version: store.get("work_launch", String(launch.id)).version, host_run_version: store.get("host_run", String(launch.run_id)).version, plan_version: store.get("acceptance_plan", String(launch.acceptance_plan_id)).version, criterion_id: "review", actor: "worker", relative_paths: ["result.txt"] });
  const report = (candidate: JsonObject, result = "passed", findings: JsonObject[] = []) => ({ candidate_id: candidate.id, candidate_version: candidate.version, reviewer: "reviewer", result, summary: "Checked frozen file against the goal", findings });
  return { root, store, service, task, launch, request, report };
}

test("freeze, independent findings and mandatory checks follow immutable bytes through edit, rework and delivery", async () => {
  const f = await fixture();
  try {
    f.service.acceptanceHumanReview({ plan_id: f.launch.acceptance_plan_id, criterion_id: "review", reviewer: "original", result: "passed", summary: "Original acceptance" });
    assert.equal((f.service.taskRunRefresh({ task_run_id: "review-source" }).state as JsonObject).action, "deliver");
    const web = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173");
    const request = f.request("candidate-a");
    const response = web.handle({ method: "POST", path: "/api/task-runs/review-source/freeze-review", token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify({ ...request, task_run_id: "wrong-body-run" }) });
    assert.equal(response.status, 201);
    const a = (JSON.parse(String(response.body)) as JsonObject).candidate as JsonObject;
    assert.equal(f.service.workReviewFreeze(request).idempotent, true);
    assert.throws(() => f.service.workReviewFreeze({ ...request, actor: "other" }), /idempotency conflict/);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "review-source" }).state as JsonObject).action, "collect_acceptance");
    assert.throws(() => f.service.acceptanceHumanReview({ plan_id: a.plan_id, plan_version: a.plan_version, criterion_id: "review", reviewer: "reviewer", result: "passed", summary: "bypass" }), /frozen review report/);
    assert.throws(() => f.service.workReviewReport({ ...f.report(a), reviewer: "worker" }), /own candidate/);
    const mcp = new McpServer(f.service, "full");
    const suggestion = f.report(a, "passed", [{ severity: "suggestion", path: "result.txt", message: "Consider a fuller explanation" }]);
    const accepted = await mcp.handlers.craft_work_review_report(suggestion) as JsonObject;
    assert.equal((accepted.assessment as JsonObject).status, "pending");
    await runBuiltinAcceptanceTicks(f.service);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "review-source" }).state as JsonObject).action, "deliver");
    assert.equal(f.service.workReviewReport(suggestion).idempotent, true);
    assert.throws(() => f.service.workReviewReport({ ...suggestion, summary: "changed report" }), /idempotency conflict/);
    await writeFile(join(f.root, "result.txt"), "broken");
    const frozen = web.handle({ method: "GET", path: "/api/work-reviews/candidate-a?relative_path=result.txt", token: "token" });
    assert.equal(frozen.status, 200);
    assert.equal(Buffer.from(((JSON.parse(String(frozen.body)) as JsonObject).file as JsonObject).content_base64 as string, "base64").toString(), "ready");
    assert.throws(() => f.service.acceptanceHumanReview({ plan_id: a.plan_id, plan_version: a.plan_version, criterion_id: "review", reviewer: "reviewer", result: "passed", summary: suggestion.summary, review_report_id: (accepted.report as JsonObject).id }), /changed after freezing/);
    const b = f.service.workReviewFreeze(f.request("candidate-b")).candidate as JsonObject;
    await runBuiltinAcceptanceTicks(f.service);
    const rejection = web.handle({ method: "POST", path: "/api/work-reviews/candidate-b/report", token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify(f.report(b, "failed", [{ severity: "blocker", path: "result.txt", message: "Output does not satisfy the goal" }])) });
    assert.equal(rejection.status, 200);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "review-source" }).state as JsonObject).action, "retry_or_handoff");
    await writeFile(join(f.root, "result.txt"), "ready");
    const c = f.service.workReviewFreeze(f.request("candidate-c")).candidate as JsonObject;
    f.service.workReviewReport(f.report(c));
    await runBuiltinAcceptanceTicks(f.service);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "review-source" }).state as JsonObject).action, "deliver");
    assert.equal((f.service.workReviewGet({ candidate_id: a.id }).report as JsonObject).result, "passed");
    assert.equal((f.service.workReviewGet({ candidate_id: b.id }).report as JsonObject).result, "failed");
    assert.equal((f.service.homeTask({ task_id: f.task.id }).work_reviews as JsonObject[]).length, 3);
    const homePlan = (f.service.homeTask({ task_id: f.task.id }).acceptance_plans as JsonObject[])[0];
    assert.equal((homePlan.human_criteria as JsonObject[])[0].frozen_review_required, true);
    assert.equal(await readFile(join(f.root, "result.txt"), "utf8"), "ready");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("frozen review rejects unsafe inputs and stale or self-reported results and rolls back failed persistence", async (t) => {
  const f = await fixture();
  try {
    const base = f.request("guarded");
    for (const patch of [{ candidate_id: "../bad" }, { relative_paths: [] }, { relative_paths: Array(101).fill("result.txt") }, { relative_paths: ["result.txt", "result.txt"] }, { relative_paths: ["../outside"] }, { relative_paths: [f.root] }, { relative_paths: ["."] }, { task_run_version: "1" }, { launch_version: 999 }, { host_run_version: 999 }, { plan_version: 999 }, { criterion_id: "bytes" }]) assert.throws(() => f.service.workReviewFreeze({ ...base, ...patch }));
    await mkdir(join(f.root, "directory"));
    // A directory link works everywhere (a junction on an unprivileged Windows);
    // a real file symlink needs SeCreateSymbolicLinkPrivilege, so only assert it
    // where the machine can actually create one.
    await linkDirectory(f.root, join(f.root, "linked-dir"));
    const linkedPaths = ["directory", "linked-dir/result.txt"];
    if (supportsFileSymlinks()) {
      const { symlink: realSymlink } = await import("node:fs/promises");
      await realSymlink(join(f.root, "result.txt"), join(f.root, "linked"));
      linkedPaths.push("linked");
    }
    for (const path of linkedPaths) assert.throws(() => f.service.workReviewFreeze({ ...base, relative_paths: [path] }));
    await writeFile(join(f.root, "huge"), Buffer.alloc(10 * 1024 * 1024 + 1));
    assert.throws(() => f.service.workReviewFreeze({ ...base, relative_paths: ["huge"] }), /limit/);
    const originalStat = fs.fstatSync;
    const grew = t.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => ({ ...originalStat(...args), size: 0, isFile: () => true }) as ReturnType<typeof fs.fstatSync>);
    syncBuiltinESMExports();
    assert.throws(() => f.service.workReviewFreeze({ ...base, relative_paths: ["huge"] }), /grew/);
    grew.mock.restore(); syncBuiltinESMExports();
    for (const patch of [{ kind: "task_run", values: { lifecycle: "paused" } }, { kind: "host_run", values: { status: "failed" } }, { kind: "host_run", values: { cleanup_unconfirmed: true } }]) {
      const get = f.store.get.bind(f.store);
      const invalid = t.mock.method(f.store, "get", (...args: Parameters<typeof f.store.get>) => args[0] === patch.kind ? { ...get(...args), ...patch.values } : get(...args));
      assert.throws(() => f.service.workReviewFreeze(base), /Only completed/); invalid.mock.restore();
    }
    for (const patch of [{ status: "revoked" }, { version: 999 }]) {
      const get = f.store.get.bind(f.store);
      const invalid = t.mock.method(f.store, "get", (...args: Parameters<typeof f.store.get>) => args[0] === "task_control_contract" ? { ...get(...args), ...patch } : get(...args));
      assert.throws(() => f.service.workReviewFreeze(base), /contract changed/); invalid.mock.restore();
    }
    const beforePlan = f.store.get("acceptance_plan", String(f.launch.acceptance_plan_id));
    const originalAppend = f.store.appendEvent.bind(f.store);
    const fault = t.mock.method(f.store, "appendEvent", (...args: Parameters<typeof f.store.appendEvent>) => { const result = originalAppend(...args); if (args[1] === "work.review_frozen") throw new Error("simulated freeze write failure"); return result; });
    assert.throws(() => f.service.workReviewFreeze(base), /write failure/); fault.mock.restore();
    assert.deepEqual(f.store.get("acceptance_plan", String(beforePlan.id)), beforePlan);
    assert.equal(f.store.list("work_review_file", 100).length, 0);
    assert.equal(f.store.list("work_review_candidate", 100).length, 0);
    const candidate = f.service.workReviewFreeze(base).candidate as JsonObject;
    for (const patch of [{ candidate_version: 999 }, { result: "unknown" }, { findings: null }, { findings: Array(101).fill({}) }, { findings: [{ severity: "unknown", path: "result.txt", message: "x" }] }, { findings: [{ severity: "suggestion", path: "other", message: "x" }] }, { findings: [{ severity: "suggestion", path: "result.txt", message: "x".repeat(4001) }] }, { result: "failed" }, { findings: [{ severity: "blocker", path: "result.txt", message: "blocking" }] }, { summary: "x".repeat(8001) }]) assert.throws(() => f.service.workReviewReport({ ...f.report(candidate), ...patch }));
    assert.throws(() => f.service.workReviewGet({ candidate_id: candidate.id, relative_path: "outside" }), /not part/);
    const originalGet = f.store.get.bind(f.store);
    const corrupt = t.mock.method(f.store, "get", (...args: Parameters<typeof f.store.get>) => args[0] === "work_review_file" ? { ...originalGet(...args), content_base64: "corrupt" } : originalGet(...args));
    assert.throws(() => f.service.workReviewGet({ candidate_id: candidate.id, relative_path: "result.txt" }), /integrity/); corrupt.mock.restore();
    const staleContract = t.mock.method(f.store, "get", (...args: Parameters<typeof f.store.get>) => args[0] === "task_control_contract" ? { ...originalGet(...args), version: 999 } : originalGet(...args));
    assert.throws(() => f.service.workReviewReport(f.report(candidate)), /stale/); staleContract.mock.restore();
    const brokenReport = t.mock.method(f.store, "appendEvent", (...args: Parameters<typeof f.store.appendEvent>) => { const result = originalAppend(...args); if (args[1] === "work.review_reported") throw new Error("simulated report failure"); return result; });
    assert.throws(() => f.service.workReviewReport(f.report(candidate)), /report failure/); brokenReport.mock.restore();
    assert.equal(f.store.find("work_review_report", `work_review_report_${candidate.id}`), null);
    const assignment = f.store.create("task_assignment", `task_assignment_${f.task.id}`, { status: "active", owner: "reviewer" });
    assert.throws(() => f.service.workReviewReport(f.report(candidate)), /Current task owner/);
    f.store.save("task_assignment", String(assignment.id), { ...assignment, status: "released" });
    f.service.workReviewReport(f.report(candidate, "blocked"));
    await runBuiltinAcceptanceTicks(f.service);
    const next = f.service.workReviewFreeze(f.request("stale-candidate")).candidate as JsonObject;
    const task = f.store.get("task", String(f.task.id)); f.store.save("task", String(task.id), { ...task, goal: "updated" });
    assert.throws(() => f.service.workReviewReport(f.report(next)), /stale/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("worker rework inherits frozen review requirements and cannot lower pinned acceptance", async () => {
  const f = await fixture();
  try {
    const candidate = f.service.workReviewFreeze(f.request("before-rework")).candidate as JsonObject;
    f.service.workReviewReport(f.report(candidate, "failed", [{ severity: "blocker", path: "result.txt", message: "Provide supporting notes for the result" }]));
    await runBuiltinAcceptanceTicks(f.service);
    const source = f.store.get("task_run", "review-source"), launch = f.store.get("work_launch", String(f.launch.id));
    assert.throws(() => f.service.workLaunchPrepare({ task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "drop review", retry_of: launch.id, acceptance_criteria: [] }), /pinned acceptance/);
    const next = f.service.taskRunRetry({ task_run_id: source.id, task_run_version: source.version, launch_version: launch.version, host_run_version: f.store.get("host_run", String(launch.run_id)).version, new_task_run_id: "review-rework", prompt: "add supporting notes", actor: "worker" }).launch as JsonObject;
    f.service.codexHost.executor = async () => { await writeFile(join(f.root, "notes.txt"), "Verified supporting notes"); return { exitCode: 0, signal: null, stdout: JSON.stringify({ type: "turn.completed", usage: {} }) + "\n", stderr: "", timedOut: false, cancelled: false, outputLimited: false }; };
    const started = f.service.workLaunchDecide({ launch_id: next.id, actor: "worker", approved: true, prompt: "add supporting notes" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(started.run_id)); await runBuiltinAcceptanceTicks(f.service);
    const plan = f.store.get("acceptance_plan", String(next.acceptance_plan_id));
    assert.throws(() => f.service.acceptanceHumanReview({ plan_id: plan.id, plan_version: plan.version, criterion_id: "review", reviewer: "reviewer", result: "passed", summary: "Skip new frozen review" }), /frozen review report/);
    const fresh = f.service.workReviewFreeze({ candidate_id: "after-rework", task_run_id: "review-rework", task_run_version: f.store.get("task_run", "review-rework").version, launch_version: f.store.get("work_launch", String(next.id)).version, host_run_version: f.store.get("host_run", String(started.run_id)).version, plan_version: plan.version, actor: "worker", criterion_id: "review", relative_paths: ["result.txt", "notes.txt"] }).candidate as JsonObject;
    f.service.workReviewReport(f.report(fresh)); await runBuiltinAcceptanceTicks(f.service);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "review-rework" }).state as JsonObject).action, "deliver");
    assert.equal((f.service.workReviewGet({ candidate_id: candidate.id }).report as JsonObject).result, "failed");
    assert.equal((fresh.files as JsonObject[]).length, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
