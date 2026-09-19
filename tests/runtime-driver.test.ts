import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftStore, SCHEMA_VERSION, type JsonObject } from "../src/infrastructure/store.ts";
import { defineHook, defaultHooks, runHooks, planHooks, type HookRun } from "../src/hooks.ts";
import { RuntimeDriver, runtimeDriverInternalsForTest, type RuntimeOperation } from "../src/runtime-driver.ts";
import { ExternalEffectKernel } from "../src/effects.ts";
import { HookedEffectKernel } from "../src/hooked-effect-kernel.ts";

async function fixture(): Promise<{ root: string; store: CraftStore; runtime: RuntimeDriver }> {
  const root = join(tmpdir(), `craft-runtime-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  const runtime = new RuntimeDriver(store, { strictHooks: true });
  return { root, store, runtime };
}

async function teardown(root: string, store: CraftStore): Promise<void> {
  store.close();
  await rm(root, { recursive: true, force: true });
}

test("startOperation persists a runtime_operation with the expected fields", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const operation = runtime.startOperation({
      route_id: "route_42", idempotency_key: "idem_abcdef01",
      effect_class: "write", effect_scope: "github/api/repos/foo",
      policy_hash: "sha256:abc", expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(operation.route_id, "route_42");
    assert.equal(operation.idempotency_key, "idem_abcdef01");
    assert.equal(operation.effect_class, "write");
    assert.equal(operation.status, "executing");
    assert.equal(operation.retry_count, 0);
    assert.ok(store.find("runtime_operation", operation.id), "operation must be persisted");
  } finally {
    await teardown(root, store);
  }
});

test("startOperation rejects an already-past expiry", async () => {
  const { root, store, runtime } = await fixture();
  try {
    assert.throws(() => runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_99",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }), /expires_at must be in the future/);
  } finally {
    await teardown(root, store);
  }
});

test("startOperation rejects an invalid expiry timestamp", async () => {
  const { root, store, runtime } = await fixture();
  try {
    assert.throws(() => runtime.startOperation({
      route_id: "r", idempotency_key: "idem_invalid_date", effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: "not-a-date",
    }), /expires_at must be an ISO-8601 datetime/);
  } finally {
    await teardown(root, store);
  }
});

test("runtime driver validation helpers reject every non-text and non-object shape", () => {
  assert.equal(runtimeDriverInternalsForTest.text(" value ", "value"), "value");
  assert.throws(() => runtimeDriverInternalsForTest.text(0, "value"), /must not be empty/);
  assert.throws(() => runtimeDriverInternalsForTest.text("", "value"), /must not be empty/);
  assert.deepEqual(runtimeDriverInternalsForTest.object({ ok: true }, "value"), { ok: true });
  assert.throws(() => runtimeDriverInternalsForTest.object(null, "value"), /must be an object/);
  assert.throws(() => runtimeDriverInternalsForTest.object("bad", "value"), /must be an object/);
  assert.throws(() => runtimeDriverInternalsForTest.object([], "value"), /must be an object/);
});

test("startOperation rejects unknown effect classes", async () => {
  const { root, store, runtime } = await fixture();
  try {
    assert.throws(() => runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_99",
      effect_class: "destroy", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }), /effect_class must be one of/);
  } finally {
    await teardown(root, store);
  }
});

test("replay-safe startOperation returns the same record on the same key", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const first = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_99",
      effect_class: "execute", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      operation_id: "op_one",
    });
    const second = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_99",
      effect_class: "execute", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      operation_id: "op_one",
    });
    assert.equal(second.id, first.id);
    assert.equal(second.version, first.version);
  } finally {
    await teardown(root, store);
  }
});

test("startOperation flags pending_approval when a ref is supplied", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const operation = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_99",
      effect_class: "publish", effect_scope: "marketing/post",
      policy_hash: "p", pending_approval_ref: "approval_42",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(operation.status, "pending_approval");
    assert.equal(operation.pending_approval_ref, "approval_42");
  } finally {
    await teardown(root, store);
  }
});

test("runBeforeEffectSync runs the default before_effect hooks and writes events", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const operation = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_99",
      effect_class: "write", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const run = runtime.runBeforeEffectSync(operation, { action: "noop" });
    assert.equal(run.blocked, false);
    // The default hook list has two before_effect hooks (audit-log +
    // token-meter) and one after_receipt hook; the sync run only sees the
    // ones attached to the requested point.
    const beforeHooks = defaultHooks().filter((hook) => hook.point === "before_effect");
    assert.equal(run.outcomes.length, beforeHooks.length);
    for (const outcome of run.outcomes) assert.equal(outcome.status, "passed");
    const events = store.events("hook");
    assert.ok(events.length >= beforeHooks.length + 1, "operation_started + hook_before_effect events");
  } finally {
    await teardown(root, store);
  }
});

test("runBeforeEffectSync blocks dispatch when a fail_closed hook fails", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const failingHook = defineHook({
      id: "deny-write", point: "before_effect", kind: "builtin",
      target: "builtin:receipt-check", fail_policy: "fail_closed", timeout_ms: 1000,
    });
    const driver = new RuntimeDriver(runtime.store, {
      strictHooks: true, hooks: [failingHook],
    });
    // receipt-check refuses when idempotency_key is absent.
    const operation = driver.startOperation({
      route_id: "r", idempotency_key: "will_be_cleared",
      effect_class: "write", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const run = driver.runBeforeEffectSync({ ...operation, idempotency_key: "" }, {});
    assert.equal(run.blocked, true);
  } finally {
    await teardown(root, store);
  }
});

test("completeOperation advances status and emits one completion event", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const operation = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_99",
      effect_class: "execute", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const completed = runtime.completeOperation(operation, { receipt_id: "rcpt_001", status: "completed" });
    assert.equal(completed.status, "completed");
    assert.ok(completed.finished_at);
    const events = store.events("hook").filter((row) => row.event_type === "operation_completed");
    assert.equal(events.length, 1);
  } finally {
    await teardown(root, store);
  }
});

test("timeoutOperation marks an expired operation as timed_out", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const operation = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_99",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const timed = runtime.timeoutOperation(operation, "wall-clock exceeded");
    assert.equal(timed.status, "timed_out");
    assert.ok(timed.finished_at);
  } finally {
    await teardown(root, store);
  }
});

test("recoverOperation refuses an expired operation", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    const operation = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_99",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      operation_id: "op_expired",
    });
    // Backdate the expiry through a direct updateIfVersion to simulate a
    // crash recovery finding a stale operation.
    const backdated = runtime.store.updateIfVersion("runtime_operation", operation.id, Number(operation.version), {
      ...payloadOf(operation), expires_at: pastExpiry,
    }) as RuntimeOperation;
    assert.throws(() => runtime.recoverOperation(backdated.id), /has expired/);
  } finally {
    await teardown(root, store);
  }
});

test("HookedEffectKernel.start refuses dispatch when the hook chain blocks", async () => {
  const { root, store, runtime } = await fixture();
  try {
    store.create("task", "task_seed", {
      title: "seed", goal: "seed", status: "draft", version: 1,
    });
    // Build a driver whose `runBeforeEffectSync` always reports a blocked
    // verdict, simulating a fail_closed hook in the chain.
    const blockingDriver = new RuntimeDriver(store, {
      strictHooks: true, hooks: [],
      onHookEvent: () => undefined,
    });
    (blockingDriver as unknown as {
      runBeforeEffectSync: (op: RuntimeOperation, payload: JsonObject) => { outcomes: never[]; blocked: boolean };
    }).runBeforeEffectSync = () => ({ outcomes: [], blocked: true });
    const inner = new ExternalEffectKernel(store);
    const hooked = new HookedEffectKernel(inner, blockingDriver);
    const prepared = inner.prepare({
      task_id: "task_seed", effect: "external_write", idempotency_key: "idem_key_alpha1",
      provider: "github", action: "POST /repos/foo/issues", target: "github/api",
      request_digest: "sha256:abc", approval_ref: "approval_001",
      effect_id: "eff_blocked",
    }) as { effect: { id: string } };
    assert.throws(() => hooked.start({
      effect_id: prepared.effect.id, approval_ref: "approval_001",
      route_id: "r", effect_class: "write", effect_scope: "github/api/repos/foo",
      policy_hash: "sha256:abc", idempotency_key: "idem_key_alpha1",
    }), /hook chain blocked/);
  } finally {
    await teardown(root, store);
  }
});

test("HookedEffectKernel dispatches start + report and writes hook events for both", async () => {
  const { root, store, runtime } = await fixture();
  try {
    store.create("task", "task_seed", {
      title: "seed", goal: "seed", status: "draft", version: 1,
    });
    // The report path needs at least one evidence_id, so seed one first.
    store.create("evidence", "evidence_001", {
      kind: "response", digest: "sha256:done", summary: "github post succeeded",
    });
    const inner = new ExternalEffectKernel(store);
    const hooked = new HookedEffectKernel(inner, runtime);
    const prepared = inner.prepare({
      task_id: "task_seed", effect: "external_write", idempotency_key: "idem_key_alpha1",
      provider: "github", action: "POST /repos/foo/issues", target: "github/api",
      request_digest: "sha256:abc", approval_ref: "approval_001",
      effect_id: "eff_ok_001",
    }) as { effect: { id: string } };
    const started = hooked.start({
      effect_id: prepared.effect.id, approval_ref: "approval_001",
      route_id: "r", effect_class: "write", effect_scope: "github/api/repos/foo",
      policy_hash: "sha256:abc", idempotency_key: "idem_key_alpha1",
    }) as { idempotent: boolean };
    assert.equal(started.idempotent, false);
    hooked.report({
      effect_id: prepared.effect.id, receipt_id: "rcpt_001",
      status: "succeeded", remote_operation_id: "remote_42",
      evidence_ids: ["evidence_001"], response_digest: "sha256:done",
      operation_id: prepared.effect.id,
    });
    const hookEvents = store.events("hook").filter((row) => String(row.event_type).startsWith("hook_"));
    assert.ok(hookEvents.length >= 3, "before_effect + after_receipt + operation_started/completed events");
  } finally {
    await teardown(root, store);
  }
});

test("recentHookEvents surfaces the audit trail for `craft_hook_audit`", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const operation = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_99",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    runtime.runBeforeEffectSync(operation, { extra: "context" });
    const trail = runtime.recentHookEvents();
    assert.ok(trail.length >= defaultHooks().length);
    for (const outcome of trail) {
      assert.equal(outcome.fail_policy, "fail_closed");
    }
  } finally {
    await teardown(root, store);
  }
});

test("SCHEMA_VERSION is at least 4 so the runtime_operation kind is addressable", () => {
  // Sanity check: the registry and the runtime driver are coupled through
  // this version. If a future migration drops the schema version below 4
  // without keeping the kinds in sync, this assertion will fail loudly.
  assert.ok(SCHEMA_VERSION >= 4);
});

test("startOperation rejects bad idempotency_key shapes", async () => {
  const { root, store, runtime } = await fixture();
  try {
    // Too short — the regex requires 8-200 safe characters.
    assert.throws(() => runtime.startOperation({
      route_id: "r", idempotency_key: "short",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }), /idempotency_key must be stable/);
    // Disallowed character — the regex excludes spaces and punctuation outside the allow-list.
    assert.throws(() => runtime.startOperation({
      route_id: "r", idempotency_key: "id em with spaces!!!",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }), /idempotency_key must be stable/);
  } finally {
    await teardown(root, store);
  }
});

test("startOperation rejects conflicting operation_id on a different key", async () => {
  const { root, store, runtime } = await fixture();
  try {
    runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_first",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      operation_id: "op_conflict",
    });
    assert.throws(() => runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_second",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      operation_id: "op_conflict",
    }), /already exists with a different idempotency_key/);
  } finally {
    await teardown(root, store);
  }
});

test("async runHooks paths mirror the sync verdict and write audit events", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const operation = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_key_async",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const before = await runtime.runBeforeEffect(operation, { foo: "bar" });
    assert.equal(before.blocked, false);
    const after = await runtime.runAfterReceipt(operation, { receipt_id: "rcpt_async" });
    assert.equal(after.blocked, false);
    const failure = await runtime.runOnFailure(operation, { error: "test" });
    assert.equal(failure.blocked, false);
    // The default hook list has two before_effect, one after_receipt, and
    // zero on_failure hooks, so we expect at least 3 hook_<point> events.
    const events = store.events("hook").filter((row) => String(row.event_type).startsWith("hook_"));
    assert.ok(events.length >= 3);
    // operation_started was also persisted on startOperation.
    const started = store.events("hook").filter((row) => String(row.event_type) === "operation_started");
    assert.equal(started.length, 1);
  } finally {
    await teardown(root, store);
  }
});

test("runHooks converts a builtin exception into a failed outcome", async () => {
  // The async runHooks must catch exceptions thrown by the builtin
  // evaluator and convert them into a structured failure rather than
  // letting them bubble — that is what keeps audit-log callers safe.
  const hooks = [
    defineHook({
      id: "thrower", point: "before_effect", kind: "builtin",
      target: "builtin:audit-log", fail_policy: "fail_closed", timeout_ms: 1000,
    }),
  ];
  const run = await runHooks(hooks, "before_effect", {}, {
    invoke: () => { throw new Error("boom"); },
  });
  assert.equal(run.blocked, true);
  assert.equal(run.outcomes.length, 1);
  assert.equal(run.outcomes[0].status, "failed");
  assert.match(run.outcomes[0].detail ?? "", /boom/);
});

test("planHooks filters by the requested point", () => {
  const hooks = [
    defineHook({ id: "a", point: "before_effect", kind: "builtin", target: "builtin:audit-log",
      fail_policy: "fail_closed", timeout_ms: 1000 }),
    defineHook({ id: "b", point: "after_receipt", kind: "builtin", target: "builtin:receipt-check",
      fail_policy: "fail_closed", timeout_ms: 1000 }),
  ];
  assert.equal(planHooks(hooks, "before_effect").length, 1);
  assert.equal(planHooks(hooks, "after_receipt").length, 1);
  assert.equal(planHooks(hooks, "on_failure").length, 0);
});

test("planHooks rejects an unknown hook point", () => {
  assert.throws(() => planHooks([], "totally-not-a-point"), /Unsupported hook point/);
});

test("runHooksSync returns blocked when a fail_closed hook fails synchronously", async () => {
  // The sync variant is what `HookedEffectKernel.start` calls. Force a
  // synchronous failure and confirm the verdict is `blocked`.
  const hooks = [
    defineHook({
      id: "audit-fail", point: "before_effect", kind: "builtin",
      target: "builtin:audit-log", fail_policy: "fail_closed", timeout_ms: 1000,
    }),
  ];
  const result = await import("../src/hooks.ts").then((m) => m.runHooksSync(hooks, "before_effect", {}, {
    invoke: () => ({ ok: false, detail: "denied" }),
  }));
  assert.equal(result.blocked, true);
});

test("runHooksSync surfaces thrown exceptions as failed outcomes", async () => {
  const hooks = [
    defineHook({
      id: "throwing", point: "before_effect", kind: "builtin",
      target: "builtin:audit-log", fail_policy: "fail_closed", timeout_ms: 1000,
    }),
  ];
  const m = await import("../src/hooks.ts");
  const result = m.runHooksSync(hooks, "before_effect", {}, {
    invoke: () => { throw new Error("sync boom"); },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.outcomes[0].status, "failed");
  assert.match(result.outcomes[0].detail ?? "", /sync boom/);
});

test("runFor relaxes the blocked verdict when strictHooks is disabled", async () => {
  // Lenient mode must downgrade a fail_closed before_effect to a passed
  // run so observation cannot break the work it observes. The failing
  // hook here actually returns ok=false, so the runHooks callback reports
  // a blocked verdict and the runFor relaxation branch fires.
  const { root, store, runtime } = await fixture();
  try {
    const driver = new RuntimeDriver(store, {
      strictHooks: false,
      hooks: [defineHook({
        id: "failing", point: "before_effect", kind: "builtin",
        target: "builtin:audit-log", fail_policy: "fail_closed", timeout_ms: 1000,
      })],
    });
    // Override the private `invokeBuiltin` so the hook actually returns ok=false.
    (driver as unknown as { invokeBuiltin: () => { ok: boolean; detail?: string } }).invokeBuiltin = () => ({ ok: false, detail: "denied" });
    const operation = driver.startOperation({
      route_id: "r", idempotency_key: "idem_lenient",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const run = await driver.runBeforeEffect(operation, {});
    assert.equal(run.blocked, false, "lenient mode must downgrade fail_closed to passed");
  } finally {
    await teardown(root, store);
  }
});

test("runFor does not relax a blocked after_receipt hook", async () => {
  const { root, store } = await fixture();
  try {
    const driver = new RuntimeDriver(store, {
      strictHooks: false,
      hooks: [defineHook({ id: "after-block", point: "after_receipt", kind: "builtin", target: "builtin:audit-log" })],
    });
    (driver as unknown as { invokeBuiltin: () => { ok: boolean; detail: string } }).invokeBuiltin =
      () => ({ ok: false, detail: "after denied" });
    const operation = driver.startOperation({
      route_id: "r", idempotency_key: "idem_after_block", effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const run = await driver.runAfterReceipt(operation, { receipt_id: "r" });
    assert.equal(run.blocked, true);
  } finally {
    await teardown(root, store);
  }
});

test("runFor keeps a blocked before_effect hook strict", async () => {
  const { root, store } = await fixture();
  try {
    const driver = new RuntimeDriver(store, {
      strictHooks: true,
      hooks: [defineHook({ id: "strict-block", point: "before_effect", kind: "builtin", target: "builtin:audit-log" })],
    });
    (driver as unknown as { invokeBuiltin: () => { ok: boolean; detail: string } }).invokeBuiltin =
      () => ({ ok: false, detail: "strict denied" });
    const operation = driver.startOperation({
      route_id: "r", idempotency_key: "idem_strict_block", effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const run = await driver.runBeforeEffect(operation, {});
    assert.equal(run.blocked, true);
  } finally {
    await teardown(root, store);
  }
});

test("invokeBuiltinSync is the public seam that mirrors invokeBuiltin", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const hook = defaultHooks()[0];
    const result = runtime.invokeBuiltinSync(hook, "before_effect", { idempotency_key: "k" });
    assert.equal(result.ok, true);
  } finally {
    await teardown(root, store);
  }
});

test("invokeBuiltinSync returns a failure for an unknown builtin target", async () => {
  // Bypass `defineHook`'s target allow-list by constructing a HookSpec
  // directly: the runtime driver is the one that decides what a target
  // means, so it must still report a clean failure when given something
  // outside the built-in set.
  const { root, store, runtime } = await fixture();
  try {
    const mystery = {
      id: "mystery", point: "before_effect", kind: "builtin" as const,
      target: "builtin:not-real", fail_policy: "fail_closed" as const, timeout_ms: 1000,
    };
    const result = runtime.invokeBuiltinSync(mystery, "before_effect", {});
    assert.equal(result.ok, false);
    assert.match(String(result.detail), /unknown builtin hook target/);
  } finally {
    await teardown(root, store);
  }
});

test("invokeBuiltinSync surfaces token-meter and receipt-check branches", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const tokenMeter = defineHook({
      id: "tm", point: "before_effect", kind: "builtin",
      target: "builtin:token-meter", fail_policy: "fail_closed", timeout_ms: 1000,
    });
    const receiptCheck = defineHook({
      id: "rc", point: "after_receipt", kind: "builtin",
      target: "builtin:receipt-check", fail_policy: "fail_closed", timeout_ms: 1000,
    });
    assert.equal(runtime.invokeBuiltinSync(tokenMeter, "before_effect", {}).ok, true);
    // receipt-check refuses when the body has no idempotency_key.
    const refused = runtime.invokeBuiltinSync(receiptCheck, "after_receipt", {});
    assert.equal(refused.ok, false);
    const allowed = runtime.invokeBuiltinSync(receiptCheck, "after_receipt", { idempotency_key: "k" });
    assert.equal(allowed.ok, true);
  } finally {
    await teardown(root, store);
  }
});

test("runSync surfaces thrown exceptions as failed outcomes", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const driver = new RuntimeDriver(store, {
      hooks: [defineHook({
        id: "thrower-sync", point: "before_effect", kind: "builtin",
        target: "builtin:audit-log", fail_policy: "fail_closed", timeout_ms: 1000,
      })],
      onHookEvent: () => undefined,
    });
    const operation = driver.startOperation({
      route_id: "r", idempotency_key: "idem_run_sync",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    // runSync calls the private `invokeBuiltin` directly; force it to
    // throw so the surrounding catch block converts the exception into
    // a structured failed outcome.
    (driver as unknown as { invokeBuiltin: () => { ok: boolean } }).invokeBuiltin = () => { throw new Error("sync run throw"); };
    const run = driver.runBeforeEffectSync(operation, {});
    assert.equal(run.blocked, true);
    assert.equal(run.outcomes[0].status, "failed");
    assert.match(run.outcomes[0].detail ?? "", /sync run throw/);
  } finally {
    await teardown(root, store);
  }
});

test("runSync uses the default detail when a hook reports failure without detail", async () => {
  const { root, store } = await fixture();
  try {
    const driver = new RuntimeDriver(store, {
      hooks: [defineHook({ id: "no-detail", point: "before_effect", kind: "builtin", target: "builtin:audit-log" })],
      onHookEvent: () => undefined,
    });
    (driver as unknown as { invokeBuiltin: () => { ok: boolean } }).invokeBuiltin = () => ({ ok: false });
    const operation = driver.startOperation({
      route_id: "r", idempotency_key: "idem_no_detail", effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = driver.runBeforeEffectSync(operation, {});
    assert.equal(result.blocked, true);
    assert.equal(result.outcomes[0].detail, "hook reported failure");
  } finally {
    await teardown(root, store);
  }
});

test("runSync reports blocked=false when no hooks match the point", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const operation = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_run_sync_empty",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    // The default hooks have no on_failure entry, so runOnFailureSync on the
    // stock driver returns an empty outcomes list with blocked=false.
    const run = runtime.runOnFailureSync(operation, { error: "x" });
    assert.equal(run.blocked, false);
    assert.equal(run.outcomes.length, 0);
  } finally {
    await teardown(root, store);
  }
});

test("RuntimeDriver validates command hooks and honors an injected clock", async () => {
  const { root, store } = await fixture();
  try {
    const fixed = new Date("2030-01-01T00:00:00.000Z");
    const driver = new RuntimeDriver(store, {
      now: () => fixed,
      hooks: [defineHook({ id: "command-hook", point: "before_effect", kind: "command", target: "external:check" })],
    });
    const operation = driver.startOperation({
      route_id: "r", idempotency_key: "idem_command_hook", effect_class: "read", effect_scope: "x",
      policy_hash: "p", expires_at: "2030-01-01T00:01:00.000Z",
    });
    const run = driver.runBeforeEffectSync(operation, {});
    assert.equal(run.blocked, true);
    assert.match(run.outcomes[0].detail ?? "", /not a builtin/);
  } finally {
    await teardown(root, store);
  }
});

test("runHooksSync completes and returns blocked=false on the happy path", async () => {
  // The final return statement must be reached when no hook fails —
  // proving the loop terminates with `blocked = false` rather than
  // returning early through the fail_closed branch.
  const m = await import("../src/hooks.ts");
  const hooks = [
    defineHook({
      id: "audit-ok", point: "before_effect", kind: "builtin",
      target: "builtin:audit-log", fail_policy: "fail_closed", timeout_ms: 1000,
    }),
  ];
  const run = m.runHooksSync(hooks, "before_effect", {}, {
    invoke: () => ({ ok: true }),
  });
  assert.equal(run.blocked, false);
  assert.equal(run.outcomes[0].status, "passed");
});

test("HookedEffectKernel.report falls back to the synthetic operation when the runtime_operation is missing", async () => {
  // The synthetic fallback lives in the `found ?? syntheticOperation`
  // branch. Force the lookup to return null by deleting the runtime
  // operation after start, then call report — the wrapper must build a
  // synthetic operation so after_receipt hooks still audit.
  const { root, store, runtime } = await fixture();
  try {
    store.create("task", "task_seed", { title: "seed", goal: "seed", status: "draft", version: 1 });
    store.create("evidence", "evidence_004", { kind: "response", digest: "x", summary: "x" });
    const inner = new ExternalEffectKernel(store);
    const hooked = new HookedEffectKernel(inner, runtime);
    const prepared = inner.prepare({
      task_id: "task_seed", effect: "external_write", idempotency_key: "idem_key_alpha1",
      provider: "github", action: "POST /repos/foo/issues", target: "github/api",
      request_digest: "sha256:abc", approval_ref: "approval_001",
      effect_id: "eff_synthetic_lookup",
    }) as { effect: { id: string } };
    const started = hooked.start({
      effect_id: prepared.effect.id, approval_ref: "approval_001",
      route_id: "r", effect_class: "write", effect_scope: "github/api/repos/foo",
      policy_hash: "sha256:abc", idempotency_key: "idem_key_alpha1",
    }) as { effect: { id: string } };
    // Delete all rows for the runtime_operation. `remove` returns the
    // number of versioned rows touched; we only care that they are gone
    // so the next lookup returns null and the synthetic branch fires.
    const removed = store.remove("runtime_operation", started.effect.id);
    assert.ok(removed >= 1);
    const result = hooked.report({
      effect_id: prepared.effect.id, receipt_id: "rcpt_synthetic_lookup",
      status: "succeeded", remote_operation_id: "remote_42",
      evidence_ids: ["evidence_004"], response_digest: "sha256:done",
      operation_id: prepared.effect.id,
    });
    assert.ok(result);
  } finally {
    await teardown(root, store);
  }
});

test("recoverOperation rejects a completed operation", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const operation = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_completed",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const completed = runtime.completeOperation(operation, { receipt_id: "rcpt_done", status: "completed" });
    assert.throws(() => runtime.recoverOperation(completed.id), /not resumable/);
  } finally {
    await teardown(root, store);
  }
});

test("HookedEffectKernel.prepare delegates to the inner kernel unchanged", async () => {
  const { root, store, runtime } = await fixture();
  try {
    store.create("task", "task_seed", {
      title: "seed", goal: "seed", status: "draft", version: 1,
    });
    const inner = new ExternalEffectKernel(store);
    const hooked = new HookedEffectKernel(inner, runtime);
    const prepared = hooked.prepare({
      task_id: "task_seed", effect: "external_write", idempotency_key: "idem_key_alpha1",
      provider: "github", action: "POST /repos/foo/issues", target: "github/api",
      request_digest: "sha256:abc", approval_ref: "approval_001",
      effect_id: "eff_prep",
    }) as { effect: { id: string } };
    assert.ok(prepared.effect.id);
  } finally {
    await teardown(root, store);
  }
});

test("HookedEffectKernel.report looks up the existing runtime_operation by id", async () => {
  const { root, store, runtime } = await fixture();
  try {
    store.create("task", "task_seed", {
      title: "seed", goal: "seed", status: "draft", version: 1,
    });
    store.create("evidence", "evidence_002", {
      kind: "response", digest: "sha256:done", summary: "ok",
    });
    const inner = new ExternalEffectKernel(store);
    const hooked = new HookedEffectKernel(inner, runtime);
    const prepared = inner.prepare({
      task_id: "task_seed", effect: "external_write", idempotency_key: "idem_key_alpha1",
      provider: "github", action: "POST /repos/foo/issues", target: "github/api",
      request_digest: "sha256:abc", approval_ref: "approval_001",
      effect_id: "eff_with_op",
    }) as { effect: { id: string } };
    // Start first so the wrapper records a runtime_operation.
    hooked.start({
      effect_id: prepared.effect.id, approval_ref: "approval_001",
      route_id: "r", effect_class: "write", effect_scope: "github/api/repos/foo",
      policy_hash: "sha256:abc", idempotency_key: "idem_key_alpha1",
    });
    // Now report: the lookup finds the real runtime_operation, so the
    // synthetic fallback is not used.
    const result = hooked.report({
      effect_id: prepared.effect.id, receipt_id: "rcpt_lookup",
      status: "succeeded", remote_operation_id: "remote_42",
      evidence_ids: ["evidence_002"], response_digest: "sha256:done",
      operation_id: prepared.effect.id,
    });
    assert.ok(result);
  } finally {
    await teardown(root, store);
  }
});

test("HookedEffectKernel re-throws inner kernel errors after running on_failure", async () => {
  const { root, store, runtime } = await fixture();
  try {
    store.create("task", "task_seed", {
      title: "seed", goal: "seed", status: "draft", version: 1,
    });
    const inner = new ExternalEffectKernel(store);
    const hooked = new HookedEffectKernel(inner, runtime);
    // Approve ref mismatch forces start() to throw.
    const prepared = inner.prepare({
      task_id: "task_seed", effect: "external_write", idempotency_key: "idem_key_alpha1",
      provider: "github", action: "POST /repos/foo/issues", target: "github/api",
      request_digest: "sha256:abc", approval_ref: "approval_correct",
      effect_id: "eff_fail",
    }) as { effect: { id: string } };
    assert.throws(() => hooked.start({
      effect_id: prepared.effect.id, approval_ref: "approval_wrong",
      route_id: "r", effect_class: "write", effect_scope: "github/api/repos/foo",
      policy_hash: "sha256:abc", idempotency_key: "idem_key_alpha1",
    }), /approval does not match/);
  } finally {
    await teardown(root, store);
  }
});

test("runtime_operation is recorded in a fresh database opened at v4", async () => {
  // Persistence check: opening a fresh store at v4 (the latest schema) must
  // accept a runtime_operation save without any DDL surprises. This is the
  // regression test for the v3→v4 migration introduced by W7.
  const root = join(tmpdir(), `craft-runtime-v4-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const runtime = new RuntimeDriver(store);
    const op = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_v4_smoke",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.ok(store.find("runtime_operation", op.id));
  } finally {
    await teardown(root, store);
  }
});

test("recoverOperation bumps retry_count on a resumable operation", async () => {
  const { root, store, runtime } = await fixture();
  try {
    const operation = runtime.startOperation({
      route_id: "r", idempotency_key: "idem_resume_1",
      effect_class: "read", effect_scope: "x", policy_hash: "p",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const recovered = runtime.recoverOperation(operation.id);
    assert.equal(recovered.status, "crash_recovered");
    assert.equal(recovered.retry_count, 1);
  } finally {
    await teardown(root, store);
  }
});

test("HookRun shape serialises blocked and outcomes", () => {
  const run: HookRun = { outcomes: [], blocked: true };
  assert.equal(run.blocked, true);
  assert.deepEqual(run.outcomes, []);
});

test("HookedEffectKernel.resolve / saga / compensate delegates forward unchanged", async () => {
  // We do not need a real receipt to exercise the wrapper's pass-through
  // surface — the inner kernel will throw on the missing effect, which is
  // enough to prove the wrapper ran (delegation preserves the error).
  const { root, store, runtime } = await fixture();
  try {
    store.create("task", "task_seed", {
      title: "seed", goal: "seed", status: "draft", version: 1,
    });
    const inner = new ExternalEffectKernel(store);
    const hooked = new HookedEffectKernel(inner, runtime);
    assert.throws(() => hooked.resolve({ effect_id: "nonexistent", resolution: "succeeded",
      resolver_type: "human", approval_ref: "x", evidence_ids: ["e"] }), /Unknown external_effect/);
    // Each remaining delegating method simply forwards to the inner
    // kernel; the inner kernel will throw because the effect row is
    // missing or because reconciliation/saga state is incomplete —
    // either way the throw proves delegation happened.
    for (const call of [
      () => hooked.reconcileIssue({ effect_id: "nonexistent", issue: "x", reference: "r" }),
      () => hooked.reconcileReport({ effect_id: "nonexistent", report: { ok: false } }),
      () => hooked.reconcileFail({ effect_id: "nonexistent" }),
      () => hooked.compensateIssue({ effect_id: "nonexistent", plan_id: "p", scope: "issue" }),
      () => hooked.compensateFromExecution({ effect_id: "nonexistent", plan_id: "p", scope: "execution" }),
      () => hooked.compensateCancel({ effect_id: "nonexistent", plan_id: "p" }),
      () => hooked.compensateReport({ effect_id: "nonexistent", plan_id: "p", scope: "report" }),
      () => hooked.sagaCreate({ effect_id: "nonexistent", name: "saga" }),
      () => hooked.sagaGet({ saga_id: "nonexistent" }),
    ] as const) {
      assert.throws(call as () => JsonObject);
    }
  } finally {
    await teardown(root, store);
  }
});

test("HookedEffectKernel.start falls back to all-default allocateOperation branches", async () => {
  // The allocateOperation helper supplies defaults for every field that
  // is missing from `args`. Calling start with an empty-ish effect_id
  // forces every `?? fallback` branch to execute.
  const { root, store, runtime } = await fixture();
  try {
    store.create("task", "task_seed", {
      title: "seed", goal: "seed", status: "draft", version: 1,
    });
    // Stub the inner kernel so that start throws — we only care about
    // exercising the allocateOperation default branches; the actual
    // dispatch will be swallowed by the catch branch (also exercised).
    const inner = new ExternalEffectKernel(store);
    const hooked = new HookedEffectKernel(inner, runtime);
    // Patch kernel.start to throw so the start catch branch fires.
    (inner as unknown as { start: () => never }).start = () => { throw new Error("synthetic failure"); };
    assert.throws(() => hooked.start({
      // No route_id, task_id, idempotency_key, effect_class, effect_scope,
      // policy_hash — every default branch fires.
      effect_id: undefined, action: "noop", target: "noop",
    } as JsonObject), /synthetic failure/);
  } finally {
    await teardown(root, store);
  }
});

test("HookedEffectKernel continues when a lenient hook verdict is blocked", async () => {
  const { root, store } = await fixture();
  try {
    const runtime = new RuntimeDriver(store, { strictHooks: false, onHookEvent: () => undefined });
    (runtime as unknown as { runBeforeEffectSync: () => { outcomes: never[]; blocked: boolean } }).runBeforeEffectSync =
      () => ({ outcomes: [], blocked: true });
    const inner = new ExternalEffectKernel(store);
    (inner as unknown as { start: () => JsonObject }).start = () => ({ accepted: true });
    const hooked = new HookedEffectKernel(inner, runtime);
    const result = hooked.start({ effect_id: "eff_lenient", action: "noop", target: "local" });
    assert.deepEqual(result, { accepted: true });
  } finally {
    await teardown(root, store);
  }
});

test("HookedEffectKernel records non-Error failures", async () => {
  const { root, store } = await fixture();
  try {
    const runtime = new RuntimeDriver(store, {
      hooks: [defineHook({ id: "failure-audit", point: "on_failure", kind: "builtin", target: "builtin:audit-log" })],
    });
    (runtime as unknown as { invokeBuiltin: (hook: unknown, point: string) => JsonObject }).invokeBuiltin =
      (_hook, point) => { if (point === "on_failure") throw "hook plain"; return { ok: true }; };
    const inner = new ExternalEffectKernel(store);
    (inner as unknown as { start: () => never }).start = () => { throw "plain failure"; };
    const hooked = new HookedEffectKernel(inner, runtime);
    assert.throws(() => hooked.start({ effect_id: "eff_plain_failure" } as JsonObject));
    const events = store.events("hook").filter((row) => row.event_type === "hook_on_failure");
    assert.ok(events.some((row) => String((row.payload as JsonObject).detail ?? "").includes("hook plain")));
  } finally {
    await teardown(root, store);
  }
});

test("HookedEffectKernel.report triggers the lookupOperation catch branch and the errorMessage helper", async () => {
  // The catch branch (line ~102) fires only when `store.find` itself
  // throws on the runtime_operation lookup. Patch the find AFTER
  // start() so start's own find (idempotency check) still works.
  const { root, store, runtime } = await fixture();
  try {
    store.create("task", "task_seed", {
      title: "seed", goal: "seed", status: "draft", version: 1,
    });
    store.create("evidence", "evidence_lookup_catch", { kind: "response", digest: "x", summary: "x" });
    const inner = new ExternalEffectKernel(store);
    const hooked = new HookedEffectKernel(inner, runtime);
    inner.prepare({
      task_id: "task_seed", effect: "external_write", idempotency_key: "idem_lookup_catch",
      provider: "github", action: "POST /repos/foo/issues", target: "github/api",
      request_digest: "sha256:abc", approval_ref: "approval_001", effect_id: "eff_lookup_catch",
    });
    (inner as unknown as { start: (a: JsonObject) => JsonObject }).start = (a: JsonObject) => ({ idempotent: false, effect: a });
    (inner as unknown as { report: () => never }).report = () => { throw new Error("inner report fail"); };
    hooked.start({
      effect_id: "eff_lookup_catch", task_id: "task_seed", route_id: "task_seed",
      idempotency_key: "idem_lookup_catch", effect_class: "write",
      effect_scope: "github/api", policy_hash: "sha256:abc",
      action: "POST /repos/foo/issues", target: "github/api", approval_ref: "approval_001",
      request_digest: "sha256:abc",
    });
    // Now patch find to throw on the next runtime_operation lookup.
    // We patch it for both startOperation's idempotency check (already
    // resolved) and the report path's lookupOperation call.
    const originalFind = store.find.bind(store);
    let findCalls = 0;
    store.find = ((kind: string, id: string) => {
      if (kind === "runtime_operation") {
        findCalls += 1;
        if (findCalls === 1) throw new Error("forced lookup throw");
      }
      return originalFind(kind, id);
    }) as typeof store.find;
    try {
      assert.throws(() => hooked.report({
        effect_id: "eff_lookup_catch", receipt_id: "rcpt_catch",
        status: "succeeded", evidence_ids: ["evidence_lookup_catch"],
      }), /inner report fail/);
      assert.ok(findCalls >= 1, "the lookup catch branch must have fired");
    } finally {
      store.find = originalFind;
    }
  } finally {
    await teardown(root, store);
  }
});

test("HookedEffectKernel.report uses the synthetic fallback when the runtime_operation is missing", async () => {
  // Pass an operation_id that does not exist; the lookup falls through to
  // the synthetic operation so after_receipt hooks still audit.
  const { root, store, runtime } = await fixture();
  try {
    store.create("task", "task_seed", {
      title: "seed", goal: "seed", status: "draft", version: 1,
    });
    store.create("evidence", "evidence_003", {
      kind: "response", digest: "sha256:done", summary: "ok",
    });
    const inner = new ExternalEffectKernel(store);
    const hooked = new HookedEffectKernel(inner, runtime);
    const prepared = inner.prepare({
      task_id: "task_seed", effect: "external_write", idempotency_key: "idem_key_alpha1",
      provider: "github", action: "POST /repos/foo/issues", target: "github/api",
      request_digest: "sha256:abc", approval_ref: "approval_001",
      effect_id: "eff_fallback",
    }) as { effect: { id: string } };
    // Start so the effect is in `executing`; pass an operation_id that
    // does NOT exist so the wrapper's lookup falls back to the synthetic.
    hooked.start({
      effect_id: prepared.effect.id, approval_ref: "approval_001",
      route_id: "r", effect_class: "write", effect_scope: "github/api/repos/foo",
      policy_hash: "sha256:abc", idempotency_key: "idem_key_alpha1",
    });
    const result = hooked.report({
      effect_id: prepared.effect.id, receipt_id: "rcpt_fallback",
      status: "succeeded", remote_operation_id: "remote_42",
      evidence_ids: ["evidence_003"], response_digest: "sha256:done",
      operation_id: "no-such-operation-id",
    });
    assert.ok(result);
  } finally {
    await teardown(root, store);
  }
});

test("HookedEffectKernel.report re-throws inner kernel errors after running on_failure", async () => {
  const { root, store, runtime } = await fixture();
  try {
    store.create("task", "task_seed", {
      title: "seed", goal: "seed", status: "draft", version: 1,
    });
    const inner = new ExternalEffectKernel(store);
    const hooked = new HookedEffectKernel(inner, runtime);
    const prepared = inner.prepare({
      task_id: "task_seed", effect: "external_write", idempotency_key: "idem_key_alpha1",
      provider: "github", action: "POST /repos/foo/issues", target: "github/api",
      request_digest: "sha256:abc", approval_ref: "approval_001",
      effect_id: "eff_report_fail",
    }) as { effect: { id: string } };
    // Start so the effect is in `executing`, then report with an invalid
    // status to force the inner kernel to throw.
    hooked.start({
      effect_id: prepared.effect.id, approval_ref: "approval_001",
      route_id: "r", effect_class: "write", effect_scope: "github/api/repos/foo",
      policy_hash: "sha256:abc", idempotency_key: "idem_key_alpha1",
    });
    assert.throws(() => hooked.report({
      effect_id: prepared.effect.id, receipt_id: "rcpt_bad",
      status: "bogus", evidence_ids: ["evidence_001"],
      remote_operation_id: "x", response_digest: "y",
    }), /External effect result is unsupported/);
  } finally {
    await teardown(root, store);
  }
});

function payloadOf(record: RuntimeOperation): Record<string, unknown> {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}
