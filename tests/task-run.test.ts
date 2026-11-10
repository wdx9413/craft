import assert from "node:assert/strict";
import { HostProcessCleanupError } from "../core/host-driver.ts";
import { createHash } from "node:crypto";
import { runBuiltinAcceptanceTicks } from "../core/acceptance-worker.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertCurrentReleaseVersion } from "./release-version.ts";
import { McpServer } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService, VERSION } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { GenericCliHostKernel } from "../core/generic-driver.ts";
import { defineHostProfile } from "../core/host-registry.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-task-run-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` });
  const task = service.taskOpen({ title: "Run", goal: "Complete one controlled task" }).task as JsonObject;
  return { root, store, service, task };
}

function contract(f: Awaited<ReturnType<typeof fixture>>, id: string, effect = "read_only", acceptance = false): JsonObject {
  return f.service.taskControlSave({ contract_id: id, task_id: f.task.id, workspace: f.root, allowed_effects: [effect], acceptance_required: acceptance }).contract as JsonObject;
}

for (const artifactKind of ["file", "coverage", "media"] as const) test(`${artifactKind} delivery reassessment follows manual edits while keeping every historical outcome`, async () => {
  const success = artifactKind === "file" ? "ready" : artifactKind === "coverage" ? JSON.stringify({ total: { lines: { pct: 100 }, branches: { pct: 100 }, functions: { pct: 100 }, statements: { pct: 100 } } }) : JSON.stringify({ streams: [{ codec_type: "video", width: 1920, height: 1080 }], format: { duration: "10" } });
  const damaged = artifactKind === "file" ? "manual edit" : artifactKind === "coverage" ? success.replaceAll("100", "50") : success.replace("1920", "320");
  const relativePath = artifactKind === "file" ? "result.txt" : "report.json";
  const f = await fixture();
  try {
    f.service.codexHost.executor = async () => {
      await writeFile(join(f.root, relativePath), success);
      return { exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` };
    };
    const control = contract(f, "file-delivery", "local_write", true);
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "file-run", host: "codex-cli", prompt: "produce result", sandbox: "workspace-write", acceptance_criteria: [{ id: "file", name: "Exact file", method: "program", required: true }] });
    const launchId = (prepared.launch as JsonObject).id;
    const beforePause = f.store.get("task_run", "file-run");
    const lifecycleWeb = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173");
    const pausedResponse = lifecycleWeb.handle({ token: "token", method: "POST", path: "/api/task-runs/file-run/pause", origin: "http://127.0.0.1:4173", body: JSON.stringify({ task_run_version: beforePause.version, reason: "review scope before production" }) });
    assert.equal(pausedResponse.status, 200);
    const pausedRun = f.store.get("task_run", "file-run");
    const pauseSnapshot = f.service.taskRunHandoff({ task_run_id: pausedRun.id, task_run_version: pausedRun.version, reason: "continue from approved scope" }).handoff as JsonObject;
    assert.equal(pauseSnapshot.state_status, "paused");
    assert.equal(pauseSnapshot.resume_action, "resume_or_handoff");
    assert.equal(f.store.list("host_run", 10).length, 0);
    await new McpServer(f.service, "full").handlers.craft_task_run_resume({ task_run_id: pausedRun.id, task_run_version: pausedRun.version });
    assert.equal(f.store.list("host_run", 10).length, 0);
    f.service.workLaunchDecide({ launch_id: launchId, actor: "user", approved: true, prompt: "produce result" });
    const launch = f.service.workLaunchGet({ launch_id: launchId }).launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const history: JsonObject[] = [];
    for (const [index, content] of [success, damaged, success].entries()) {
      if (index > 0) await writeFile(join(f.root, relativePath), content);
      if (index === 0) {
        const input = { job_id: "artifact-round-0", plan_id: launch.acceptance_plan_id, criterion_id: "file", workspace: f.root, relative_path: relativePath };
        if (artifactKind === "file") f.service.acceptanceFileEvaluationPrepare({ ...input, expected_sha256: createHash("sha256").update(success).digest("hex") });
        else if (artifactKind === "coverage") f.service.acceptanceCoverageEvaluationPrepare({ ...input, lines_threshold: 100, branches_threshold: 100, functions_threshold: 100, statements_threshold: 100 });
        else f.service.acceptanceMediaProbePrepare({ ...input, min_width: 1920, min_height: 1080, min_duration_seconds: 10 });
      }
      else {
        const plan = f.store.get("acceptance_plan", String(launch.acceptance_plan_id));
        const args = { plan_id: plan.id, plan_version: plan.version };
        const result = index === 1
          ? new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173").handle({ token: "token", method: "POST", path: `/api/acceptance-plans/${plan.id}/recheck`, origin: "http://127.0.0.1:4173", body: JSON.stringify(args) })
          : await new McpServer(f.service, "full").handlers.craft_acceptance_recheck(args);
        if (index === 1) assert.equal((result as { status: number }).status, 201);
        assert.throws(() => f.service.acceptanceRecheck(args), /version changed/u);
        const waiting = f.service.acceptancePlanGet({ plan_id: plan.id });
        assert.equal((waiting.assessment as JsonObject).status, "pending");
        assert.equal(waiting.outcome, null);
        assert.equal((f.service.taskRunRefresh({ task_run_id: "file-run" }).state as JsonObject).action, "collect_acceptance");
      }
      await runBuiltinAcceptanceTicks(f.service);
      const current = f.service.acceptancePlanGet({ plan_id: launch.acceptance_plan_id });
      const outcome = current.outcome as JsonObject;
      const completed = f.store.list("acceptance_evaluation_job", 100, job => job.plan_id === launch.acceptance_plan_id && job.plan_version === (current.plan as JsonObject).version)[0];
      const receipt = completed.receipt as JsonObject;
      const observed = (current.evaluations as JsonObject[]).find(item => item.id === completed.id)!;
      assert.deepEqual(observed.receipt, receipt);
      const homePlan = (f.service.homeTask({ task_id: f.task.id }).acceptance_plans as JsonObject[])[0];
      assert.equal((homePlan.receipts as JsonObject[]).length, 1);
      assert.equal((homePlan.receipts as JsonObject[])[0].job_id, completed.id);
      assert.equal(artifactKind === "file" ? receipt.sha256 : receipt.source_sha256, createHash("sha256").update(content).digest("hex"));
      assert.equal(artifactKind === "file" ? receipt.size_bytes : receipt.source_bytes, Buffer.byteLength(content));
      const verdict = index === 1 ? "failed" : "passed";
      assert.equal(outcome.verdict, verdict);
      assert.equal((current.assessment as JsonObject).outcome_id, outcome.id);
      assert.equal((f.service.taskRunRefresh({ task_run_id: "file-run" }).state as JsonObject).action, index === 1 ? "retry_or_handoff" : "deliver");
      assert.equal((f.service.acceptanceAssess({ plan_id: launch.acceptance_plan_id }).outcome as JsonObject).id, outcome.id);
      for (const historical of history) assert.deepEqual(f.store.get("outcome", String(historical.id)), historical);
      assert.ok(!history.some(item => item.id === outcome.id));
      history.push(outcome);
    }
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("unconfirmed process cleanup blocks delivery and retry until explicit recovery", async () => {
  const f = await fixture();
  try {
    f.service.codexHost.executor = async () => { throw new HostProcessCleanupError(new Error("simulated platform failure")); };
    const control = contract(f, "cleanup");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "cleanup-run", host: "codex-cli", prompt: "inspect", sandbox: "read-only" });
    const launch = prepared.launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const host = f.store.get("host_run", String(launch.run_id));
    assert.equal(host.status, "interrupted");
    assert.equal(host.cleanup_unconfirmed, true);
    await assert.rejects(f.service.codexHost.execute({ dispatch_id: launch.dispatch_id, prompt: "inspect", resume: true }), /cleanup could not be confirmed/u);
    assert.equal((f.service.homeTask({ task_id: f.task.id }).host_runs as JsonObject[])[0].cleanup_unconfirmed, true);
    const state = f.service.taskRunRefresh({ task_run_id: "cleanup-run" }).state as JsonObject;
    assert.deepEqual([state.status, state.action], ["result_unknown", "human_handoff"]);
    assert.throws(() => f.service.workLaunchRetry({ launch_id: launch.id, prompt: "inspect" }), /cleanup must be confirmed/u);
    assert.throws(() => f.service.hostRunRecover({ owner_id: host.owner_id }), /confirmed_original_runner_stopped/u);
    assert.equal(f.service.hostRunRecover({ owner_id: "another-owner", confirmed_original_runner_stopped: true }).count, 0);
    assert.equal(f.service.hostRunRecover({ owner_id: host.owner_id, confirmed_original_runner_stopped: true }).count, 1);
    assert.equal(f.store.get("host_run", String(host.id)).cleanup_unconfirmed, false);
    assert.equal(f.store.get("codex_dispatch", String(launch.dispatch_id)).cleanup_unconfirmed, false);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "cleanup-run" }).state as JsonObject).action, "retry_or_handoff");
    f.service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, stderr: "", timedOut: false, outputLimited: false });
    const retried = f.service.workLaunchRetry({ launch_id: launch.id, prompt: "inspect" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(retried.run_id));
    assert.equal(f.store.get("host_run", String(retried.run_id)).status, "completed");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("HTTP and MCP recover only the selected stopped run at its current version", async () => {
  const f = await fixture();
  try {
    f.service.codexHost.executor = async () => { throw new HostProcessCleanupError(new Error("simulated cleanup failure")); };
    const runs: JsonObject[] = [];
    for (let index = 0; index < 2; index++) {
      const control = contract(f, `scoped-${index}`);
      const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: `scoped-run-${index}`, host: "codex-cli", prompt: "inspect", sandbox: "read-only" });
      const launch = prepared.launch as JsonObject;
      await f.service.hostRuns.wait(String(launch.run_id));
      runs.push(f.store.get("host_run", String(launch.run_id)));
    }
    const [first, second] = runs;
    const confirmation = { run_id: first.id, run_version: first.version, actor: "user:owner", confirmed_original_runner_stopped: true };
    assert.throws(() => f.service.hostRunRecover({ ...confirmation, actor: undefined }), /actor/u);
    assert.throws(() => f.service.hostRunRecover({ owner_id: first.owner_id, run_version: first.version, confirmed_original_runner_stopped: true }), /requires run_id/u);
    assert.throws(() => f.service.hostRunRecover({ ...confirmation, owner_id: "wrong" }), /owner does not match/u);
    assert.throws(() => f.service.hostRuns.recover({ ...confirmation, owner_id: "wrong" }), /owner does not match/u);
    for (const run_version of [undefined, 0, "1", Number(first.version) - 1]) assert.throws(() => f.service.hostRunRecover({ ...confirmation, run_version }), /version changed/u);
    const app = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173");
    const post = (body: JsonObject) => app.handle({ method: "POST", path: `/api/host-runs/${first.id}/recover`, token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify(body) });
    assert.equal(post({ ...confirmation, confirmed_original_runner_stopped: false }).status, 422);
    const recovered = post({ ...confirmation, run_id: second.id });
    assert.equal(recovered.status, 200);
    assert.equal(f.store.get("host_run", String(first.id)).cleanup_unconfirmed, false);
    assert.equal((f.store.get("host_run", String(first.id)).stopped_confirmation as JsonObject).actor, "user:owner");
    assert.deepEqual(f.store.get("host_run", String(second.id)), second);
    assert.equal(post(confirmation).status, 422);
    const mcp = new McpServer(f.service, "full");
    const result = await mcp.handlers.craft_host_run_recover({ run_id: second.id, run_version: second.version, actor: "user:owner", confirmed_original_runner_stopped: true }) as JsonObject;
    assert.equal(result.count, 1);
    assert.equal(f.store.get("host_run", String(second.id)).cleanup_unconfirmed, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a scoped recovery cannot confirm a locally active Runner stopped", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const waiting = new Promise<void>(resolve => { release = resolve; });
    f.service.codexHost.executor = async () => { await waiting; return { exitCode: 0, signal: null, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, stderr: "", timedOut: false, outputLimited: false }; };
    const control = contract(f, "active-recovery");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "active-recovery-run", host: "codex-cli", prompt: "inspect", sandbox: "read-only" });
    const launch = prepared.launch as JsonObject;
    const host = f.store.get("host_run", String(launch.run_id));
    assert.throws(() => f.service.hostRunRecover({ run_id: host.id, run_version: host.version, actor: "user:owner", confirmed_original_runner_stopped: true }), /still active/u);
    assert.deepEqual(f.store.get("host_run", String(host.id)), host);
    release(); await f.service.hostRuns.wait(String(host.id));
    const completed = f.store.get("host_run", String(host.id));
    assert.equal(f.service.hostRunRecover({ run_id: host.id, run_version: completed.version, actor: "user:owner", confirmed_original_runner_stopped: true }).count, 0);
  } finally { release?.(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("task retry creates one fresh read-only attempt through HTTP and replays it through MCP", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.service.codexHost.executor = async () => ({ exitCode: ++calls === 1 ? 1 : 0, signal: null, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, stderr: "", timedOut: false, outputLimited: false });
    const control = contract(f, "retry-source");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "retry-source", host: "codex-cli", prompt: "first try", timeout_ms: 2000, output_limit: 4096 });
    let launch = prepared.launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const source = f.store.get("task_run", "retry-source"); launch = f.store.get("work_launch", String(launch.id));
    const host = f.store.get("host_run", String(launch.run_id));
    const args = { task_run_id: source.id, task_run_version: source.version, launch_version: launch.version, host_run_version: host.version, new_task_run_id: "retry-fresh", prompt: "second try", actor: "user:owner" };
    const app = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173");
    const response = app.handle({ method: "POST", path: `/api/task-runs/${source.id}/retry`, token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify(args) });
    assert.equal(response.status, 201);
    const result = JSON.parse(String(response.body)) as JsonObject;
    const next = result.launch as JsonObject;
    await f.service.hostRuns.wait(String(next.run_id));
    assert.equal(next.retry_of, launch.id);
    assert.equal((f.service.homeTask({ task_id: f.task.id }).task_retries as JsonObject[])[0].new_task_run_id, "retry-fresh");
    assert.throws(() => f.service.workLaunchPrepare({ task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "unsupported limits", limits: { max_steps: 1 } }), /only by the internal Host/u);
    assert.equal((result.task_run as JsonObject).id, "retry-fresh");
    const dispatch = f.store.get("codex_dispatch", String(next.dispatch_id));
    assert.deepEqual([dispatch.timeout_ms, dispatch.output_limit], [2000, 4096]);
    assert.equal(dispatch.max_turns, f.store.get("codex_dispatch", String(launch.dispatch_id)).max_turns);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "retry-fresh" }).state as JsonObject).action, "deliver");
    assert.deepEqual(f.store.get("task_run", String(source.id)), source);
    assert.deepEqual(f.store.get("work_launch", String(launch.id)), launch);
    assert.deepEqual(f.store.get("host_run", String(host.id)), host);
    const replay = await new McpServer(f.service, "full").handlers.craft_task_run_retry(args) as JsonObject;
    assert.equal(replay.idempotent, true);
    assert.equal(calls, 2);
    assert.throws(() => f.service.taskRunRetry({ ...args, new_task_run_id: "duplicate-successor" }), /already has a retry/u);
    assert.throws(() => f.service.taskRunRetry({ ...args, prompt: "different" }), /idempotency conflict/u);
    assert.throws(() => f.service.taskRunRetry({ ...args, new_task_run_id: "stale-retry", host_run_version: Number(host.version) - 1 }), /source changed/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("task retry retains write scope and requires fresh approval before another model call", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.service.codexHost.executor = async () => ({ exitCode: ++calls === 1 ? 1 : 0, signal: null, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, stderr: "", timedOut: false, outputLimited: false });
    const control = contract(f, "retry-write", "local_write");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "retry-write", host: "codex-cli", prompt: "first write", sandbox: "workspace-write" });
    const started = f.service.workLaunchDecide({ launch_id: (prepared.launch as JsonObject).id, actor: "user:owner", approved: true, prompt: "first write" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(started.run_id));
    const source = f.store.get("task_run", "retry-write"); const launch = f.store.get("work_launch", String(started.id)); const host = f.store.get("host_run", String(launch.run_id));
    const result = f.service.taskRunRetry({ task_run_id: source.id, task_run_version: source.version, launch_version: launch.version, host_run_version: host.version, new_task_run_id: "retry-write-fresh", prompt: "second write", actor: "user:owner" });
    const next = result.launch as JsonObject;
    assert.equal(next.status, "awaiting_approval"); assert.equal(next.run_id, undefined); assert.equal(calls, 1);
    assert.equal(next.authorization_request_id, undefined);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "retry-write-fresh" }).state as JsonObject).status, "awaiting_approval");
    const approved = f.service.workLaunchDecide({ launch_id: next.id, actor: "user:owner", approved: true, prompt: "second write" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(approved.run_id));
    assert.equal(calls, 2);
    assert.notEqual(approved.authorization_request_id, launch.authorization_request_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

for (const changed of ["host", "launch", "acceptance"] as const) {
  test(`Task Run rejects a stale delivery projection after ${changed} facts change`, async () => {
    const f = await fixture();
    try {
      const control = contract(f, "stale", "local_write", true);
      const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "stale-run", host: "codex-cli",
        workspace: f.root, prompt: "edit", sandbox: "workspace-write", acceptance_name: "review",
        acceptance_criteria: [{ id: "human", name: "Human", method: "human", required: true }] });
      const launchId = String((prepared.launch as JsonObject).id);
      f.service.workLaunchDecide({ launch_id: launchId, actor: "user", approved: true, prompt: "edit" });
      const launch = f.service.workLaunchGet({ launch_id: launchId }).launch as JsonObject;
      await f.service.hostRuns.wait(String(launch.run_id));
      f.service.acceptanceHumanReview({ plan_id: launch.acceptance_plan_id, criterion_id: "human", reviewer: "user", result: "passed", summary: "checked" });
      assert.equal((f.service.taskRunRefresh({ task_run_id: "stale-run" }).state as JsonObject).action, "deliver");
      const loopId = `delivery_loop_${launchId}`;
      const oldLoop = f.store.get("delivery_loop", loopId);
      const oldDelivery = f.store.get("work_delivery", String(oldLoop.delivery_id));
      const kind = changed === "host" ? "host_run" : changed === "launch" ? "work_launch" : "acceptance_assessment";
      const id = changed === "host" ? String(launch.run_id) : changed === "launch" ? launchId : `assessment_${launch.acceptance_plan_id}`;
      const previous = f.store.get(kind, id);
      f.store.save(kind, id, { ...previous, status: changed === "launch" ? previous.status : "failed" });
      const state = f.service.taskRunRefresh({ task_run_id: "stale-run" }).state as JsonObject;
      assert.deepEqual([state.status, state.action], ["blocked", "human_handoff"]);
      const handoff = f.service.taskRunHandoff({ task_run_id: "stale-run", reason: "stale_projection" }).handoff as JsonObject;
      assert.equal(handoff.resume_action, "human_handoff");
      assert.deepEqual(f.store.get("delivery_loop", loopId), oldLoop, "reading stale guidance must not silently rewrite its evidence");
      f.service.deliveryLoopRefresh({ launch_id: launchId });
      assert.notEqual(f.store.get("delivery_loop", loopId).delivery_id, oldDelivery.id);
      assert.deepEqual(f.store.get("work_delivery", String(oldDelivery.id)), oldDelivery);
      assert.equal((f.service.taskRunRefresh({ task_run_id: "stale-run" }).state as JsonObject).action,
        changed === "launch" ? "deliver" : "retry_or_handoff");
    } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
  });
}

test("Task Run rejects missing or foreign delivery pins even when versions happen to match", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "pins");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "pin-run", host: "codex-cli",
      workspace: f.root, prompt: "read", sandbox: "read-only" });
    const launch = prepared.launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const id = `delivery_loop_${launch.id}`; const valid = f.store.get("delivery_loop", id);
    for (const patch of [{ launch_id: "foreign" }, { run_id: "foreign" }, { assessment_id: "foreign" },
      { launch_version: null }, { run_version: null }, { assessment_version: 1 }]) {
      f.store.save("delivery_loop", id, { ...valid, ...patch });
      assert.equal((f.service.taskRunRefresh({ task_run_id: "pin-run" }).state as JsonObject).action, "human_handoff");
    }
    f.store.save("delivery_loop", id, valid);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "pin-run" }).state as JsonObject).action, "deliver");
    assert.equal(f.service.taskRunRefresh({ task_run_id: "pin-run" }).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Task Run binds a real read-only launch, persists only digests, and safely pauses, resumes, hands off, and cancels", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "read");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "read-run", host: "codex-cli", workspace: f.root, prompt: "inspect private business data", sandbox: "read-only", environment: { image: "same" }, budget: { usd: 1 } });
    const taskRun = prepared.task_run as JsonObject; const launch = prepared.launch as JsonObject; assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).action, "wait_for_host"); await f.service.hostRuns.wait(String(launch.run_id));
    assert.equal(f.service.taskRuns.create({ task_run_id: taskRun.id, contract_id: control.id, launch_id: launch.id, environment: { image: "same" }, budget: { usd: 1 } }).idempotent, true);
    assert.equal((f.service.taskRunGet({ task_run_id: taskRun.id }).run as JsonObject).id, taskRun.id);
    const ready = f.service.taskRunRefresh({ task_run_id: taskRun.id, environment: { image: "same" }, budget: { usd: 1 } }).state as JsonObject;
    assert.deepEqual([ready.status, ready.action], ["ready_for_delivery", "deliver"]); assert.equal(JSON.stringify(taskRun).includes("private business data"), false);
    const paused = f.service.taskRunPause({ task_run_id: taskRun.id, reason: "user" }).run as JsonObject; assert.equal(paused.lifecycle, "paused"); assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).action, "resume_or_handoff");
    assert.equal(f.service.taskRunPause({ task_run_id: taskRun.id, reason: "user" }).idempotent, true);
    assert.equal(f.service.taskRunResume({ task_run_id: taskRun.id, environment: { image: "same" }, budget: { usd: 1 } }).idempotent, false);
    assert.equal(f.service.taskRunResume({ task_run_id: taskRun.id }).idempotent, true);
    const handoff = f.service.taskRunHandoff({ task_run_id: taskRun.id, handoff_id: "handoff", reason: "review" }).handoff as JsonObject; assert.equal(handoff.resume_action, "deliver");
    const host = f.store.get("host_run", String(launch.run_id)); assert.deepEqual(handoff.host_run_ref, { id: host.id, version: host.version });
    assert.equal(f.service.taskRunHandoff({ task_run_id: taskRun.id, handoff_id: "handoff", reason: "review" }).idempotent, true); assert.throws(() => f.service.taskRunHandoff({ task_run_id: taskRun.id, handoff_id: "handoff", reason: "different" }), /conflict/);
    assert.equal(JSON.stringify(handoff).includes("private business data"), false);
    assert.equal((f.service.taskRunCancel({ task_run_id: taskRun.id, reason: "done" }).run as JsonObject).lifecycle, "cancelled"); assert.equal(f.service.taskRunCancel({ task_run_id: taskRun.id, reason: "done" }).idempotent, true);
    assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).status, "cancelled_with_host_result"); assert.throws(() => f.service.taskRunPause({ task_run_id: taskRun.id, reason: "again" }), /Cancelled/); assert.throws(() => f.service.taskRunResume({ task_run_id: taskRun.id }), /Cancelled/);
    assert.throws(() => f.service.taskRunGet({ task_run_id: "" }), /task_run_id/);
    assertCurrentReleaseVersion(VERSION);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("paused or cancelled Task Runs cannot start their pending Work Launch", async () => {
  const f = await fixture();
  try {
    let executions = 0;
    f.service.codexHost.executor = async () => {
      executions++;
      return { exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false,
        stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` };
    };
    const control = contract(f, "pending-pause", "local_write");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "pending-pause-run", host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" });
    const launch = prepared.launch as JsonObject;
    f.service.taskRunPause({ task_run_id: "pending-pause-run", reason: "user" });
    assert.throws(() => f.service.workLaunchDecide({ launch_id: launch.id, actor: "user", approved: true, prompt: "edit" }), /Paused or cancelled/u);
    assert.equal(executions, 0);
    assert.equal(f.store.get("work_launch", String(launch.id)).status, "awaiting_approval");
    f.service.taskRunResume({ task_run_id: "pending-pause-run" });
    const started = f.service.workLaunchDecide({ launch_id: launch.id, actor: "user", approved: true, prompt: "edit" });
    await f.service.hostRuns.wait(String((started.launch as JsonObject).run_id));
    assert.equal(executions, 1);

    const cancelledControl = contract(f, "pending-cancel", "local_write");
    const cancelled = f.service.taskRunPrepare({ contract_id: cancelledControl.id, task_run_id: "pending-cancel-run", host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" });
    const cancelledLaunch = cancelled.launch as JsonObject;
    f.service.taskRunCancel({ task_run_id: "pending-cancel-run", reason: "user" });
    assert.throws(() => f.service.workLaunchDecide({ launch_id: cancelledLaunch.id, actor: "user", approved: true, prompt: "edit" }), /Paused or cancelled/u);
    assert.equal(executions, 1);
    assert.equal(f.service.workLaunchDecide({ launch_id: cancelledLaunch.id, actor: "user", approved: false }).started, false);

    const standalone = f.service.workLaunchPrepare({ task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "independent", sandbox: "workspace-write" });
    const independent = f.service.workLaunchDecide({ launch_id: (standalone.launch as JsonObject).id, actor: "user", approved: true, prompt: "independent" });
    await f.service.hostRuns.wait(String((independent.launch as JsonObject).run_id));
    assert.equal(executions, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("another service can persist and deliver cancellation to the owning Host", async () => {
  const f = await fixture();
  const otherStore = await new CraftStore(craftPaths(f.root)).open();
  try {
    let aborted = false;
    f.service.codexHost.executor = (request) => new Promise(resolve => {
      request.signal?.addEventListener("abort", () => { aborted = true; resolve({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false }); }, { once: true });
    });
    const control = contract(f, "cross-process");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "cross-process-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only" });
    const hostId = String((prepared.launch as JsonObject).run_id);
    const find = f.store.find.bind(f.store);
    let transientFailure = true;
    f.store.find = (kind, id) => {
      if (kind === "host_run" && id === hostId && transientFailure) { transientFailure = false; throw new Error("temporary store read failure"); }
      return find(kind, id);
    };
    const other = new CraftService(otherStore);
    const cancelled = other.taskRunCancel({ task_run_id: "cross-process-run", reason: "user" });
    assert.equal((cancelled.run as JsonObject).lifecycle, "cancelled");
    assert.equal(((cancelled.host_cancellation as JsonObject).run as JsonObject).cancel_requested, true);
    assert.equal(otherStore.get("host_run", hostId).status, "running");
    await Promise.race([f.service.hostRuns.wait(hostId), new Promise((_, reject) => setTimeout(() => reject(new Error("cancellation was not delivered")), 3000))]);
    assert.equal(aborted, true);
    assert.equal(transientFailure, false);
    assert.equal(f.store.get("host_run", hostId).status, "cancelled");
  } finally { otherStore.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("failure to persist a Host cancellation rolls back the task cancellation", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "cancel-atomic", "local_write");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "cancel-atomic-run", host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" });
    const launch = prepared.launch as JsonObject;
    f.store.create("host_run", "cancel-atomic-host", { status: "running" });
    f.store.save("work_launch", String(launch.id), { ...launch, run_id: "cancel-atomic-host" });
    f.service.hostRunCancel = () => { throw new Error("host cancellation persistence failed"); };
    assert.throws(() => f.service.taskRunCancel({ task_run_id: "cancel-atomic-run", reason: "user" }), /host cancellation persistence failed/u);
    assert.equal(f.store.get("task_run", "cancel-atomic-run").lifecycle, "active");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("pause persists a Host stop request across services and keeps the task paused", async () => {
  const f = await fixture();
  const otherStore = await new CraftStore(craftPaths(f.root)).open();
  try {
    let aborted = false;
    f.service.codexHost.executor = request => new Promise(resolve => {
      request.signal?.addEventListener("abort", () => { aborted = true; resolve({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false }); }, { once: true });
    });
    const control = contract(f, "pause-running");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "pause-running-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only" });
    const hostId = String((prepared.launch as JsonObject).run_id);
    const other = new CraftService(otherStore);
    const paused = other.taskRunPause({ task_run_id: "pause-running-run", reason: "user" });
    assert.equal((paused.run as JsonObject).lifecycle, "paused");
    assert.equal(((paused.host_cancellation as JsonObject).run as JsonObject).cancel_requested, true);
    assert.equal(other.taskRunPause({ task_run_id: "pause-running-run", reason: "user" }).idempotent, true);
    await Promise.race([f.service.hostRuns.wait(hostId), new Promise((_, reject) => setTimeout(() => reject(new Error("pause stop was not delivered")), 3000))]);
    assert.equal(aborted, true);
    assert.equal(f.store.get("host_run", hostId).status, "cancelled");
    assert.equal((f.service.taskRunRefresh({ task_run_id: "pause-running-run" }).state as JsonObject).status, "paused");
    const resumed = f.service.taskRunResume({ task_run_id: "pause-running-run" });
    assert.notEqual((resumed.state as JsonObject).status, "running");
  } finally { otherStore.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("failure to persist a Host stop request rolls back task pause", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "pause-atomic", "local_write");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "pause-atomic-run", host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" });
    const launch = prepared.launch as JsonObject;
    f.store.save("work_launch", String(launch.id), { ...launch, run_id: "missing-host" });
    assert.throws(() => f.service.taskRunPause({ task_run_id: "pause-atomic-run", reason: "user" }), /host_run/u);
    assert.equal(f.store.get("task_run", "pause-atomic-run").lifecycle, "active");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("pause and cancellation serialize instead of restoring a stale active state", async () => {
  const f = await fixture();
  const otherStore = await new CraftStore(craftPaths(f.root)).open();
  try {
    otherStore.transaction(database => database.exec("PRAGMA busy_timeout=0"));
    const control = contract(f, "task-race", "local_write");
    f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "task-race-run", host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" });
    const other = new CraftService(otherStore);
    const get = f.store.get.bind(f.store);
    let collided = false;
    f.store.get = (kind, id, version) => {
      if (kind === "task_run" && id === "task-race-run" && !collided) {
        collided = true;
        assert.throws(() => other.taskRunCancel({ task_run_id: id, reason: "user" }), /busy|locked/u);
      }
      return get(kind, id, version);
    };
    f.service.taskRunPause({ task_run_id: "task-race-run", reason: "user" });
    f.store.get = get;
    assert.equal(collided, true);
    assert.equal((other.taskRunCancel({ task_run_id: "task-race-run", reason: "user" }).run as JsonObject).lifecycle, "cancelled");
    assert.throws(() => f.service.taskRunResume({ task_run_id: "task-race-run" }), /Cancelled/u);
    assert.equal(f.store.get("task_run", "task-race-run").lifecycle, "cancelled");
  } finally { otherStore.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

for (const action of ["pause", "cancel"] as const) {
  test(`${action} stops an admitted Host before the launch has recorded its run id`, async () => {
    const f = await fixture();
    const otherStore = await new CraftStore(craftPaths(f.root)).open();
    try {
      let aborted = false;
      f.service.codexHost.executor = request => new Promise(resolve => {
        request.signal?.addEventListener("abort", () => { aborted = true; resolve({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false }); }, { once: true });
      });
      const control = contract(f, `admission-${action}`);
      const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: `admission-run-${action}`, host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only", defer_host_start: true });
      const launch = prepared.launch as JsonObject;
      assert.equal(launch.run_id, undefined);
      otherStore.transaction(database => database.exec("PRAGMA busy_timeout=0"));
      const other = new CraftService(otherStore);
      const get = f.store.get.bind(f.store);
      let reads = 0;
      let collided = false;
      f.store.get = (kind, id, version) => {
        if (kind === "codex_dispatch" && id === launch.dispatch_id && ++reads === 2) {
          collided = true;
          assert.throws(() => action === "pause" ? other.taskRunPause({ task_run_id: `admission-run-${action}`, reason: "user" }) : other.taskRunCancel({ task_run_id: `admission-run-${action}`, reason: "user" }), /busy|locked/u);
        }
        return get(kind, id, version);
      };
      const host = f.service.hostRunStart({ host: "codex-cli", dispatch_id: launch.dispatch_id, prompt: "read" }).run as JsonObject;
      f.store.get = get;
      assert.equal(collided, true);
      const result = action === "pause" ? other.taskRunPause({ task_run_id: `admission-run-${action}`, reason: "user" }) : other.taskRunCancel({ task_run_id: `admission-run-${action}`, reason: "user" });
      assert.equal(((result.host_cancellations as JsonObject[])[0].run as JsonObject).cancel_requested, true);
      await Promise.race([f.service.hostRuns.wait(String(host.id)), new Promise((_, reject) => setTimeout(() => reject(new Error("stop was not delivered")), 3000))]);
      assert.equal(aborted, true);
      assert.equal(f.store.get("host_run", String(host.id)).status, "cancelled");
    } finally { otherStore.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
  });
}

test("Host registration refuses a dispatch after its task is paused", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "admission-paused");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "admission-paused-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only", defer_host_start: true });
    f.service.taskRunPause({ task_run_id: "admission-paused-run", reason: "user" });
    assert.throws(() => f.service.hostRunStart({ host: "codex-cli", dispatch_id: (prepared.launch as JsonObject).dispatch_id, prompt: "read" }), /Paused or cancelled/u);
    assert.equal(f.store.list("host_run", 100).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an unlinked Host run remains an explicit reconciliation state before and after completion", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "unlinked");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "unlinked-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only", defer_host_start: true });
    const launch = prepared.launch as JsonObject;
    f.store.create("host_run", "foreign", { host: "other", task_id: f.task.id, dispatch_id: launch.dispatch_id, status: "running" });
    assert.notEqual((f.service.taskRunRefresh({ task_run_id: "unlinked-run" }).state as JsonObject).status, "result_unknown");
    const host = f.service.hostRunStart({ run_id: "unlinked-host", host: "codex-cli", dispatch_id: launch.dispatch_id, prompt: "read" }).run as JsonObject;
    const running = f.service.taskRunRefresh({ task_run_id: "unlinked-run" }).state as JsonObject;
    assert.deepEqual([running.status, running.action, running.actor], ["result_unknown", "reconcile_host_run", "human"]);
    assert.deepEqual(running.unlinked_host_run_refs, [{ id: host.id, version: host.version }]);
    const handoff = f.service.taskRunHandoff({ task_run_id: "unlinked-run", reason: "recovery" }).handoff as JsonObject;
    assert.equal(handoff.resume_action, "reconcile_host_run");
    assert.deepEqual(handoff.unlinked_host_run_refs, running.unlinked_host_run_refs);
    assert.deepEqual((f.service.homeTask({ task_id: f.task.id }).task_handoffs as JsonObject[])[0].unlinked_host_run_refs, running.unlinked_host_run_refs);
    await f.service.hostRuns.wait(String(host.id));
    const completed = f.service.taskRunRefresh({ task_run_id: "unlinked-run" }).state as JsonObject;
    assert.equal(completed.status, "result_unknown");
    assert.notDeepEqual(completed.unlinked_host_run_refs, running.unlinked_host_run_refs);
    assert.equal(f.store.get("work_launch", String(launch.id)).run_id, undefined);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("cancelling when a linked Host record is missing preserves the unknown outcome", async () => {
  const f = await fixture();
  try {
    const prepared = f.service.taskRunPrepare({ contract_id: contract(f, "missing-host-cancel").id,
      task_run_id: "missing-host-run", host: "codex-cli", prompt: "read" });
    const launch = prepared.launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    f.store.remove("host_run", String(launch.run_id));
    const run = f.store.get("task_run", "missing-host-run");
    f.service.taskRunCancel({ task_run_id: run.id, task_run_version: run.version, reason: "stop", actor: "user" });
    const state = f.service.taskRunRefresh({ task_run_id: run.id }).state as JsonObject;
    assert.equal(state.status, "result_unknown"); assert.equal(state.missing_host_run_id, launch.run_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("completed external work survives restart as unknown until its exact receipt is reconciled", async () => {
  const f = await fixture();
  let restartedStore: CraftStore | undefined;
  try {
    let executions = 0;
    f.service.codexHost.executor = async () => {
      executions += 1;
      return { exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` };
    };
    const control = contract(f, "restart-reconcile");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "restart-reconcile-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only", defer_host_start: true });
    const launch = prepared.launch as JsonObject;
    const taskRun = prepared.task_run as JsonObject;
    const host = f.service.hostRunStart({ run_id: "restart-reconcile-host", host: "codex-cli", dispatch_id: launch.dispatch_id, prompt: "read" }).run as JsonObject;
    await f.service.hostRuns.wait(String(host.id));
    const completedHost = f.store.get("host_run", String(host.id));
    assert.equal(completedHost.status, "completed");
    assert.equal(f.store.get("work_launch", String(launch.id)).run_id, undefined);
    assert.equal(executions, 1);

    f.store.close();
    restartedStore = await new CraftStore(craftPaths(f.root)).open();
    const restarted = new CraftService(restartedStore);
    const unknown = restarted.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject;
    assert.deepEqual([unknown.status, unknown.action, unknown.actor], ["result_unknown", "reconcile_host_run", "human"]);
    assert.deepEqual(unknown.unlinked_host_run_refs, [{ id: host.id, version: completedHost.version }]);

    const currentTaskRun = restartedStore.get("task_run", String(taskRun.id));
    const currentLaunch = restartedStore.get("work_launch", String(launch.id));
    const linked = restarted.taskRunReconcileHost({ task_run_id: taskRun.id, host_run_id: host.id, task_run_version: currentTaskRun.version, launch_version: currentLaunch.version, host_run_version: completedHost.version, actor: "user" });
    assert.equal((linked.launch as JsonObject).run_id, host.id);
    assert.equal((restarted.taskRunReconcileHost({ task_run_id: taskRun.id, host_run_id: host.id, task_run_version: currentTaskRun.version, launch_version: (linked.launch as JsonObject).version, host_run_version: completedHost.version, actor: "user" })).idempotent, true);
    assert.equal(executions, 1);
    assert.throws(() => restarted.workLaunchRetry({ launch_id: launch.id, prompt: "retry" }), /Only a failed, cancelled, or interrupted launch can be retried/u);
    assert.equal(restartedStore.list("host_run", 10).length, 1);
  } finally {
    if (restartedStore) restartedStore.close();
    else f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("reconciliation links only a unique pinned terminal Host without executing it again", async () => {
  const f = await fixture();
  try {
    let executions = 0;
    f.service.codexHost.executor = async () => { executions++; return { exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` }; };
    const control = contract(f, "reconcile");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "reconcile-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only", defer_host_start: true });
    const launch = prepared.launch as JsonObject; const run = prepared.task_run as JsonObject;
    const host = f.service.hostRunStart({ run_id: "reconcile-host", host: "codex-cli", dispatch_id: launch.dispatch_id, prompt: "read" }).run as JsonObject;
    const input = { task_run_id: run.id, host_run_id: host.id, task_run_version: run.version, launch_version: launch.version, host_run_version: host.version, actor: "user" };
    assert.throws(() => f.service.taskRunReconcileHost(input), /not terminal/u);
    await f.service.hostRuns.wait(String(host.id));
    const finished = f.store.get("host_run", String(host.id));
    assert.throws(() => f.service.taskRunReconcileHost(input), /changed/u);
    const correct = { ...input, host_run_version: finished.version };
    for (const field of ["task_run_version", "launch_version", "host_run_version"] as const) {
      for (const invalid of [0, "1", 999]) assert.throws(() => f.service.taskRunReconcileHost({ ...correct, [field]: invalid }), /changed/u);
    }
    assert.throws(() => f.service.taskRunReconcileHost({ ...correct, actor: "" }), /actor/u);
    const unrelated = f.store.create("host_run", "unrelated", { host: "codex-cli", dispatch_id: "different", task_id: f.task.id, status: "completed" });
    assert.throws(() => f.service.taskRunReconcileHost({ ...correct, host_run_id: unrelated.id, host_run_version: unrelated.version }), /does not match/u);
    const duplicate = f.store.create("host_run", "duplicate", { host: host.host, dispatch_id: host.dispatch_id, task_id: host.task_id, status: "interrupted" });
    assert.throws(() => f.service.taskRunReconcileHost(correct), /ambiguous/u);
    f.store.remove("host_run", String(duplicate.id));
    const receipt = f.store.get("codex_receipt", String(finished.receipt_id));
    f.store.save("codex_receipt", String(receipt.id), { ...receipt, cancelled: true });
    assert.throws(() => f.service.taskRunReconcileHost(correct), /receipt/u);
    f.store.save("codex_receipt", String(receipt.id), receipt);
    const result = f.service.taskRunReconcileHost(correct);
    assert.equal((result.launch as JsonObject).run_id, host.id);
    assert.equal(result.idempotent, false);
    assert.equal(f.service.taskRunReconcileHost(correct).idempotent, true);
    const app = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173");
    const response = app.handle({ method: "POST", path: `/api/task-runs/${run.id}/reconcile-host`, token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify(correct) });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).idempotent, true);
    const mcp = new McpServer(f.service, "full");
    assert.ok(mcp.tools.some(tool => tool.name === "craft_task_run_reconcile_host"));
    assert.equal((await mcp.handlers.craft_task_run_reconcile_host(correct)).idempotent, true);
    assert.equal(executions, 1);
    assert.equal(f.store.events(`task:${f.task.id}`).filter(event => event.event_type === "task.host_run_reconciled").length, 1);
    assert.equal(f.store.find("work_delivery", `delivery_${launch.id}`), null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("write reconciliation requires the exact consumed authorization and receipt", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "reconcile-write", "local_write");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "reconcile-write-run", host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" });
    const started = f.service.workLaunchDecide({ launch_id: (prepared.launch as JsonObject).id, actor: "user", approved: true, prompt: "edit" });
    const activeLaunch = started.launch as JsonObject; const hostId = String(activeLaunch.run_id);
    await f.service.hostRuns.wait(hostId);
    const unlinked = f.store.save("work_launch", String(activeLaunch.id), { ...activeLaunch, status: "awaiting_approval", run_id: null, authorization_request_id: null });
    const run = f.store.get("task_run", "reconcile-write-run"); const host = f.store.get("host_run", hostId);
    const dispatch = f.store.get("codex_dispatch", String(host.dispatch_id));
    const consumption = f.store.get("autonomy_consumption", String(dispatch.authorization_consumption_id));
    const input = { task_run_id: run.id, host_run_id: host.id, task_run_version: run.version, launch_version: unlinked.version, host_run_version: host.version, actor: "user" };
    f.store.save("autonomy_consumption", String(consumption.id), { ...consumption, task_id: "foreign" });
    assert.throws(() => f.service.taskRunReconcileHost(input), /authorization/u);
    f.store.save("autonomy_consumption", String(consumption.id), consumption);
    const result = f.service.taskRunReconcileHost(input);
    assert.equal((result.launch as JsonObject).authorization_request_id, consumption.request_id);
    assert.equal((result.launch as JsonObject).run_id, hostId);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("reconciliation accepts a registered generic Host and preserves its write authorization", async () => {
  const f = await fixture();
  try {
    const profile = defineHostProfile({ host: "generic-test", kind: "agent-cli", command: "node", output_format: "text", argv_template: ["-e", "test"] });
    const driver = new GenericCliHostKernel(f.store, profile, async () => ({ exitCode: 0, signal: null, stdout: "ok", stderr: "", timedOut: false, cancelled: false, outputLimited: false }));
    f.service.hostDrivers.set(profile.host, driver);
    f.service.hostRuns.drivers.set(profile.host, driver);
    const control = contract(f, "generic-reconcile", "local_write");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "generic-reconcile-run", host: profile.host, workspace: f.root, prompt: "edit", sandbox: "workspace-write" });
    const started = f.service.workLaunchDecide({ launch_id: (prepared.launch as JsonObject).id, actor: "user", approved: true, prompt: "edit" });
    const launch = started.launch as JsonObject; const hostId = String(launch.run_id);
    await f.service.hostRuns.wait(hostId);
    const dispatch = f.store.get(profile.dispatch_kind, String(launch.dispatch_id));
    const consumption = f.store.get("autonomy_consumption", String(dispatch.authorization_consumption_id));
    assert.equal(consumption.idempotency_key, `${profile.host}:${dispatch.id}`);
    const unlinked = f.store.save("work_launch", String(launch.id), { ...launch, status: "awaiting_approval", run_id: null, authorization_request_id: null });
    const taskRun = f.store.get("task_run", "generic-reconcile-run"); const host = f.store.get("host_run", hostId);
    const input = { task_run_id: taskRun.id, host_run_id: host.id, task_run_version: taskRun.version, launch_version: unlinked.version, host_run_version: host.version, actor: "user" };
    profile.argv_template.push("changed");
    assert.throws(() => f.service.taskRunReconcileHost(input), /profile changed/u);
    profile.argv_template.pop();
    const receipt = f.store.get(`${profile.dispatch_kind}_receipt`, String(host.receipt_id));
    f.store.save(`${profile.dispatch_kind}_receipt`, String(receipt.id), { ...receipt, profile_digest: "different" });
    assert.throws(() => f.service.taskRunReconcileHost(input), /receipt profile/u);
    f.store.save(`${profile.dispatch_kind}_receipt`, String(receipt.id), receipt);
    f.service.hostDrivers.delete(profile.host);
    assert.throws(() => f.service.taskRunReconcileHost(input), /kind is unsupported/u);
    f.service.hostDrivers.set(profile.host, driver);
    const result = f.service.taskRunReconcileHost(input);
    assert.equal((result.launch as JsonObject).run_id, hostId);
    assert.equal((result.launch as JsonObject).authorization_request_id, consumption.request_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("interrupted Host reconciliation records recovery without inventing a successful receipt", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "reconcile-interrupted");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "reconcile-interrupted-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only", defer_host_start: true });
    const launch = prepared.launch as JsonObject; const run = prepared.task_run as JsonObject;
    const host = f.store.create("host_run", "interrupted-host", { host: "codex-cli", task_id: f.task.id, dispatch_id: launch.dispatch_id, status: "interrupted" });
    f.service.taskRunReconcileHost({ task_run_id: run.id, host_run_id: host.id, task_run_version: run.version, launch_version: launch.version, host_run_version: host.version, actor: "user" });
    const loop = f.service.deliveryLoopRefresh({ launch_id: launch.id }).loop as JsonObject;
    assert.equal(loop.action, "retry_or_handoff");
    assert.equal((f.service.taskRunRefresh({ task_run_id: run.id }).state as JsonObject).status, "recovery");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

for (const scenario of ["linked", "status", "identity", "missing-identity", "contract", "kind", "dispatch"] as const) {
  test(`Host reconciliation rejects ${scenario} drift`, async () => {
    const f = await fixture();
    try {
      const control = contract(f, `reconcile-${scenario}`);
      const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: `reconcile-${scenario}-run`, host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only", defer_host_start: true });
      let run = prepared.task_run as JsonObject; let launch = prepared.launch as JsonObject;
      const host = f.store.create("host_run", `host-${scenario}`, { host: "codex-cli", task_id: f.task.id, dispatch_id: launch.dispatch_id, status: "interrupted" });
      if (scenario === "linked") launch = f.store.save("work_launch", String(launch.id), { ...launch, run_id: "other" });
      if (scenario === "status") launch = f.store.save("work_launch", String(launch.id), { ...launch, status: "denied" });
      if (scenario === "identity") launch = f.store.save("work_launch", String(launch.id), { ...launch, prompt_digest: "different" });
      if (scenario === "missing-identity") run = f.store.save("task_run", String(run.id), { ...run, launch_identity: null });
      if (scenario === "contract") f.store.save("task_control_contract", String(control.id), { ...f.store.get("task_control_contract", String(control.id)), status: "revoked" });
      if (scenario === "kind") launch = f.store.save("work_launch", String(launch.id), { ...launch, dispatch_kind: "unsupported" });
      if (scenario === "dispatch") { const dispatch = f.store.get("codex_dispatch", String(run.dispatch_id)); f.store.save("codex_dispatch", String(dispatch.id), { ...dispatch, request_digest: "different" }); }
      const expected = { linked: /already linked/u, status: /current state/u, identity: /identity drifted/u, "missing-identity": /identity drifted/u, contract: /contract drifted/u, kind: /kind is unsupported/u, dispatch: /dispatch identity drifted/u };
      assert.throws(() => f.service.taskRunReconcileHost({ task_run_id: run.id, host_run_id: host.id, task_run_version: run.version, launch_version: launch.version, host_run_version: host.version, actor: "user" }), expected[scenario]);
    } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
  });
}

test("Task Run keeps approval, acceptance, recovery, and input drift explicit and MCP splits core from full controls", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "write", "local_write", true);
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "write-run", host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write", environment: { image: "same" }, budget: { usd: 1 }, acceptance_name: "review", acceptance_criteria: [{ id: "human", name: "Human", method: "human", required: true }] });
    const taskRun = prepared.task_run as JsonObject; const launch = prepared.launch as JsonObject;
    assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).action, "review_work_launch");
    assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id, environment: { image: "drift" } }).state as JsonObject).action, "revalidate_inputs");
    f.service.workLaunchDecide({ launch_id: launch.id, actor: "user", approved: true, prompt: "edit" }); await f.service.hostRuns.wait(String((f.service.workLaunchGet({ launch_id: launch.id }).launch as JsonObject).run_id));
    assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).action, "collect_acceptance");
    f.service.acceptanceHumanReview({ plan_id: String(launch.acceptance_plan_id), criterion_id: "human", reviewer: "user", result: "passed", summary: "checked" }); assert.equal((f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject).action, "deliver");
    const failedControl = contract(f, "failed"); const failed = f.service.taskRunPrepare({ contract_id: failedControl.id, task_run_id: "failed-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only" }); const failedLaunch = failed.launch as JsonObject; await f.service.hostRuns.wait(String(failedLaunch.run_id));
    const host = f.store.get("host_run", String(failedLaunch.run_id)); const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...hostPayload } = host; f.store.save("host_run", String(host.id), { ...hostPayload, status: "failed" }); f.service.deliveryLoopRefresh({ launch_id: failedLaunch.id });
    assert.equal((f.service.taskRunRefresh({ task_run_id: "failed-run" }).state as JsonObject).action, "retry_or_handoff");
    const blockedControl = contract(f, "blocked"); const blocked = f.service.taskRunPrepare({ contract_id: blockedControl.id, task_run_id: "blocked-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only", acceptance_name: "review", acceptance_criteria: [{ id: "human", name: "Human", method: "human", required: true }] }); const blockedLaunch = blocked.launch as JsonObject; await f.service.hostRuns.wait(String(blockedLaunch.run_id)); f.store.save("acceptance_assessment", `assessment_${blockedLaunch.acceptance_plan_id}`, { plan_id: blockedLaunch.acceptance_plan_id, status: "blocked" });
    f.service.deliveryLoopRefresh({ launch_id: blockedLaunch.id }); assert.equal((f.service.taskRunRefresh({ task_run_id: "blocked-run" }).state as JsonObject).action, "human_handoff");
    const core = new McpServer(f.service, "core"); const full = new McpServer(f.service, "full"); assert.ok(core.tools.some((item) => item.name === "craft_task_run_get")); assert.equal(core.tools.some((item) => item.name === "craft_task_run_prepare"), false); assert.ok(full.tools.some((item) => item.name === "craft_task_run_prepare")); assert.equal(((await full.handlers.craft_task_run_get({ task_run_id: taskRun.id })).run as JsonObject).id, taskRun.id);
    const mcpControl = contract(f, "mcp", "local_write"); assert.ok(((await full.handlers.craft_task_run_prepare({ contract_id: mcpControl.id, host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" })).task_run as JsonObject).id);
    await full.handlers.craft_task_run_refresh({ task_run_id: taskRun.id }); await full.handlers.craft_task_run_pause({ task_run_id: taskRun.id, reason: "mcp" }); await full.handlers.craft_task_run_resume({ task_run_id: taskRun.id }); await full.handlers.craft_task_run_handoff({ task_run_id: taskRun.id, reason: "mcp" });
    const app = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173"); const request = (method: string, path: string, body?: JsonObject) => app.handle({ method, path, token: "token", origin: "http://127.0.0.1:4173", body: body ? JSON.stringify(body) : undefined }); const webControl = contract(f, "web", "local_write"); assert.equal(request("POST", "/api/task-runs", { contract_id: webControl.id, host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" }).status, 201);
    assert.equal(request("GET", `/api/task-runs/${taskRun.id}`).status, 200); assert.equal(request("POST", `/api/task-runs/${taskRun.id}/refresh`).status, 200); assert.equal(request("POST", `/api/task-runs/${taskRun.id}/pause`, { reason: "ui" }).status, 200); assert.equal(request("POST", `/api/task-runs/${taskRun.id}/resume`).status, 200); assert.equal(request("POST", `/api/task-runs/${taskRun.id}/handoff`, { reason: "ui" }).status, 201); assert.equal(request("POST", `/api/task-runs/${taskRun.id}/cancel`, { reason: "ui" }).status, 200); await full.handlers.craft_task_run_cancel({ task_run_id: taskRun.id, reason: "mcp" });
    const liveControl = contract(f, "live"); const live = f.service.taskRunPrepare({ contract_id: liveControl.id, task_run_id: "live-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only" }); const liveLaunch = live.launch as JsonObject; assert.equal((f.service.taskRunCancel({ task_run_id: "live-run", reason: "stop" }).run as JsonObject).lifecycle, "cancelled"); await f.service.hostRuns.wait(String(liveLaunch.run_id));
    assert.throws(() => f.service.taskRunPrepare({ contract_id: control.id, host: "codex-cli", workspace: f.root, prompt: "again" }), /already bound/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("task handoff exposes versioned task and execution facts without copying the prompt", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "handoff-contract", "local_write", true);
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "handoff-run", host: "codex-cli", workspace: f.root,
      prompt: "private original prompt", sandbox: "workspace-write", acceptance_name: "review", acceptance_criteria: [{ id: "human", name: "Human", method: "human", required: true }] });
    const launch = prepared.launch as JsonObject;
    const taskBeforeHandoff = f.service.homeTask({ task_id: f.task.id });
    assert.equal((taskBeforeHandoff.task_runs as JsonObject[])[0]?.id, "handoff-run");
    assert.deepEqual(taskBeforeHandoff.task_handoffs, []);
    const handoff = f.service.taskRunHandoff({ task_run_id: "handoff-run", reason: "user takeover" }).handoff as JsonObject;
    assert.deepEqual(handoff.task_ref, { id: f.task.id, version: f.task.version });
    assert.deepEqual(handoff.launch_ref, { id: launch.id, version: launch.version });
    assert.equal(handoff.state_status, "awaiting_approval");
    assert.equal(handoff.next_actor, "human");
    assert.equal(handoff.acceptance_plan_id, launch.acceptance_plan_id);
    const acceptance = f.store.get("acceptance_plan", String(launch.acceptance_plan_id));
    assert.deepEqual(handoff.acceptance_plan_ref, { id: acceptance.id, version: acceptance.version });
    assert.equal(handoff.host_run_ref, null);
    assert.doesNotMatch(JSON.stringify(handoff), /private original prompt/);
    assert.equal(f.service.taskRunHandoff({ task_run_id: "handoff-run", reason: "user takeover" }).idempotent, true);
    const taskView = f.service.homeTask({ task_id: f.task.id });
    const views = taskView.task_handoffs as JsonObject[];
    assert.equal(views.length, 1);
    assert.deepEqual([views[0]!.id, views[0]!.state_status, views[0]!.next_actor], [handoff.id, "awaiting_approval", "human"]);
    const other = f.service.taskOpen({ title: "Other", goal: "unrelated" }).task as JsonObject;
    assert.deepEqual(f.service.homeTask({ task_id: other.id }).task_handoffs, []);
    assert.deepEqual(f.service.homeTask({ task_id: other.id }).task_runs, []);
    const updated = f.store.save("task", String(f.task.id), { ...f.task, goal: "Changed goal" });
    const newer = f.service.taskRunHandoff({ task_run_id: "handoff-run", reason: "user takeover" });
    assert.equal(newer.idempotent, false);
    assert.deepEqual((newer.handoff as JsonObject).task_ref, { id: updated.id, version: updated.version });
    assert.notEqual((newer.handoff as JsonObject).id, handoff.id);
    const get = f.store.get.bind(f.store); let reads = 0;
    f.store.get = ((kind, id) => {
      const item = get(kind, id);
      if (kind === "work_launch" && ++reads === 2) return f.store.save("work_launch", String(item.id), item);
      return item;
    }) as typeof f.store.get;
    assert.throws(() => f.service.taskRunHandoff({ task_run_id: "handoff-run", reason: "concurrent update" }), /launch changed during handoff/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("handoff rejects a task run changed after refresh through the workbench API", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "handoff-race", "local_write");
    f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "race-run", host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" });
    const refresh = f.service.taskRuns.refresh.bind(f.service.taskRuns);
    f.service.taskRuns.refresh = (args) => {
      const result = refresh(args);
      const run = f.store.get("task_run", "race-run");
      f.store.save("task_run", "race-run", { ...run, lifecycle: "paused", paused_reason: "changed" });
      return result;
    };
    const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
    const result = app.handle({ method: "POST", path: "/api/task-runs/race-run/handoff", token: "secret", body: JSON.stringify({ reason: "takeover" }) });
    assert.equal(result.status, 422);
    assert.match(result.body, /changed during handoff/);
    assert.equal(f.store.list("task_run_handoff", 100).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("handoff rejects a host observation changed after refresh", async () => {
  const f = await fixture();
  try {
    const control = contract(f, "handoff-host-race");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "host-race-run", host: "codex-cli", workspace: f.root, prompt: "read", sandbox: "read-only" });
    const launch = prepared.launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const refresh = f.service.taskRuns.refresh.bind(f.service.taskRuns);
    f.service.taskRuns.refresh = (args) => {
      const result = refresh(args);
      const host = f.store.get("host_run", String(launch.run_id));
      f.store.save("host_run", String(host.id), { ...host, status: "interrupted" });
      return result;
    };
    assert.throws(() => f.service.taskRunHandoff({ task_run_id: "host-race-run", reason: "review" }), /host changed during handoff/);
    assert.equal(f.store.list("task_run_handoff", 100).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Task Run fails closed for an invalid bound identity and keeps null Host observations explicit", async () => {
  const f = await fixture();
  try {
    const rawLaunch = (id: string, host: string, dispatchId: string) => f.store.create("work_launch", id, { task_id: f.task.id, host, dispatch_id: dispatchId, workspace: f.root, sandbox: "read-only", prompt_digest: "sha256:prompt" });
    rawLaunch("inactive-launch", "codex-cli", "missing"); f.store.create("task_control_contract", "inactive", { task_id: f.task.id, launch_id: "inactive-launch", status: "inactive" }); assert.throws(() => f.service.taskRuns.create({ contract_id: "inactive", launch_id: "inactive-launch" }), /active/);
    rawLaunch("unsupported-launch", "other", "missing"); f.store.create("task_control_contract", "unsupported", { task_id: f.task.id, launch_id: "unsupported-launch", status: "active" }); assert.throws(() => f.service.taskRuns.create({ contract_id: "unsupported", launch_id: "unsupported-launch" }), /unsupported/);
    f.store.create("codex_dispatch", "raw-dispatch", { request_digest: "sha256:request" }); rawLaunch("raw-launch", "codex-cli", "raw-dispatch"); f.store.create("task_control_contract", "raw", { task_id: f.task.id, launch_id: "raw-launch", status: "active" }); const run = f.service.taskRuns.create({ task_run_id: "raw-run", contract_id: "raw", launch_id: "raw-launch" }).run as JsonObject; assert.throws(() => f.service.taskRuns.create({ task_run_id: run.id, contract_id: "raw", launch_id: "raw-launch", budget: { usd: 2 } }), /conflict/); assert.equal((f.service.taskRunRefresh({ task_run_id: run.id }).state as JsonObject).action, "wait_for_host");
    f.store.create("host_run", "terminal", { status: "completed" }); const current = f.store.get("work_launch", "raw-launch"); const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...launchPayload } = current; f.store.save("work_launch", "raw-launch", { ...launchPayload, run_id: "terminal" }); assert.equal((f.service.taskRunRefresh({ task_run_id: run.id }).state as JsonObject).action, "human_handoff");
    f.store.create("claude_dispatch", "claude-dispatch", { request_digest: "sha256:claude" }); rawLaunch("claude-launch", "claude-code", "claude-dispatch"); f.store.create("task_control_contract", "claude", { task_id: f.task.id, launch_id: "claude-launch", status: "active" }); assert.match(String((f.service.taskRuns.create({ contract_id: "claude", launch_id: "claude-launch" }).run as JsonObject).id), /^task_run_/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("business-rejected task retry carries evaluators forward but waits for fresh approved output", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.service.codexHost.executor = async () => {
      await writeFile(join(f.root, "retry-result.txt"), ++calls === 1 ? "bad" : "ready");
      return { exitCode: 0, signal: null, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, stderr: "", timedOut: false, outputLimited: false };
    };
    const control = contract(f, "business-retry", "local_write", true);
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "business-retry", host: "codex-cli", prompt: "produce", sandbox: "workspace-write", acceptance_criteria: [{ id: "file", name: "Exact file", method: "program" }] });
    const started = f.service.workLaunchDecide({ launch_id: (prepared.launch as JsonObject).id, actor: "user:owner", approved: true, prompt: "produce" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(started.run_id));
    f.service.acceptanceFileEvaluationPrepare({ plan_id: started.acceptance_plan_id, criterion_id: "file", workspace: f.root, relative_path: "retry-result.txt", expected_sha256: createHash("sha256").update("ready").digest("hex") });
    await runBuiltinAcceptanceTicks(f.service);
    const old = f.service.acceptancePlanGet({ plan_id: started.acceptance_plan_id }).outcome as JsonObject;
    assert.equal(old.verdict, "failed");
    const source = f.store.get("task_run", "business-retry"); const launch = f.store.get("work_launch", String(started.id)); const host = f.store.get("host_run", String(launch.run_id));
    const previousJob = f.store.list("acceptance_evaluation_job", 100, item => item.plan_id === started.acceptance_plan_id)[0];
    const evaluator = f.store.get("acceptance_evaluator", String(previousJob.evaluator_id));
    const config = { evaluator_id: evaluator.id, name: evaluator.name, method: evaluator.method, adapter_id: evaluator.adapter_id, configuration: evaluator.configuration };
    f.service.acceptanceEvaluatorSave({ ...config, enabled: false });
    assert.throws(() => f.service.taskRunRetry({ task_run_id: source.id, task_run_version: source.version, launch_version: launch.version, host_run_version: host.version, new_task_run_id: "business-retry-next", prompt: "repair", actor: "user:owner" }), /evaluator is disabled/u);
    assert.equal(f.store.find("task_run", "business-retry-next"), null);
    f.service.acceptanceEvaluatorSave({ ...config, enabled: true });
    const result = f.service.taskRunRetry({ task_run_id: source.id, task_run_version: source.version, launch_version: launch.version, host_run_version: host.version, new_task_run_id: "business-retry-next", prompt: "repair", actor: "user:owner" });
    const next = result.launch as JsonObject;
    assert.equal(next.status, "awaiting_approval");
    assert.equal((f.service.acceptanceEvaluationClaim({ adapter_id: "builtin:file-artifact", plan_id: next.acceptance_plan_id }).jobs as JsonObject[]).length, 0);
    const approved = f.service.workLaunchDecide({ launch_id: next.id, actor: "user:owner", approved: true, prompt: "repair" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(approved.run_id));
    await runBuiltinAcceptanceTicks(f.service);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "business-retry-next" }).state as JsonObject).action, "deliver");
    assert.deepEqual(f.store.get("outcome", String(old.id)), old);
    assert.equal(calls, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("retry validates snapshots and coordination boundaries and rolls back preparation failures", async t => {
  const f = await fixture();
  try {
    let calls = 0;
    f.service.codexHost.executor = async () => { calls++; return { exitCode: 1, signal: null, stdout: "", stderr: "failed", timedOut: false, outputLimited: false }; };
    const profile = f.store.create("activation_profile", "retry-profile", { task_id: f.task.id, allowed_effects: ["read_only"] });
    const account = f.store.create("budget_account", "retry-account", { owner_id: f.task.id, status: "active", limits: { usd: 1 }, used: {}, reserved: {} });
    const control = f.service.taskControlSave({ contract_id: "retry-pinned", task_id: f.task.id, workspace: f.root, allowed_effects: ["read_only"], activation_profile_id: profile.id, budget_account_id: account.id }).contract as JsonObject;
    const environment = { image: "pinned" }, budget = { usd: 1 };
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "retry-pinned", host: "codex-cli", prompt: "first", environment, budget });
    const originalLaunch = prepared.launch as JsonObject;
    await f.service.hostRuns.wait(String(originalLaunch.run_id));
    const args = (extra: JsonObject = {}) => {
      const source = f.store.get("task_run", "retry-pinned"); const launch = f.store.get("work_launch", String(originalLaunch.id));
      const host = launch.run_id ? f.store.get("host_run", String(launch.run_id)) : null;
      return { task_run_id: source.id, task_run_version: source.version, launch_version: launch.version, host_run_version: host?.version, new_task_run_id: "retry-safe-next", prompt: "retry", actor: "user:owner", environment, budget, ...extra };
    };
    assert.throws(() => f.service.taskRunRetry(args({ new_task_run_id: "retry-pinned" })), /target already exists/u);
    for (const new_task_run_id of ["../escape", "contains/slash", "x".repeat(129)]) assert.throws(() => f.service.taskRunRetry(args({ new_task_run_id })), /safe identifier/u);
    f.store.save("budget_account", String(account.id), { ...account, status: "closed" });
    assert.throws(() => f.service.taskRunRetry(args()), /budget account is not active/u);
    f.store.save("budget_account", String(account.id), account);
    assert.throws(() => f.service.taskRunRetry(args({ environment: undefined })), /matching environment and budget/u);
    assert.throws(() => f.service.taskRunRetry(args({ budget: undefined })), /matching environment and budget/u);
    f.service.taskRunPause({ task_run_id: "retry-pinned", reason: "pause" });
    assert.throws(() => f.service.taskRunRetry(args()), /not ready/u);
    f.service.taskRunResume({ task_run_id: "retry-pinned", environment, budget });
    f.store.save("work_launch", String(originalLaunch.id), { ...originalLaunch, run_id: undefined });
    assert.throws(() => f.service.taskRunRetry(args()), /source changed/u);
    for (const patch of [{ deferred_start: true }, { activation_plan_id: "simulated-specialized-context" }]) {
      f.store.save("work_launch", String(originalLaunch.id), { ...originalLaunch, ...patch });
      f.service.deliveryLoopRefresh({ launch_id: originalLaunch.id });
      assert.throws(() => f.service.taskRunRetry(args()), /original preparation entry|activation preparation entry/u);
    }
    f.store.save("work_launch", String(originalLaunch.id), originalLaunch);
    f.service.deliveryLoopRefresh({ launch_id: originalLaunch.id });
    const kinds = ["task_control_contract", "work_launch", "task_run", "codex_dispatch", "task_run_retry"];
    const before = kinds.map(kind => f.store.list(kind, 1000).length);
    const injected = t.mock.method(f.service.taskRuns, "create", () => { throw new Error("simulated retry persistence failure"); });
    assert.throws(() => f.service.taskRunRetry(args()), /persistence failure/u);
    injected.mock.restore();
    assert.deepEqual(kinds.map(kind => f.store.list(kind, 1000).length), before);
    assert.equal(calls, 1);
    const next = f.service.taskRunRetry(args());
    await f.service.hostRuns.wait(String((next.launch as JsonObject).run_id));
    const nextRun = next.task_run as JsonObject; const nextControl = f.store.get("task_control_contract", String(nextRun.contract_id));
    assert.equal((nextControl.activation_profile as JsonObject).id, profile.id);
    assert.equal((nextControl.budget_account as JsonObject).id, account.id);
    assert.deepEqual(nextControl.allowed_effects, ["read_only"]);
    assert.equal(calls, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a committed retry survives startup failure without creating or executing another attempt", async t => {
  const f = await fixture();
  try {
    let calls = 0;
    f.service.codexHost.executor = async () => ({ exitCode: ++calls === 1 ? 1 : 0, signal: null, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, stderr: "", timedOut: false, outputLimited: false });
    const control = contract(f, "retry-startup");
    const prepared = f.service.taskRunPrepare({ contract_id: control.id, task_run_id: "retry-startup", host: "codex-cli", prompt: "first" });
    const launch = prepared.launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const source = f.store.get("task_run", "retry-startup"); const host = f.store.get("host_run", String(launch.run_id));
    const args = { task_run_id: source.id, task_run_version: source.version, launch_version: launch.version, host_run_version: host.version, new_task_run_id: "retry-startup-next", prompt: "second", actor: "user:owner" };
    const injected = t.mock.method(f.service.hostRuns, "start", () => { throw new Error("simulated startup registration failure"); });
    assert.throws(() => f.service.taskRunRetry(args), /registration failure/u);
    injected.mock.restore();
    assert.equal(calls, 1);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "retry-startup-next" }).state as JsonObject).action, "start_host");
    const replay = f.service.taskRunRetry(args);
    assert.equal(replay.idempotent, true);
    assert.equal(calls, 1);
    const child = replay.task_run as JsonObject; const staged = replay.launch as JsonObject;
    const resumed = f.service.taskRunStart({ task_run_id: child.id, task_run_version: child.version, launch_version: staged.version, prompt: "second" });
    await f.service.hostRuns.wait(String((resumed.run as JsonObject).id));
    assert.equal(calls, 2);
    assert.equal((f.service.taskRunRefresh({ task_run_id: child.id }).state as JsonObject).action, "deliver");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});


test("lifecycle commands and handoff reject stale or invalid versions before changing state or cancelling work", async () => {
  const f = await fixture();
  try {
    const prepared = f.service.taskRunPrepare({ contract_id: contract(f, "versioned-controls").id, task_run_id: "versioned-run", host: "codex-cli", prompt: "inspect", defer_host_start: true });
    const run = prepared.task_run as JsonObject;
    const currentRun = f.store.get("task_run", String(run.id));
    for (const version of [0, -1, "1", 1.5, 999]) {
      for (const action of ["pause", "resume", "cancel", "handoff"] as const) {
        const args = { task_run_id: run.id, task_run_version: version, reason: "stale page" };
        const invoke = { pause: () => f.service.taskRunPause(args), resume: () => f.service.taskRunResume(args), cancel: () => f.service.taskRunCancel(args), handoff: () => f.service.taskRunHandoff(args) };
        assert.throws(invoke[action], /version changed/);
        assert.deepEqual(f.store.get("task_run", String(run.id)), currentRun);
        assert.equal(f.store.list("host_run", 10).length, 0);
      }
    }
    const paused = f.service.taskRunPause({ task_run_id: run.id, task_run_version: currentRun.version, reason: "manual review" }).run as JsonObject;
    assert.equal(f.service.taskRunPause({ task_run_id: run.id, task_run_version: paused.version, reason: "manual review" }).idempotent, true);
    const snapshot = f.service.taskRunHandoff({ task_run_id: run.id, task_run_version: paused.version, reason: "handoff" }).handoff as JsonObject;
    assert.equal(snapshot.task_run_version, paused.version);
    const resumed = f.service.taskRunResume({ task_run_id: run.id, task_run_version: paused.version }).run as JsonObject;
    const cancelled = f.service.taskRunCancel({ task_run_id: run.id, task_run_version: resumed.version, reason: "stop" }).run as JsonObject;
    assert.equal(cancelled.lifecycle, "cancelled");
    assert.throws(() => f.service.taskRunResume({ task_run_id: run.id, task_run_version: cancelled.version }), /Cancelled/);
    assert.equal(f.store.list("host_run", 10).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});


test("paused live write hands off partial output and continues only through a fresh approved and revalidated attempt", async () => {
  const f = await fixture();
  let executions = 0;
  let entered!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  try {
    f.service.codexHost.executor = async request => {
      executions++;
      await writeFile(join(f.root, "handoff.txt"), executions === 1 ? "partial work" : "finished work");
      if (executions === 1) {
        entered();
        return new Promise(resolve => request.signal?.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false }), { once: true }));
      }
      return { exitCode: 0, signal: null, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, stderr: "", timedOut: false, cancelled: false, outputLimited: false };
    };
    const prepared = f.service.taskRunPrepare({ contract_id: contract(f, "live-handoff", "local_write", true).id, task_run_id: "live-source", host: "codex-cli", prompt: "produce file", sandbox: "workspace-write", acceptance_criteria: [{ id: "file", name: "Final file", method: "program" }] });
    const initial = prepared.launch as JsonObject;
    f.service.acceptanceFileEvaluationPrepare({ job_id: "initial-file-check", plan_id: initial.acceptance_plan_id, criterion_id: "file", workspace: f.root, relative_path: "handoff.txt", expected_sha256: createHash("sha256").update("finished work").digest("hex") });
    const launched = f.service.workLaunchDecide({ launch_id: initial.id, approved: true, actor: "user:owner", prompt: "produce file" }).launch as JsonObject;
    await firstEntered;
    const web = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173");
    const before = f.store.get("task_run", "live-source");
    const stale = web.handle({ method: "POST", path: "/api/task-runs/live-source/pause", token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify({ task_run_version: 0, reason: "stale page" }) });
    assert.equal(stale.status, 422);
    assert.equal(f.store.get("host_run", String(launched.run_id)).cancel_requested, false);
    assert.equal(f.store.get("task_run", "live-source").lifecycle, "active");
    const pause = web.handle({ method: "POST", path: "/api/task-runs/live-source/pause", token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify({ task_run_version: before.version, reason: "inspect partial work" }) });
    assert.equal(pause.status, 200);
    await f.service.hostRuns.wait(String(launched.run_id));
    assert.equal(await readFile(join(f.root, "handoff.txt"), "utf8"), "partial work");
    const paused = f.store.get("task_run", "live-source");
    const snapshot = f.service.taskRunHandoff({ task_run_id: paused.id, task_run_version: paused.version, reason: "continue retained file" }).handoff as JsonObject;
    assert.equal(snapshot.state_status, "paused");
    const mcp = new McpServer(f.service, "full");
    await mcp.handlers.craft_task_run_resume({ task_run_id: paused.id, task_run_version: paused.version });
    assert.equal(executions, 1);
    assert.equal((f.service.taskRunRefresh({ task_run_id: paused.id }).state as JsonObject).status, "recovery");
    const source = f.store.get("task_run", "live-source");
    const next = f.service.taskRunRetry({ task_run_id: source.id, task_run_version: source.version, launch_version: f.store.get("work_launch", String(initial.id)).version, host_run_version: f.store.get("host_run", String(launched.run_id)).version, new_task_run_id: "live-successor", prompt: "finish retained work", actor: "user:owner" }).launch as JsonObject;
    assert.equal(next.status, "awaiting_approval");
    assert.equal(executions, 1);
    const restarted = f.service.workLaunchDecide({ launch_id: next.id, approved: true, actor: "user:owner", prompt: "finish retained work" }).launch as JsonObject;
    await f.service.hostRuns.wait(String(restarted.run_id));
    assert.equal(executions, 2);
    await runBuiltinAcceptanceTicks(f.service);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "live-successor" }).state as JsonObject).action, "deliver");
    await writeFile(join(f.root, "handoff.txt"), "manual edit");
    let plan = f.store.get("acceptance_plan", String(next.acceptance_plan_id));
    f.service.acceptanceRecheck({ plan_id: plan.id, plan_version: plan.version });
    await runBuiltinAcceptanceTicks(f.service);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "live-successor" }).state as JsonObject).action, "retry_or_handoff");
    await writeFile(join(f.root, "handoff.txt"), "finished work");
    plan = f.store.get("acceptance_plan", String(next.acceptance_plan_id));
    await mcp.handlers.craft_acceptance_recheck({ plan_id: plan.id, plan_version: plan.version });
    await runBuiltinAcceptanceTicks(f.service);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "live-successor" }).state as JsonObject).action, "deliver");
    assert.equal(f.store.get("task_run", "live-source").lifecycle, "active");
    assert.equal(f.store.get("host_run", String(launched.run_id)).status, "cancelled");
    assert.equal(executions, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});


test("three committed retries share one lineage across entries and exhaustion never creates a fourth execution", async () => {
  const f = await fixture();
  let executions = 0;
  try {
    f.service.codexHost.executor = async () => { executions++; throw new Error("simulated execution failure"); };
    const prepared = f.service.taskRunPrepare({ contract_id: contract(f, "bounded-rework").id, task_run_id: "rework-root", host: "codex-cli", prompt: "inspect" });
    let launch = prepared.launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const rootLaunch = launch;
    let runId = "rework-root";
    let latestRequest: JsonObject = {};
    const mcp = new McpServer(f.service, "full");
    const web = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:4173");
    for (let index = 1; index <= 3; index++) {
      const run = f.store.get("task_run", runId);
      latestRequest = { task_run_id: runId, task_run_version: run.version, launch_version: f.store.get("work_launch", String(launch.id)).version, host_run_version: f.store.get("host_run", String(launch.run_id)).version, new_task_run_id: `bounded-retry-${index}`, actor: "user:owner", prompt: "repair failure" };
      if (index === 1) {
        const stale = web.handle({ method: "POST", path: `/api/task-runs/${runId}/retry`, token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify({ ...latestRequest, task_run_version: Number(run.version) + 1 }) });
        assert.equal(stale.status, 422);
        assert.equal(executions, 1);
      }
      const result = index === 1 ? (() => { const response = web.handle({ method: "POST", path: `/api/task-runs/${runId}/retry`, token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify(latestRequest) }); assert.equal(response.status, 201); return JSON.parse(String(response.body)) as JsonObject; })() : await mcp.handlers.craft_task_run_retry(latestRequest) as JsonObject;
      launch = result.launch as JsonObject;
      await f.service.hostRuns.wait(String(launch.run_id));
      const policy = ((f.service.workLaunchGet({ launch_id: launch.id }).launch as JsonObject).retry_policy as JsonObject);
      assert.equal(policy.root_launch_id, rootLaunch.id);
      assert.equal(policy.retries_used, index);
      assert.equal(executions, index + 1);
      assert.equal((await mcp.handlers.craft_task_run_retry(latestRequest) as JsonObject).idempotent, true);
      if (index === 1) {
        const recovered = web.handle({ method: "POST", path: `/api/task-runs/${runId}/retry`, token: "token", origin: "http://127.0.0.1:4173", body: JSON.stringify(latestRequest) });
        assert.equal(recovered.status, 201);
        const replay = JSON.parse(recovered.body) as JsonObject;
        assert.equal(replay.idempotent, true);
        assert.equal((replay.retry as JsonObject).id, (result.retry as JsonObject).id);
        assert.equal((replay.launch as JsonObject).id, launch.id);
      }
      assert.equal(executions, index + 1);
      runId = String(latestRequest.new_task_run_id);
    }
    const state = f.service.taskRunRefresh({ task_run_id: runId }).state as JsonObject;
    assert.equal(state.status, "rework_limit");
    assert.equal(state.action, "replan_with_evidence");
    const snapshot = f.service.taskRunHandoff({ task_run_id: runId, reason: "replan with new evidence" }).handoff as JsonObject;
    assert.equal(snapshot.next_actor, "human");
    assert.equal(snapshot.resume_action, "replan_with_evidence");
    f.service.attentionRefresh({});
    const pending = (f.service.attentionList({ audience: "human" }).items as JsonObject[]).find(item => item.action === "replan_with_evidence");
    assert.equal(pending?.task_id, f.task.id);
    f.service.attentionRefresh({});
    assert.equal((f.service.attentionList({ audience: "human" }).items as JsonObject[]).filter(item => item.action === "replan_with_evidence").length, 1);
    const run = f.store.get("task_run", runId);
    const triesBefore = f.store.list("trial", 1000).length;
    assert.throws(() => f.service.taskRunRetry({ ...latestRequest, task_run_id: runId, task_run_version: run.version, launch_version: f.store.get("work_launch", String(launch.id)).version, host_run_version: f.store.get("host_run", String(launch.run_id)).version, new_task_run_id: "forbidden-fourth" }), /rework limit/);
    assert.throws(() => f.service.workLaunchRetry({ launch_id: launch.id, prompt: "bypass task run", new_launch_id: "fourth-launch" }), /rework limit/);
    assert.throws(() => f.service.workLaunchRetry({ launch_id: rootLaunch.id, prompt: "branch from root" }), /already has a successor/);
    assert.equal(f.store.list("trial", 1000).length, triesBefore);
    assert.equal(f.store.find("task_run", "forbidden-fourth"), null);
    assert.equal(f.store.find("work_launch", "fourth-launch"), null);
    assert.equal(executions, 4);
    const home = f.service.homeTask({ task_id: f.task.id });
    const visible = (home.task_runs as JsonObject[]).find(item => item.id === runId)!;
    assert.equal((visible.retry_policy as JsonObject).exhausted, true);
    const foreign = f.service.taskOpen({ title: "Other", goal: "other" }).task as JsonObject;
    assert.throws(() => f.service.workLaunchPrepare({ task_id: foreign.id, host: "codex-cli", workspace: f.root, prompt: "foreign retry", retry_of: launch.id }), /retain its task/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
