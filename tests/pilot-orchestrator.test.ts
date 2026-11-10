import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import {
  choosePilotExecutor,
  pilotRecordId,
  pilotStage,
  pilotStatusProjection,
  reconcilePilotWorker,
  routeWorker,
  reviewPilotPlan,
  splitPilotInput,
} from "../core/pilot-orchestrator.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-pilot-orchestrator-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  const dir = join(root, "repo");
  await mkdir(dir);
  const workspace = (service.workspaceResolveOrCreate({ root_path: dir }) as JsonObject).workspace as JsonObject;
  return { root, store, service, workspaceId: String(workspace.id) };
}

test("Mainer splits explicit lists, blank-line groups and removes duplicate goals", () => {
  const listed = splitPilotInput("1. 修复登录\n2. 补回归测试", { preferred_executor: "codex", available_executors: ["codex", "craft"] });
  assert.deepEqual(listed.map((item) => item.title), ["修复登录", "补回归测试"]);
  assert.equal(listed[0]?.executor_template, "codex");
  assert.equal(listed[0]?.confidence, 0.9);

  const grouped = splitPilotInput("整理需求\n\n补齐设计\n\n整理需求", { available_executors: ["claude"] });
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0]?.executor_template, "claude");
  assert.equal(grouped[0]?.reason, "按本机可用执行器顺序选择");

  const fallback = splitPilotInput("  只有一个目标  ");
  assert.equal(fallback[0]?.executor_template, "craft");
  assert.equal(fallback[0]?.reason, "没有可用外部执行器时使用 Craft 内置执行器");

  const continued = splitPilotInput("1. 第一项\n补充约束\n2. 第二项\n细项保留");
  assert.equal(continued[0]?.goal, "第一项\n补充约束");
  assert.match(String(continued[1]?.goal), /细项保留/u);
});

test("Mainer bounds input size and task count and formats long titles", () => {
  assert.throws(() => splitPilotInput(" ", {}), /input must not be empty/u);
  assert.throws(() => splitPilotInput("x".repeat(32_001)), /too large/u);
  assert.throws(() => splitPilotInput(Array.from({ length: 9 }, (_, index) => `- task ${index + 1}`).join("\n")), /at most 8/u);
  const title = splitPilotInput(`${"a".repeat(70)}\nbody`)[0]?.title as string;
  assert.equal(title.length, 58);
  assert.match(title, /…$/u);
});

test("Router accepts explicit and usable preferences, but refuses unsupported explicit choices", () => {
  assert.deepEqual(choosePilotExecutor("dsh", "codex", ["dsh"]), {
    executor_template: "dsh", reason: "你为本次工作显式选择了执行器", confidence: 1,
  });
  assert.equal(choosePilotExecutor(undefined, "codex", ["codex", "craft"]).confidence, 0.9);
  assert.equal(choosePilotExecutor(undefined, "claude", ["craft"]).executor_template, "craft");
  assert.equal(choosePilotExecutor(undefined, null, []).executor_template, "craft");
  assert.throws(() => choosePilotExecutor("unknown", null, []), /unsupported/u);
  assert.throws(() => choosePilotExecutor(" ", null, []), /must not be empty/u);
});

test("Reviewer distinguishes pass, human review, warnings and hard blocks", () => {
  const tasks = [
    { id: "a", title: "A", goal: "same", workspace_id: "ws", version: 1 },
    { id: "b", title: "B", goal: "same", version: 1 },
  ];
  const routes = [
    { id: "ra", task_id: "a", executor_template: "craft" },
    { id: "rb", task_id: "b", executor_template: "codex" },
  ];
  const warned = reviewPilotPlan(tasks, routes);
  assert.equal(warned.verdict, "pass");
  assert.equal(warned.checks.find((check) => check.id === "duplicate_goal")?.ok, false);
  assert.equal(warned.checks.find((check) => check.id === "workspace_binding")?.ok, false);

  const needsHuman = reviewPilotPlan(tasks, routes.slice(0, 1), [{ status: "open", task_id: "a" }]);
  assert.equal(needsHuman.verdict, "needs_human");
  assert.equal(needsHuman.checks.find((check) => check.id === "route_coverage")?.ok, false);
  assert.equal(needsHuman.checks.find((check) => check.id === "open_attention")?.ok, false);

  const blocked = reviewPilotPlan([], [{ task_id: "other", executor_template: "" }]);
  assert.equal(blocked.verdict, "block");
  assert.equal(blocked.checks.find((check) => check.id === "task_count")?.ok, false);
  assert.equal(blocked.checks.find((check) => check.id === "route_integrity")?.ok, false);
  const invalidTask = reviewPilotPlan([{ id: "", title: "", goal: "" }], []);
  assert.equal(invalidTask.checks.find((check) => check.id === "task_contract")?.ok, false);
  const missingGoal = reviewPilotPlan([{ id: "x", title: "X" }], []);
  assert.equal(missingGoal.checks.find((check) => check.id === "task_contract")?.ok, false);
  const failedRoute = reviewPilotPlan(tasks, routes.map((route, index) => index === 0 ? { ...route, queue_state: "finished",
    worker: { state: "failed" } } : route));
  assert.equal(failedRoute.checks.find((check) => check.id === "worker_terminal")?.ok, false);
  assert.equal(failedRoute.verdict, "needs_human");
  const deferred = reviewPilotPlan(tasks, routes, [{ status: "deferred", task_id: "a" }]);
  assert.equal(deferred.checks.find((check) => check.id === "open_attention")?.ok, false);
});

test("pilot record identity, stage and status projection are deterministic", () => {
  assert.equal(pilotRecordId("pilot_turn", { b: 2, a: 1 }), pilotRecordId("pilot_turn", { a: 1, b: 2 }));
  assert.equal(pilotStage([], [], []), "captured");
  assert.equal(pilotStage([{ id: "t" }], [], []), "mained");
  assert.equal(pilotStage([{ id: "t" }], [{ id: "r" }], []), "routed");
  assert.equal(pilotStage([{ id: "t" }], [{ id: "r", queue_state: "running" }], []), "working");
  assert.equal(pilotStage([{ id: "t" }], [{ id: "r", queue_state: "queued" }], [{ id: "review" }]), "reviewed");
  assert.equal(pilotStage([{ id: "t" }], [{ id: "r", queue_state: "blocked" }], [{ id: "review" }]), "needs_attention");
  const routeWithWorker = {
    id: "r-worker", task_id: "t", queue_state: "running", worker: { state: "started", provider: "codex", link_id: null },
  };
  assert.deepEqual(routeWorker(routeWithWorker), { state: "started", provider: "codex", link_id: null });
  assert.equal(routeWorker({ id: "plain", worker: [] }), null);
  assert.equal(reconcilePilotWorker(routeWithWorker, null), null);
  assert.equal(reconcilePilotWorker(routeWithWorker, {
    id: "link", task_id: "t", provider: "codex", turn_state: "running",
  }), null);
  assert.equal(reconcilePilotWorker(routeWithWorker, {
    id: "link", task_id: "t", provider: "claude", turn_state: "idle", last_turn_status: "completed",
  }), null);
  assert.equal(reconcilePilotWorker(routeWithWorker, {
    id: "link", task_id: "other", provider: "codex", turn_state: "idle", last_turn_status: "completed",
  }), null);
  assert.equal(reconcilePilotWorker(routeWithWorker, {
    id: "link", task_id: "t", provider: "codex", turn_state: "starting",
  }), null);
  assert.equal(reconcilePilotWorker({ id: "r-empty", queue_state: "running", worker: { state: "started" } },
    { turn_state: "running" }), null);
  assert.deepEqual(reconcilePilotWorker(routeWithWorker, {
    id: "link", task_id: "t", provider: "codex", turn_state: "idle",
  }), null);
  assert.deepEqual(reconcilePilotWorker(routeWithWorker, {
    id: "link", task_id: "t", provider: "codex", turn_state: "idle", last_turn_status: "completed",
  }), { state: "completed", reason: null });
  assert.deepEqual(reconcilePilotWorker(routeWithWorker, {
    id: "link", task_id: "t", provider: "codex", turn_state: "idle", last_turn_status: "interrupted",
  }), { state: "failed", reason: "原生回合 interrupted" });
  assert.deepEqual(reconcilePilotWorker(routeWithWorker, {
    id: "link", task_id: "t", provider: "codex", turn_state: "unknown",
  }), { state: "failed", reason: "原生会话回合状态未确认，请先核对" });
  const projection = pilotStatusProjection({
    session: { id: "s" },
    turns: [{ id: "turn" }],
    routes: [{ id: "queued", queue_state: "queued" }, { id: "running", queue_state: "running" },
      { id: "finished", queue_state: "finished" }, { id: "failed", queue_state: "finished",
        worker: { state: "failed", provider: "codex", link_id: "link" } },
      { id: "blocked", queue_state: "blocked" }],
    tasks: [{ id: "t" }],
    reviews: [{ id: "review" }, { id: "latest" }],
    attention: [{ status: "open" }, { status: "resolved" }],
  });
  assert.equal(projection.stage, "needs_attention");
  assert.deepEqual(projection.counts, { tasks: 1, running: 1, queued: 1, finished: 2, blocked: 1, failed: 1, attention: 1 });
  assert.deepEqual(projection.result_facts, { passed: 0, awaiting_verification: 0, needs_attention: 0 });
  assert.deepEqual(projection.latest_review, { id: "latest" });
  assert.equal(pilotStatusProjection({ session: { id: "s" }, turns: [], routes: [], tasks: [],
    reviews: [], attention: [] }).latest_review, null);
  const withResults = pilotStatusProjection({ session: { id: "s" }, turns: [], routes: [], tasks: [],
    reviews: [], attention: [], results: [
      { verdict: "passed" }, { verdict: "awaiting_verification" }, { verdict: "needs_attention" },
    ] });
  assert.deepEqual(withResults.result_facts, { passed: 1, awaiting_verification: 1, needs_attention: 1 });
});

test("Pilot auto intake persists a reusable turn, tasks and hard review", async () => {
  const f = await fixture();
  try {
    const session = (f.service.pilotSessionOpen({ input: "ship it", workspace_id: f.workspaceId }) as JsonObject).session as JsonObject;
    const result = f.service.pilotTurnAuto({ session_id: session.id,
      workspace_id: f.workspaceId, executor: "craft", executors: ["craft", "codex"],
      input: "1. 整理需求\n2. 补齐设计" }) as JsonObject;
    assert.equal(result.status, "created");
    assert.equal(result.tasks_created, 2);
    assert.equal((result.turn as JsonObject).content_stored, true);
    assert.equal((result.review as JsonObject).verdict, "pass");
    assert.equal((result.review as JsonObject).model_has_authority, false);

    const status = f.service.pilotSessionStatus({ session_id: session.id }) as JsonObject;
    assert.equal((status.turns as JsonObject[]).length, 1);
    assert.equal((status.tasks as JsonObject[]).length, 2);
    assert.equal((status.routes as JsonObject[]).length, 2);
    assert.equal((status.reviews as JsonObject[]).length, 1);
    assert.equal((status.progress as JsonObject).stage, "reviewed");

    const again = f.service.pilotTurnAuto({ session_id: session.id,
      workspace_id: f.workspaceId, executor: "craft", executors: ["craft"],
      input: "1. 整理需求\n2. 补齐设计" }) as JsonObject;
    assert.equal(again.idempotent, true);
    assert.equal(f.store.list("task", 10).length, 2);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Pilot review rejects cross-session turns and reports missing routes", async () => {
  const f = await fixture();
  try {
    const first = (f.service.pilotSessionOpen({ input: "first" }) as JsonObject).session as JsonObject;
    const second = (f.service.pilotSessionOpen({ input: "second" }) as JsonObject).session as JsonObject;
    const turn = f.store.create("pilot_turn", "turn", { session_id: first.id, task_ids: [] });
    assert.throws(() => f.service.pilotReview({ session_id: second.id, turn_id: turn.id }), /does not belong/u);
    f.store.create("pilot_turn", "conflict", { session_id: first.id, task_ids: [] });
    assert.throws(() => f.service.pilotTurnAuto({ session_id: second.id, turn_id: "conflict", input: "x" }), /idempotency conflict/u);

    const task = f.service.taskOpen({ title: "T", goal: "g" }).task as JsonObject;
    f.store.create("pilot_route", "unfinished", { session_id: first.id, task_id: task.id,
      executor_template: "craft", queue_state: "queued", status: "assigned" });
    const review = f.service.pilotReview({ session_id: first.id }) as JsonObject;
    assert.equal(review.verdict, "pass");
    assert.equal(review.idempotent, false);
    assert.equal((f.service.pilotReview({ session_id: first.id }) as JsonObject).idempotent, true);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Pilot settles Worker observations and releases the route slot", async () => {
  const f = await fixture();
  try {
    const session = (f.service.pilotSessionOpen({ input: "worker", workspace_id: f.workspaceId }) as JsonObject).session as JsonObject;
    const task = f.service.taskOpen({ title: "T", goal: "g", workspace_id: f.workspaceId }).task as JsonObject;
    const route = (f.service.pilotTaskRoute({ session_id: session.id, task_id: task.id,
      executor_template: "codex", reason: "test", confidence: 0.9 }) as JsonObject).route as JsonObject;
    f.service.pilotSchedule({ session_id: session.id });
    const started = f.service.pilotWorkerBind({ route_id: route.id, provider: "codex",
      state: "started", link_id: "link-1" }) as JsonObject;
    assert.equal((started.route as JsonObject).queue_state, "running");
    assert.equal(((started.route as JsonObject).worker as JsonObject).link_id, "link-1");
    assert.equal(started.worker_has_execution_authority, false);
    assert.equal((f.service.pilotWorkerBind({ route_id: route.id, provider: "codex",
      state: "started", link_id: "link-1" }) as JsonObject).idempotent, true);

    const waiting = f.service.pilotWorkerBind({ route_id: route.id, provider: "codex",
      state: "awaiting_approval", link_id: "link-1", work_loop_id: "loop-1" }) as JsonObject;
    assert.equal((waiting.route as JsonObject).queue_state, "blocked");
    assert.equal(((waiting.route as JsonObject).worker as JsonObject).work_loop_id, "loop-1");
    const unknown = f.service.pilotWorkerBind({ route_id: route.id, provider: "codex",
      state: "unknown", link_id: "link-1", work_loop_id: "loop-1", reason: "run outcome not confirmed" }) as JsonObject;
    assert.equal((unknown.route as JsonObject).status, "blocked");
    assert.equal((unknown.route as JsonObject).queue_state, "blocked");
    f.service.pilotWorkerBind({ route_id: route.id, provider: "codex", state: "started", link_id: "link-1", work_loop_id: "loop-1" });

    const failed = f.service.pilotWorkerBind({ route_id: route.id, provider: "codex",
      state: "failed", reason: "CLI missing" }) as JsonObject;
    assert.equal((failed.route as JsonObject).queue_state, "finished");
    assert.equal((failed.route as JsonObject).status, "failed");
    assert.equal((failed.route as JsonObject).finished_at !== undefined, true);
    const status = f.service.pilotSessionStatus({ session_id: session.id }) as JsonObject;
    assert.equal((status.progress as JsonObject).stage, "needs_attention");
    assert.equal(((status.progress as JsonObject).counts as JsonObject).failed, 1);
    assert.throws(() => f.service.pilotWorkerBind({ route_id: route.id, provider: "codex", state: "other" }), /unsupported/u);
    assert.throws(() => f.service.pilotWorkerBind({ route_id: route.id, provider: "codex", state: "completed" }), /only an admitted or started route can complete/u);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Pilot reconciles native links without re-sending work and admits the next queued task", async () => {
  const f = await fixture();
  try {
    const session = (f.service.pilotSessionOpen({ input: "fan out", workspace_id: f.workspaceId, concurrency: 1 }) as JsonObject).session as JsonObject;
    const firstTask = f.service.taskOpen({ title: "First", goal: "1", workspace_id: f.workspaceId }).task as JsonObject;
    const secondTask = f.service.taskOpen({ title: "Second", goal: "2", workspace_id: f.workspaceId }).task as JsonObject;
    const firstRoute = (f.service.pilotTaskRoute({ session_id: session.id, task_id: firstTask.id,
      executor_template: "codex", reason: "first", confidence: 1 }) as JsonObject).route as JsonObject;
    const secondRoute = (f.service.pilotTaskRoute({ session_id: session.id, task_id: secondTask.id,
      executor_template: "codex", reason: "second", confidence: 1 }) as JsonObject).route as JsonObject;
    f.service.pilotSchedule({ session_id: session.id });
    f.service.pilotWorkerBind({ route_id: firstRoute.id, provider: "codex", state: "started" });
    const link = f.store.create("workbench_agent_session_link", "link-1", {
      task_id: firstTask.id, provider: "codex", native_session_id: "native", workspace: f.workspaceId,
      model: null, permission: "ask", turn_state: "idle", operation_id: null, turn_id: null,
      last_turn_id: "turn", last_turn_status: "completed",
    });
    const reconciled = f.service.pilotSessionReconcile({ session_id: session.id }) as JsonObject;
    assert.equal((reconciled.progress as JsonObject).stage, "working");
    const routeById = new Map((reconciled.routes as JsonObject[]).map((item) => [String(item.id), item]));
    assert.equal((routeById.get(String(firstRoute.id)) as JsonObject).queue_state, "finished");
    assert.equal((routeById.get(String(firstRoute.id)) as JsonObject).worker &&
      ((routeById.get(String(firstRoute.id)) as JsonObject).worker as JsonObject).state, "completed");
    assert.equal(routeWorker(routeById.get(String(firstRoute.id)) as JsonObject)?.link_id, String(link.id));
    assert.equal((routeById.get(String(secondRoute.id)) as JsonObject).queue_state, "running");
    assert.deepEqual(f.service.pilotSessionReconcile({ session_id: session.id }) as JsonObject, reconciled);
    f.service.pilotWorkerBind({ route_id: secondRoute.id, provider: "codex", state: "started" });
    f.store.save("workbench_agent_session_link", String(link.id), {
      ...(link as JsonObject), turn_state: "unknown", last_turn_status: null,
    });
    const second = routeWorker(routeById.get(String(secondRoute.id)) as JsonObject);
    const secondLink = f.store.create("workbench_agent_session_link", "link-2", {
      task_id: secondTask.id, provider: "codex", native_session_id: "native-2", workspace: f.workspaceId,
      model: null, permission: "ask", turn_state: "unknown", operation_id: null, turn_id: null,
    });
    const unknown = f.service.pilotSessionReconcile({ session_id: session.id }) as JsonObject;
    const updatedRoute = (unknown.routes as JsonObject[]).find((item) => String(item.id) === String(secondRoute.id)) as JsonObject;
    assert.equal((updatedRoute.worker as JsonObject).state, "failed");
    assert.match(String((updatedRoute.worker as JsonObject).reason), /未确认/u);
    assert.equal(second, null);
    assert.throws(() => f.service.pilotSessionReconcile({ session_id: "missing" }), /missing/u);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
