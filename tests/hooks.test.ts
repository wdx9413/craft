import assert from "node:assert/strict";
import test from "node:test";
import { defineHook, defineHooks, planHooks, runHooks, runHooksSync, BUILTIN_HOOK_TARGETS } from "../core/hooks.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

test("defineHook validates all fields", () => {
  const h = defineHook({ id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log" });
  assert.equal(h.id, "a");
  assert.equal(h.fail_policy, "fail_closed");
  assert.equal(h.timeout_ms, 5000);
  assert.throws(() => defineHook({ id: "", point: "before_step", kind: "builtin", target: "builtin:audit-log" }), /hook id/);
  assert.throws(() => defineHook({ id: "bad id!", point: "before_step", kind: "builtin", target: "builtin:audit-log" }), /Unsupported hook id/);
  assert.throws(() => defineHook({ id: "a", point: "unknown", kind: "builtin", target: "builtin:audit-log" }), /Unsupported hook point/);
  assert.throws(() => defineHook({ id: "a", point: "before_step", kind: "unknown", target: "x" }), /Unsupported hook kind/);
  assert.throws(() => defineHook({ id: "a", point: "before_step", kind: "builtin", target: "unknown" }), /Unsupported builtin hook target/);
  assert.throws(() => defineHook({ id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log", fail_policy: "unknown" }), /Unsupported hook fail policy/);
  assert.throws(() => defineHook({ id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log", timeout_ms: 0 }), /between 1 and/);
  assert.throws(() => defineHook({ id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log", timeout_ms: 1.5 }), /between 1 and/);
  assert.throws(() => defineHook({ id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log", timeout_ms: 60_001 }), /between 1 and/);
  assert.throws(() => defineHook({ id: "a", point: "before_step", kind: "builtin", target: "" }), /hook target/);
  assert.throws(() => defineHook({ id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log", fail_policy: "" }), /hook fail_policy/);
  // explicit fail_policy and timeout_ms
  const withPolicy = defineHook({ id: "b", point: "before_step", kind: "builtin", target: "builtin:audit-log", fail_policy: "fail_open", timeout_ms: 10_000 });
  assert.equal(withPolicy.fail_policy, "fail_open");
  assert.equal(withPolicy.timeout_ms, 10_000);
});

test("defineHooks validates arrays and rejects duplicates", () => {
  assert.deepEqual(defineHooks(undefined), []);
  assert.deepEqual(defineHooks(null), []);
  assert.deepEqual(defineHooks([]), []);
  const hooks = defineHooks([{ id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log" }]);
  assert.equal(hooks.length, 1);
  assert.throws(() => defineHooks("bad"), /array/);
  assert.throws(() => defineHooks([null]), /object/);
  assert.throws(() => defineHooks([[]]), /object/);
  assert.throws(() => defineHooks([1]), /object/);
  assert.throws(() => defineHooks([{ id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log" }, { id: "a", point: "after_step", kind: "builtin", target: "builtin:token-meter" }]), /repeat/);
});

test("planHooks filters by point", () => {
  const hooks = defineHooks([
    { id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log" },
    { id: "b", point: "after_step", kind: "builtin", target: "builtin:token-meter" },
  ]);
  assert.equal(planHooks(hooks, "before_step").length, 1);
  assert.equal(planHooks(hooks, "after_step").length, 1);
  assert.throws(() => planHooks(hooks, "unknown"), /Unsupported/);
});

test("runHooks executes hooks and respects fail policies", async () => {
  const hooks = defineHooks([
    { id: "a", point: "before_step", kind: "builtin", target: "builtin:audit-log", fail_policy: "fail_closed" },
    { id: "b", point: "before_step", kind: "builtin", target: "builtin:token-meter", fail_policy: "fail_open" },
  ]);
  const pass = await runHooks(hooks, "before_step", {}, { invoke: () => ({ ok: true }) });
  assert.equal(pass.blocked, false);
  assert.equal(pass.outcomes.length, 2);
  assert.equal(pass.outcomes[0].status, "passed");

  const failClosed = await runHooks(hooks, "before_step", {}, { invoke: (_h) => { throw new Error("boom"); } });
  assert.equal(failClosed.blocked, true);
  assert.equal(failClosed.outcomes.length, 1);
  assert.equal(failClosed.outcomes[0].status, "failed");

  const failOpenHooks = defineHooks([
    { id: "c", point: "after_step", kind: "builtin", target: "builtin:token-meter", fail_policy: "fail_open" },
  ]);
  const failOpen = await runHooks(failOpenHooks, "after_step", {}, { invoke: (_h) => { throw new Error("boom"); } });
  assert.equal(failOpen.blocked, false);
  assert.equal(failOpen.outcomes.length, 1);
  assert.equal(failOpen.outcomes[0].status, "failed");

  const okFalse = await runHooks(hooks, "before_step", {}, { invoke: () => ({ ok: false, detail: "no" }) });
  assert.equal(okFalse.blocked, true);
  assert.equal(okFalse.outcomes[0].status, "failed");

  // non-Error throws fall back to String(error) for the detail message
  const thrown = await runHooks(failOpenHooks, "after_step", {}, { invoke: () => { throw "plain-string"; } });
  assert.equal(thrown.outcomes[0].detail, "plain-string");
  const thrownObj = await runHooks(failOpenHooks, "after_step", {}, { invoke: () => { throw { code: 1 }; } });
  assert.equal(thrownObj.outcomes[0].detail, "[object Object]");
  // invoke returning a non-boolean ok without detail uses the default message
  const reported = await runHooks(failOpenHooks, "after_step", {}, { invoke: () => ({ ok: false }) });
  assert.equal(reported.outcomes[0].detail, "hook reported failure");
});

test("runHooksSync records but does not block a fail-open failure", () => {
  const hooks = defineHooks([{ id: "sync-open", point: "before_step", kind: "builtin", target: "builtin:audit-log", fail_policy: "fail_open" }]);
  const run = runHooksSync(hooks, "before_step", {}, { invoke: () => { throw new Error("observed failure"); } });
  assert.equal(run.blocked, false);
  assert.equal(run.outcomes[0].status, "failed");
});

test("runHooksSync uses default detail and stringifies non-Error failures", () => {
  const hooks = defineHooks([
    { id: "sync-default", point: "before_step", kind: "builtin", target: "builtin:audit-log" },
    { id: "sync-string", point: "after_step", kind: "builtin", target: "builtin:audit-log" },
  ]);
  const defaultDetail = runHooksSync(hooks, "before_step", {}, { invoke: () => ({ ok: false }) });
  assert.equal(defaultDetail.outcomes[0].detail, "hook reported failure");
  const stringFailure = runHooksSync(hooks, "after_step", {}, { invoke: () => { throw "plain sync failure"; } });
  assert.equal(stringFailure.outcomes[0].detail, "plain sync failure");
});
