import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-pilot-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  const dir = join(root, "repo"); await mkdir(dir);
  const workspace = (service.workspaceResolveOrCreate({ root_path: dir }) as JsonObject).workspace as JsonObject;
  return { root, store, service, workspaceId: String(workspace.id) };
}

test("pilot sessions record an input digest and enforce a 1..8 concurrency limit", async () => {
  const f = await fixture();
  try {
    const session = (f.service.pilotSessionOpen({ input: "build a release", workspace_id: f.workspaceId }) as JsonObject).session as JsonObject;
    assert.equal(session.status, "open");
    assert.equal(session.concurrency_limit, 3);
    assert.equal(session.content_stored, false);
    assert.equal(typeof session.input_digest, "string");
    assert.equal("input" in session, false);
    assert.throws(() => f.service.pilotSessionOpen({ input: "x", concurrency: 9 }), /between 1 and 8/);
    assert.throws(() => f.service.pilotSessionOpen({ input: "x", concurrency: 0 }), /between 1 and 8/);
    const again = f.service.pilotSessionOpen({ input: "build a release", workspace_id: f.workspaceId }) as JsonObject;
    assert.equal(again.idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("pilot route assignment preserves reassignment history and cannot change after start", async () => {
  const f = await fixture();
  try {
    const session = (f.service.pilotSessionOpen({ input: "do two things", workspace_id: f.workspaceId }) as JsonObject).session as JsonObject;
    const task = f.service.taskOpen({ title: "T", goal: "g", workspace_id: f.workspaceId }).task as JsonObject;
    const route = (f.service.pilotTaskRoute({ session_id: session.id, task_id: task.id, executor_template: "craft-internal", reason: "local model", confidence: 0.7 }) as JsonObject).route as JsonObject;
    assert.equal(route.executor_template, "craft-internal");
    assert.equal(route.status, "assigned");
    assert.equal((route.history as JsonObject[]).length, 1);
    const reassigned = (f.service.pilotTaskReassign({ route_id: route.id, executor_template: "codex-cli", reason: "needs tool use", confidence: 0.9 }) as JsonObject).route as JsonObject;
    assert.equal(reassigned.executor_template, "codex-cli");
    assert.equal(reassigned.reassignment_count, 1);
    const history = reassigned.history as JsonObject[];
    assert.deepEqual(history.map((item) => item.executor_template), ["craft-internal", "codex-cli"]);
    f.service.pilotRouteStart({ route_id: route.id });
    assert.throws(() => f.service.pilotTaskReassign({ route_id: route.id, executor_template: "x", reason: "late", confidence: 1 }), /only an assigned route/);
    const view = f.service.pilotSessionGet({ session_id: session.id }) as JsonObject;
    assert.equal((view.routes as JsonObject[]).length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("pilot routing validates task, session and confidence", async () => {
  const f = await fixture();
  try {
    const session = (f.service.pilotSessionOpen({ input: "x" }) as JsonObject).session as JsonObject;
    const task = f.service.taskOpen({ title: "T", goal: "g" }).task as JsonObject;
    assert.throws(() => f.service.pilotTaskRoute({ session_id: session.id, task_id: "missing", executor_template: "e", reason: "r", confidence: 0.5 }), /task/);
    assert.throws(() => f.service.pilotTaskRoute({ session_id: session.id, task_id: task.id, executor_template: "e", reason: "r", confidence: 2 }), /confidence/);
    assert.throws(() => f.service.pilotTaskRoute({ session_id: "missing", task_id: task.id, executor_template: "e", reason: "r", confidence: 0.5 }), /missing/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("pilot turn intake blocks on questions and otherwise creates ordinary tasks with routes", async () => {
  const f = await fixture();
  try {
    const session = (f.service.pilotSessionOpen({ input: "ship it", workspace_id: f.workspaceId }) as JsonObject).session as JsonObject;
    // Blocking questions create no task.
    const blocked = f.service.pilotTurnSubmit({ session_id: session.id, input: "ship it",
      split: [{ title: "A", goal: "a", blocking_questions: ["which workspace?"] }] }) as JsonObject;
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.tasks_created, 0);
    assert.equal(f.store.list("task", 100).length, 0);
    // A clean split creates tasks bound to the workspace, with routes.
    const created = f.service.pilotTurnSubmit({ session_id: session.id, input: "ship it", split: [
      { title: "Draft", goal: "draft the plan", workspace_id: f.workspaceId, executor_template: "craft-internal", reason: "local", confidence: 0.8 },
      { title: "Review", goal: "review the diff", workspace_id: f.workspaceId },
    ] }) as JsonObject;
    assert.equal(created.status, "created");
    assert.equal(created.tasks_created, 2);
    const routes = (f.service.pilotSessionGet({ session_id: session.id }) as JsonObject).routes as JsonObject[];
    assert.equal(routes.length, 1);
    assert.equal(routes[0].executor_template, "craft-internal");
    // Over the task limit and closed sessions are refused.
    assert.throws(() => f.service.pilotTurnSubmit({ session_id: session.id, input: "x", split: Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, goal: "g" })) }), /1 and 8/);
    f.service.pilotSessionClose({ session_id: session.id });
    assert.throws(() => f.service.pilotTurnSubmit({ session_id: session.id, input: "x", split: [{ title: "t", goal: "g" }] }), /closed/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("pilot concurrency admits up to the limit, keeps the rest queued, and frees slots on finish", async () => {
  const f = await fixture();
  try {
    const session = (f.service.pilotSessionOpen({ input: "fan out", workspace_id: f.workspaceId, concurrency: 2 }) as JsonObject).session as JsonObject;
    const routeFor = (title: string) => {
      const task = f.service.taskOpen({ title, goal: "g", workspace_id: f.workspaceId }).task as JsonObject;
      return (f.service.pilotTaskRoute({ session_id: session.id, task_id: task.id, executor_template: "craft-internal", reason: "local", confidence: 0.5 }) as JsonObject).route as JsonObject;
    };
    const routes = [routeFor("a"), routeFor("b"), routeFor("c")];
    const admitted = f.service.pilotSchedule({ session_id: session.id }) as JsonObject;
    assert.equal((admitted.admitted as JsonObject[]).length, 2);
    assert.equal(admitted.running, 2);
    assert.equal(admitted.queued, 1);
    const firstQueue = f.service.pilotQueue({ session_id: session.id }) as JsonObject;
    assert.equal((firstQueue.running as JsonObject[]).length, 2);
    assert.equal((firstQueue.queued as JsonObject[]).length, 1);
    // Finishing a running route frees a slot for the next schedule pass.
    const runningRoute = (admitted.admitted as JsonObject[])[0]!;
    f.service.pilotFinish({ route_id: runningRoute.id as string });
    const second = f.service.pilotSchedule({ session_id: session.id }) as JsonObject;
    assert.equal((second.admitted as JsonObject[]).length, 1);
    assert.throws(() => f.service.pilotFinish({ route_id: runningRoute.id as string }), /running route/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("supervisor rules hard-gate (pause/block); the model only advises and cannot pass or block", async () => {
  const f = await fixture();
  try {
    f.service.supervisorProfileSave({ supervisor_profile_id: "sup-a", name: "A",
      deterministic_rules: [{ id: "r-block", condition: "touches_production", action: "block" }, { id: "r-pause", condition: "ci_failed", action: "pause" }] });
    const session = (f.service.pilotSessionOpen({ input: "run", workspace_id: f.workspaceId }) as JsonObject).session as JsonObject;
    const task = f.service.taskOpen({ title: "T", goal: "g", workspace_id: f.workspaceId }).task as JsonObject;
    const route = (f.service.pilotTaskRoute({ session_id: session.id, task_id: task.id, executor_template: "craft-internal", reason: "local", confidence: 0.6 }) as JsonObject).route as JsonObject;
    // No rule fires: pass, even if the model says stop.
    const pass = f.service.pilotSupervise({ route_id: route.id, supervisor_profile_id: "sup-a", signals: { ci_failed: false }, model_advice: "建议停止" }) as JsonObject;
    assert.equal(pass.verdict, "pass");
    assert.equal(pass.model_has_authority, false);
    // A pause rule fires from its own signal.
    const paused = f.service.pilotSupervise({ route_id: route.id, supervisor_profile_id: "sup-a", signals: { ci_failed: true } }) as JsonObject;
    assert.equal(paused.verdict, "pause");
    assert.deepEqual(paused.triggered_rule_ids, ["r-pause"]);
    // A block rule outranks pause.
    const blocked = f.service.pilotSupervise({ route_id: route.id, supervisor_profile_id: "sup-a", signals: { ci_failed: true, touches_production: true } }) as JsonObject;
    assert.equal(blocked.verdict, "block");
    assert.ok((blocked.triggered_rule_ids as string[]).includes("r-block"));
    // A model suggestion cannot be a rule condition.
    assert.throws(() => f.service.supervisorProfileSave({ name: "bad", deterministic_rules: [{ id: "r", condition: "model_says_no", action: "permit" }] }), /pause or block/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("pilot rejects empty ids, is idempotent and tolerates legacy records", async () => {
  const f = await fixture();
  try {
    const session = (f.service.pilotSessionOpen({ input: "x" }) as JsonObject).session as JsonObject;
    const task = f.service.taskOpen({ title: "T", goal: "g" }).task as JsonObject;
    assert.throws(() => f.service.pilotTaskRoute({ session_id: " ", task_id: task.id, executor_template: "e", reason: "r", confidence: 0.5 }), /session_id/);
    // The same route id is idempotent.
    const first = f.service.pilotTaskRoute({ route_id: "r1", session_id: session.id, task_id: task.id, executor_template: "e", reason: "r", confidence: 0.5 }) as JsonObject;
    const again = f.service.pilotTaskRoute({ route_id: "r1", session_id: session.id, task_id: task.id, executor_template: "e", reason: "r", confidence: 0.5 }) as JsonObject;
    assert.equal(again.idempotent, true);
    assert.equal((first.route as JsonObject).id, (again.route as JsonObject).id);
    // A legacy route without history is reassignable.
    f.store.create("pilot_route", "legacy", { session_id: session.id, task_id: task.id, status: "assigned", queue_state: "queued" });
    const reassigned = f.service.pilotTaskReassign({ route_id: "legacy", executor_template: "e2", reason: "r", confidence: 0.4 }) as JsonObject;
    assert.equal(((reassigned.route as JsonObject).history as JsonObject[]).length, 1);
    // start refuses a route that is not assigned.
    f.service.pilotRouteStart({ route_id: "r1" });
    assert.throws(() => f.service.pilotRouteStart({ route_id: "r1" }), /assigned route can start/);
    // A session without a concurrency limit falls back to the default.
    f.store.create("pilot_session", "legacy-session", { status: "open" });
    assert.equal((f.service.pilotSchedule({ session_id: "legacy-session" }) as JsonObject).limit, 3);
    assert.equal((f.service.pilotQueue({ session_id: "legacy-session" }) as JsonObject).limit, 3);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("supervision treats missing signals as empty and only truthy signals fire", async () => {
  const f = await fixture();
  try {
    const session = (f.service.pilotSessionOpen({ input: "x" }) as JsonObject).session as JsonObject;
    const task = f.service.taskOpen({ title: "T", goal: "g" }).task as JsonObject;
    const route = (f.service.pilotTaskRoute({ session_id: session.id, task_id: task.id, executor_template: "e", reason: "r", confidence: 0.5 }) as JsonObject).route as JsonObject;
    // A profile without rules passes.
    f.store.create("supervisor_profile", "empty-profile", { name: "none" });
    assert.equal((f.service.pilotSupervise({ route_id: route.id, supervisor_profile_id: "empty-profile" }) as JsonObject).verdict, "pass");
    // Missing signals default to empty; arrays are refused.
    f.store.create("supervisor_profile", "sp2", { name: "S",
      deterministic_rules: [{ id: "r-empty", condition: "", action: "block" }, { id: "r-missing", condition: "absent", action: "pause" }] });
    assert.equal((f.service.pilotSupervise({ route_id: route.id, supervisor_profile_id: "sp2" }) as JsonObject).verdict, "pass");
    assert.throws(() => f.service.pilotSupervise({ route_id: route.id, supervisor_profile_id: "sp2", signals: [] as never }), /signals must be an object/);
    // Only truthy signals fire: empty string and the literal "false" do not.
    f.store.create("supervisor_profile", "sp3", { name: "S", deterministic_rules: [{ id: "r", condition: "flag", action: "block" }] });
    assert.equal((f.service.pilotSupervise({ route_id: route.id, supervisor_profile_id: "sp3", signals: { flag: "" } }) as JsonObject).verdict, "pass");
    assert.equal((f.service.pilotSupervise({ route_id: route.id, supervisor_profile_id: "sp3", signals: { flag: "false" } }) as JsonObject).verdict, "pass");
    assert.equal((f.service.pilotSupervise({ route_id: route.id, supervisor_profile_id: "sp3", signals: { flag: "yes" } }) as JsonObject).verdict, "block");
    assert.equal((f.service.pilotSupervise({ route_id: route.id, supervisor_profile_id: "sp3", signals: { flag: true } }) as JsonObject).verdict, "block");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
