import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { defineProvider } from "../core/model-gateway.ts";
import { prepareAttemptBudget, workAttemptBudget, assertAttemptBudget, attemptBudgetSignal } from "../core/work-attempt-budget.ts";

async function fixture(unknown = false) {
  const root = await mkdtemp(join(tmpdir(), "craft-attempt-budget-"));
  const store = await new CraftStore(craftPaths(root)).open();
  let calls = 0;
  const provider = defineProvider({ provider: "quoted", protocol: "openai-compatible", base_url: "https://example.test/v1", api_key_env: "MOCK_KEY", models: { standard: "mock" }, pricing: { mock: { version: "fixed", input_usd_per_million: 0, output_usd_per_million: 1 } } });
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, undefined, [provider], { quote: async () => ({ input_tokens_upper_bound: 0 }), complete: async () => { calls++; if (unknown && calls === 1) throw new Error("simulated unknown bill"); return { text: JSON.stringify({ action: "not-an-action", args: {} }), model: "mock", usage: { input_tokens: 0, output_tokens: 1 } }; } });
  const task = service.taskOpen({ title: "Total budget", goal: "bounded attempts" }).task as JsonObject;
  const contract = service.taskControlSave({ task_id: task.id, workspace: root, allowed_effects: ["read_only"] }).contract as JsonObject;
  const prepare = (extra: JsonObject = {}) => service.taskRunPrepare({ contract_id: contract.id, task_run_id: "source", host: "internal", prompt: "inspect", limits: { max_tokens: 1 }, max_turns: 1, ...extra });
  const retry = (runId: string, nextId: string) => { const run = store.get("task_run", runId), launch = store.get("work_launch", String(run.launch_id)); return { task_run_id: runId, task_run_version: run.version, launch_version: launch.version, host_run_version: store.get("host_run", String(launch.run_id)).version, new_task_run_id: nextId, prompt: "repair", actor: "user:owner" }; };
  return { root, store, service, task, contract, prepare, retry, calls: () => calls };
}

test("cumulative USD shrinks each attempt cap and exhaustion blocks new records before the retry-count limit", async () => {
  const f = await fixture();
  try {
    const first = await new McpServer(f.service, "full").handlers.craft_task_run_prepare({ contract_id: f.contract.id, workspace: f.root, task_run_id: "source", host: "internal", prompt: "inspect", limits: { max_tokens: 1 }, max_turns: 1, total_budget_usd: 0.000003, total_timeout_ms: 60000 }) as JsonObject; let launch = first.launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    assert.equal(f.store.get("host_run", String(launch.run_id)).status, "failed");
    for (let i = 1; i <= 2; i++) {
      const source = i === 1 ? "source" : "retry-1";
      assert.throws(() => f.service.taskRunRetry({ ...f.retry(source, `retry-${i}`), total_timeout_ms: 60000 }), /inherits/);
      const next = f.service.taskRunRetry(f.retry(source, `retry-${i}`)); launch = next.launch as JsonObject;
      assert.equal((launch.attempt_budget as JsonObject).deadline_at, ((first.launch as JsonObject).attempt_budget as JsonObject).deadline_at);
      assert.equal(f.store.get("internal_dispatch", String(launch.dispatch_id)).max_budget_usd, i === 1 ? 0.000002 : 0.000001);
      await f.service.hostRuns.wait(String(launch.run_id));
    }
    const scope = workAttemptBudget(f.store, f.store.get("work_launch", String(launch.id)))!;
    assert.equal(workAttemptBudget(f.store, f.store.get("work_launch", String((first.launch as JsonObject).id)))!.spent_usd, 0.000003);
    assert.equal(scope.spent_usd, 0.000003); assert.equal(scope.remaining_usd, 0); assert.equal(scope.exhausted, true); assert.equal(f.calls(), 3);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "retry-2" }).state as JsonObject).status, "attempt_budget_exhausted");
    assert.throws(() => f.service.taskRunRetry(f.retry("retry-2", "no-fourth")), /budget is exhausted/);
    assert.equal(f.store.find("task_run", "no-fourth"), null);
    f.service.attentionRefresh({});
    assert.equal((f.service.attentionList({}).items as JsonObject[]).filter(item => item.action === "replan_with_evidence").length, 1);
    const home = f.service.homeTask({ task_id: f.task.id });
    assert.equal(((home.task_runs as JsonObject[]).find(item => item.id === "retry-2")!.attempt_budget as JsonObject).spent_usd, 0.000003);
    assert.equal(f.service.workLaunchPrepare({ task_id: f.task.id, launch_id: (first.launch as JsonObject).id, host: "internal", workspace: f.root, prompt: "inspect", total_budget_usd: 0.000003, total_timeout_ms: 60000, max_turns: 1, limits: { max_tokens: 1 } }).idempotent, true);
    f.service.taskRunCancel({ task_run_id: "retry-2", reason: "stop working on this chain", actor: "user:owner" });
    f.service.attentionRefresh({});
    assert.equal((f.service.attentionList({}).items as JsonObject[]).filter(item => item.action === "replan_with_evidence").length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("unknown cost stays reserved across attempts and explicit overrun accounting does not enlarge the total cap", async () => {
  const f = await fixture(true);
  try {
    const first = f.prepare({ total_budget_usd: 0.000003 }); const launch = first.launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const scope = workAttemptBudget(f.store, f.store.get("work_launch", String(launch.id)))!;
    assert.equal(scope.unknown_reservations, 1); assert.equal(scope.reserved_usd, 0.000001);
    assert.throws(() => f.service.taskRunRetry(f.retry("source", "unknown-next")), /cost is unresolved/);
    const hold = (f.service.homeTask({ task_id: f.task.id }).model_cost_holds as JsonObject[])[0];
    f.service.modelCostReconcile({ dispatch_id: hold.dispatch_id, dispatch_version: hold.dispatch_version, reservation_id: hold.reservation_id, reservation_version: hold.reservation_version, actual_usd: 0.000005, confirmed_billing: true, confirmed_overrun: true, actor: "user:owner", billing_reference: "simulated-total-overrun" });
    const updated = workAttemptBudget(f.store, f.store.get("work_launch", String(launch.id)))!;
    assert.equal(updated.remaining_usd, -0.000002); assert.equal(updated.total_budget_usd, 0.000003);
    assert.throws(() => f.service.taskRunRetry(f.retry("source", "overrun-next")), /budget is exhausted/);
    assert.equal(f.calls(), 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("total deadline includes approval waits, blocks direct execution, and cancels in-flight CLI work", async (t) => {
  const f = await fixture();
  try {
    const write = f.service.taskControlSave({ contract_id: "write-budget", task_id: f.task.id, workspace: f.root, allowed_effects: ["local_write"] }).contract as JsonObject;
    const pending = f.prepare({ contract_id: write.id, host: "codex-cli", sandbox: "workspace-write", limits: undefined, total_timeout_ms: 1000 });
    const launch = pending.launch as JsonObject, saved = f.store.get("work_launch", String(launch.id));
    const now = t.mock.method(Date, "now", () => Date.parse(String((saved.attempt_budget as JsonObject).deadline_at)) + 1);
    assert.throws(() => f.service.workLaunchDecide({ launch_id: launch.id, approved: true, actor: "user:owner", prompt: "inspect" }), /budget is exhausted/);
    await assert.rejects(() => f.service.codexHost.execute({ dispatch_id: launch.dispatch_id, prompt: "inspect" }), /budget is exhausted/);
    assert.equal(f.store.list("autonomy_consumption", 100).length, 0);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "source" }).state as JsonObject).status, "attempt_budget_exhausted");
    now.mock.restore();
    const task = f.service.taskOpen({ title: "Live deadline", goal: "stop" }).task as JsonObject;
    const contract = f.service.taskControlSave({ task_id: task.id, workspace: f.root, allowed_effects: ["read_only"] }).contract as JsonObject;
    let aborted = false;
    f.service.codexHost.executor = request => new Promise((resolve, reject) => { const watchdog = setTimeout(() => reject(new Error("Total deadline did not abort the simulated process")), 5000); request.signal!.addEventListener("abort", () => { clearTimeout(watchdog); aborted = true; resolve({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false }); }, { once: true }); });
    const live = f.service.taskRunPrepare({ task_run_id: "live", contract_id: contract.id, host: "codex-cli", prompt: "wait", total_timeout_ms: 1000 }).launch as JsonObject;
    await f.service.hostRuns.wait(String(live.run_id));
    assert.equal(aborted, true);
    assert.equal((f.service.taskRunRefresh({ task_run_id: "live" }).state as JsonObject).status, "attempt_budget_exhausted");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("zero-value unknown holds still block the cumulative budget until explicit reconciliation", async () => {
  const f = await fixture(true);
  try {
    f.service.internalHost.providers[0]!.pricing = { mock: { version: "free", input_usd_per_million: 0, output_usd_per_million: 0 } };
    const first = f.prepare({ total_budget_usd: 1 }); const launch = first.launch as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    assert.equal(workAttemptBudget(f.store, launch)!.reserved_usd, 0);
    assert.throws(() => assertAttemptBudget(f.store, launch), /unresolved/);
    const hold = (f.service.homeTask({ task_id: f.task.id }).model_cost_holds as JsonObject[])[0];
    f.service.modelCostReconcile({ dispatch_id: hold.dispatch_id, dispatch_version: hold.dispatch_version, reservation_id: hold.reservation_id, reservation_version: hold.reservation_version, actual_usd: 0, confirmed_billing: true, actor: "user:owner", billing_reference: "simulated-free-call" });
    const next = f.service.taskRunRetry(f.retry("source", "no-charge-next")).launch as JsonObject;
    await f.service.hostRuns.wait(String(next.run_id));
    assert.equal(workAttemptBudget(f.store, next)!.spent_usd, 0); assert.equal(workAttemptBudget(f.store, next)!.remaining_usd, 1); assert.equal(f.calls(), 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("attempt budget helpers preserve legacy behavior, reject corrupt contracts and ledgers, and combine signals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "craft-attempt-policy-")); const store = await new CraftStore(craftPaths(root)).open();
  try {
    const rootLaunch = store.create("work_launch", "root", { task_id: "task", host: "internal", dispatch_id: "d", retry_of: null });
    store.create("internal_dispatch", "d", { turns_started: 0 });
    assert.equal(workAttemptBudget(store, rootLaunch), null);
    assert.equal(assertAttemptBudget(store, rootLaunch), null);
    assert.equal(prepareAttemptBudget(store, { host: "internal" }, "unlimited").contract, null);
    assert.equal(prepareAttemptBudget(store, { host: "internal", retry_of: "root" }, "legacy-retry").contract, null);
    const incoming = new AbortController().signal;
    assert.equal(attemptBudgetSignal(store, { id: "not-bound" }, incoming), incoming);
    assert.equal(attemptBudgetSignal(store, { id: "d" }, incoming), incoming);
    for (const value of [0, -1, "1", NaN, Infinity]) assert.throws(() => prepareAttemptBudget(store, { total_budget_usd: value, host: "internal" }, "bad"));
    for (const value of [1, 999, 1.5, 86400001]) assert.throws(() => prepareAttemptBudget(store, { total_timeout_ms: value }, "bad"));
    assert.throws(() => prepareAttemptBudget(store, { total_budget_usd: 1, host: "codex-cli" }, "bad"), /internal Host/);
    for (const values of [{ total_timeout_ms: 1000 }, { total_budget_usd: 1 }]) assert.throws(() => prepareAttemptBudget(store, { host: "internal", retry_of: "root", ...values }, "bad"), /inherits/);
    const contract = prepareAttemptBudget(store, { host: "internal", total_budget_usd: 1, total_timeout_ms: 1000, max_budget_usd: 0.25 }, "root").contract!;
    assert.equal(prepareAttemptBudget(store, { host: "internal", total_budget_usd: 1, max_budget_usd: 0.25 }, "other").maxBudgetUsd, 0.25);
    let launch = store.save("work_launch", "root", { ...rootLaunch, attempt_budget: contract });
    assert.equal(workAttemptBudget(store, launch)!.spent_usd, 0);
    assert.ok(attemptBudgetSignal(store, { id: "d" })); assert.ok(attemptBudgetSignal(store, { id: "d" }, incoming));
    assert.equal(prepareAttemptBudget(store, { host: "internal", retry_of: "root" }, "child").maxBudgetUsd, 1);
    const timeOnly = prepareAttemptBudget(store, { host: "internal", total_timeout_ms: 1000 }, "root").contract!;
    launch = store.save("work_launch", "root", { ...rootLaunch, attempt_budget: timeOnly });
    assert.equal(prepareAttemptBudget(store, { host: "internal", retry_of: "root", max_budget_usd: 0.1 }, "child").maxBudgetUsd, 0.1);
    const usdOnly = prepareAttemptBudget(store, { host: "internal", total_budget_usd: 1 }, "root").contract!;
    launch = store.save("work_launch", "root", { ...rootLaunch, attempt_budget: usdOnly });
    assert.equal(attemptBudgetSignal(store, { id: "d" }, incoming), incoming);
    for (const patch of [{ root_launch_id: "foreign" }, { deadline_at: "bad", total_timeout_ms: 1000 }, { deadline_at: null, total_timeout_ms: 1000 }, { deadline_at: new Date().toISOString() }, { total_budget_usd: undefined }, { total_timeout_ms: undefined }]) {
      launch = store.save("work_launch", "root", { ...rootLaunch, attempt_budget: { ...usdOnly, ...patch } });
      assert.throws(() => workAttemptBudget(store, launch));
    }
    launch = store.save("work_launch", "root", { ...rootLaunch, attempt_budget: usdOnly, host: "codex-cli" });
    assert.throws(() => workAttemptBudget(store, launch), /unsupported Host/);
    launch = store.save("work_launch", "root", { ...rootLaunch, attempt_budget: usdOnly });
    store.save("internal_dispatch", "d", { turns_started: 1 });
    assert.throws(() => workAttemptBudget(store, launch), /ledger is missing/);
    for (const data of [{ owner_type: "wrong", owner_id: "d", used: {}, reserved: {} }, { owner_type: "internal_dispatch", owner_id: "other", used: {}, reserved: {} }, { owner_type: "internal_dispatch", owner_id: "d", used: { usd: -1 }, reserved: {} }, { owner_type: "internal_dispatch", owner_id: "d", used: {}, reserved: { usd: -1 } }, { owner_type: "internal_dispatch", owner_id: "d", used: { usd: "not-money" }, reserved: {} }, { owner_type: "internal_dispatch", owner_id: "d", used: {}, reserved: { usd: "not-money" } }]) {
      store.save("budget_account", "internal_budget_d", data);
      assert.throws(() => workAttemptBudget(store, launch), /corrupt/);
    }
    store.save("budget_account", "internal_budget_d", { owner_type: "internal_dispatch", owner_id: "d", used: { usd: 1 }, reserved: {} });
    assert.throws(() => prepareAttemptBudget(store, { host: "internal", retry_of: "root" }, "exhausted"), /exhausted/);
    const originalList = store.list.bind(store);
    for (const mode of ["cycle", "foreign", "bound"]) {
      let counter = 0;
      const corruptChildren = t.mock.method(store, "list", (...args: Parameters<typeof store.list>) => args[0] === "work_launch" ? [{ ...rootLaunch, id: mode === "cycle" ? "root" : `node-${++counter}`, task_id: mode === "foreign" ? "other" : "task" }] : originalList(...args));
      assert.throws(() => workAttemptBudget(store, launch), /descendants are corrupt/); corruptChildren.mock.restore();
    }
    store.create("internal_dispatch", "child-dispatch", { turns_started: 0 });
    store.create("work_launch", "child", { task_id: "task", host: "internal", dispatch_id: "child-dispatch", retry_of: "root" });
    assert.equal(workAttemptBudget(store, launch)!.spent_usd, 1);
    store.create("work_launch", "sibling", { task_id: "task", host: "internal", dispatch_id: "sibling-dispatch", retry_of: "root" });
    assert.throws(() => workAttemptBudget(store, launch), /competing successors/);
    store.create("work_launch", "duplicate", { ...rootLaunch });
    assert.throws(() => attemptBudgetSignal(store, { id: "d" }), /ambiguous/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
