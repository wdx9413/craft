import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";

test("a dispatched external effect is reconciled after restart without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-runtime-recovery-"));
  let store = await new CraftStore(craftPaths(root)).open();
  try {
    let service = new CraftService(store);
    service.runtimeAttemptPrepare({ attempt_id: "attempt", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "external-key" });
    service.runtimeAttemptDispatch({ attempt_id: "attempt", dispatch_ref: "sent" });
    store.close();
    store = await new CraftStore(craftPaths(root)).open();
    service = new CraftService(store);
    const recovered = service.runtimeAttemptRecover({ attempt_id: "attempt", reason: "restart" });
    assert.equal(recovered.replay_allowed, false);
    assert.equal(recovered.decision, "reconcile_existing_effect");
    assert.equal((service.runtimeAttemptGet({ attempt_id: "attempt" }).attempt as JsonObject).status, "reconcile_required");
    assert.throws(() => service.runtimeAttemptDispatch({ attempt_id: "attempt", dispatch_ref: "again" }), /reconcile_required/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("receipt retry succeeds after the receipt and attempt transaction rolls back", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-receipt-recovery-"));
  let store = await new CraftStore(craftPaths(root)).open();
  try {
    let service = new CraftService(store);
    service.runtimeAttemptPrepare({ attempt_id: "attempt", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "external-key" });
    service.runtimeAttemptDispatch({ attempt_id: "attempt" });
    service.runtimeAttemptReceiptPending({ attempt_id: "attempt", receipt_id: "receipt" });
    const originalSave = store.updateIfVersion.bind(store);
    store.updateIfVersion = ((kind, ...args) => {
      if (kind === "runtime_execution_attempt") throw new Error("simulated process failure");
      return originalSave(kind, ...args);
    }) as typeof store.updateIfVersion;
    assert.throws(() => service.runtimeAttemptRecordReceipt({ attempt_id: "attempt", receipt_id: "receipt", result_digest: "done" }), /simulated process failure/);
    store.close();
    store = await new CraftStore(craftPaths(root)).open();
    service = new CraftService(store);
    const result = service.runtimeAttemptRecordReceipt({ attempt_id: "attempt", receipt_id: "receipt", result_digest: "done" });
    assert.equal(result.idempotent, false);
    const attempt = service.runtimeAttemptGet({ attempt_id: "attempt" }).attempt as JsonObject;
    assert.equal(attempt.receipt_id, "receipt");
    assert.equal(attempt.status, "observing");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancelling an uncertain external effect preserves reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-cancel-unknown-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    service.runtimeAttemptPrepare({ attempt_id: "attempt", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "external-key" });
    service.runtimeAttemptDispatch({ attempt_id: "attempt" });
    service.runtimeAttemptObserve({ attempt_id: "attempt", observed_status: "unknown", observation_id: "observation" });
    service.runtimeAttemptCancel({ attempt_id: "attempt", reason: "user cancelled" });
    const cancelled = service.runtimeAttemptGet({ attempt_id: "attempt" }).attempt as JsonObject;
    assert.equal(cancelled.status, "reconcile_required");
    assert.equal(cancelled.recovery_required, true);
    assert.equal(cancelled.cancel_requested, true);
    assert.equal(service.runtimeAttemptCancel({ attempt_id: "attempt" }).idempotent, true);
    assert.equal(service.runtimeAttemptRecover({ attempt_id: "attempt" }).replay_allowed, false);
    service.runtimeAttemptPrepare({ attempt_id: "prepared", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "another-key" });
    assert.equal((service.runtimeAttemptCancel({ attempt_id: "prepared" }).attempt as JsonObject).status, "cancelled");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancelling an in-flight external effect keeps it available for reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-cancel-inflight-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    for (const [stage, effect_class] of [["dispatched", "external_write"], ["receipt_pending", "local_write"], ["observing", "destructive"]] as const) {
      const attempt_id = `attempt-${stage}`;
      service.runtimeAttemptPrepare({ attempt_id, task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class, idempotency_key: `key-${stage}` });
      service.runtimeAttemptDispatch({ attempt_id });
      if (stage === "receipt_pending") service.runtimeAttemptReceiptPending({ attempt_id, receipt_id: `receipt-${stage}` });
      if (stage === "observing") service.runtimeAttemptObserve({ attempt_id, observation_id: `observation-${stage}`, observed_status: "observed" });
      const result = service.runtimeAttemptCancel({ attempt_id, reason: "stop" }).attempt as JsonObject;
      assert.equal(result.status, "reconcile_required", stage);
      assert.equal(result.cancel_requested, true, stage);
      assert.equal(result.recovery_required, true, stage);
      assert.equal(service.runtimeAttemptRecover({ attempt_id }).replay_allowed, false, stage);
    }
    service.runtimeAttemptPrepare({ attempt_id: "read", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "read_only", idempotency_key: "read-key" });
    service.runtimeAttemptDispatch({ attempt_id: "read" });
    assert.equal((service.runtimeAttemptCancel({ attempt_id: "read" }).attempt as JsonObject).status, "cancelled");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a different receipt cannot replace an attached receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-receipt-conflict-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    service.runtimeAttemptPrepare({ attempt_id: "attempt", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "external-key" });
    service.runtimeAttemptDispatch({ attempt_id: "attempt" });
    service.runtimeAttemptRecordReceipt({ attempt_id: "attempt", receipt_id: "first", result_digest: "one" });
    assert.throws(() => service.runtimeAttemptRecordReceipt({ attempt_id: "attempt", receipt_id: "second", result_digest: "two" }), /different receipt/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a transactionally rolled back receipt can be recorded on retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-receipt-link-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    service.runtimeAttemptPrepare({ attempt_id: "attempt", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "external-key" });
    service.runtimeAttemptDispatch({ attempt_id: "attempt" });
    const originalSave = store.updateIfVersion.bind(store);
    store.updateIfVersion = ((kind, ...args) => {
      if (kind === "runtime_execution_attempt") throw new Error("interrupted");
      return originalSave(kind, ...args);
    }) as typeof store.updateIfVersion;
    assert.throws(() => service.runtimeAttemptRecordReceipt({ attempt_id: "attempt", receipt_id: "receipt", result_digest: "done" }), /interrupted/);
    store.updateIfVersion = originalSave;
    const retry = service.runtimeAttemptRecordReceipt({ attempt_id: "attempt", receipt_id: "receipt", result_digest: "done" });
    assert.equal(retry.idempotent, false);
    assert.equal((retry.attempt as JsonObject).receipt_id, "receipt");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("competing dispatches cannot both acquire the same attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-dispatch-race-"));
  const first = await new CraftStore(craftPaths(root)).open(), second = await new CraftStore(craftPaths(root)).open();
  try {
    const a = new CraftService(first), b = new CraftService(second);
    a.runtimeAttemptPrepare({ attempt_id: "attempt", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "key" });
    const get = first.get.bind(first); let interleave = true;
    first.get = ((...args) => { const found = get(...args); if (interleave && args[0] === "runtime_execution_attempt") { interleave = false; assert.equal(b.runtimeAttemptDispatch({ attempt_id: "attempt", dispatch_ref: "b" }).idempotent, false); } return found; }) as typeof first.get;
    assert.throws(() => a.runtimeAttemptDispatch({ attempt_id: "attempt", dispatch_ref: "a" }), /Concurrent update/);
    assert.equal((b.runtimeAttemptGet({ attempt_id: "attempt" }).attempt as JsonObject).dispatch_ref, "b");
  } finally { first.close(); second.close(); await rm(root, { recursive: true, force: true }); }
});

test("two processes sharing a database cannot both dispatch one attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-dispatch-processes-"));
  const store = await new CraftStore(craftPaths(root)).open();
  new CraftService(store).runtimeAttemptPrepare({ attempt_id: "attempt", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "key" });
  store.close();
  const start = join(root, "start"), modules = {
    store: new URL("../core/infrastructure/store.ts", import.meta.url).href,
    paths: new URL("../core/infrastructure/paths.ts", import.meta.url).href,
    kernel: new URL("../core/runtime-execution-attempt.ts", import.meta.url).href,
  };
  const source = `import {CraftStore} from ${JSON.stringify(modules.store)};import {craftPaths} from ${JSON.stringify(modules.paths)};import {RuntimeExecutionAttemptKernel} from ${JSON.stringify(modules.kernel)};import {existsSync,writeFileSync} from 'node:fs';import {setTimeout as wait} from 'node:timers/promises';const s=await new CraftStore(craftPaths(process.argv[1])).open();writeFileSync(process.argv[2], 'ready');while(!existsSync(process.argv[3])) await wait(5);try{const r=new RuntimeExecutionAttemptKernel(s).dispatch({attempt_id:'attempt',dispatch_ref:'same'});console.log(JSON.stringify({ok:true,idempotent:r.idempotent}));}catch(e){console.log(JSON.stringify({ok:false,error:String(e)}));}finally{s.close();}`;
  const children = ["one", "two"].map(name => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, root, join(root, name), start], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
    const result = new Promise<{ ok: boolean; idempotent?: boolean; error?: string }>((resolve, reject) => { child.on("error", reject); child.on("close", code => { if (code !== 0) reject(new Error(errors)); else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } }); });
    return { child, result };
  });
  try {
    const deadline = Date.now() + 10_000;
    for (const name of ["one", "two"]) while (true) {
      try { await access(join(root, name)); break; } catch { if (Date.now() >= deadline) throw new Error("dispatch worker not ready"); await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    await writeFile(start, "start");
    const results = await Promise.all(children.map(item => item.result));
    assert.equal(results.filter(item => item.ok && item.idempotent === false).length, 1);
    assert.equal(results.filter(item => item.ok && item.idempotent === true || !item.ok && /Concurrent update|busy|locked/i.test(String(item.error))).length, 1);
    const verify = await new CraftStore(craftPaths(root)).open();
    try { assert.equal((new CraftService(verify).runtimeAttemptGet({ attempt_id: "attempt" }).attempt as JsonObject).status, "dispatched"); } finally { verify.close(); }
  } finally { for (const item of children) if (item.child.exitCode === null) item.child.kill(); await rm(root, { recursive: true, force: true }); }
});

test("conflicting receipt and observation retries are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-retry-conflict-")); const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    service.runtimeAttemptPrepare({ attempt_id: "attempt", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "key" });
    service.runtimeAttemptDispatch({ attempt_id: "attempt" });
    service.runtimeAttemptReceiptPending({ attempt_id: "attempt", receipt_id: "one" });
    assert.throws(() => service.runtimeAttemptReceiptPending({ attempt_id: "attempt", receipt_id: "two" }), /conflict/);
    service.runtimeAttemptObserve({ attempt_id: "attempt", observation_id: "observation", observed_status: "observed", evidence_digest: "one" });
    assert.throws(() => service.runtimeAttemptObserve({ attempt_id: "attempt", observation_id: "observation", observed_status: "failed", evidence_digest: "two" }), /conflict/);
    assert.equal((service.runtimeAttemptGet({ attempt_id: "attempt" }).attempt as JsonObject).status, "observing");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("repeated uncertain cancellation preserves the original receipt and reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-cancel-retry-")); const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    service.runtimeAttemptPrepare({ attempt_id: "attempt", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "key" });
    service.runtimeAttemptDispatch({ attempt_id: "attempt" });
    const original = service.runtimeAttemptCancel({ attempt_id: "attempt", reason: "first" }).attempt as JsonObject;
    const retry = service.runtimeAttemptCancel({ attempt_id: "attempt", reason: "second" });
    assert.equal(retry.idempotent, true); assert.deepEqual(retry.attempt, original);
    assert.throws(() => service.runtimeAttemptResolveEffect({ attempt_id: "attempt", resolution: "confirmed_success", receipt_id: "missing" }), /receipt.*not found/i);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy orphan receipt and repeated observation reconnect without losing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-receipt-")); const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    service.runtimeAttemptPrepare({ attempt_id: "attempt", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "key" });
    service.runtimeAttemptDispatch({ attempt_id: "attempt" });
    service.runtimeAttemptReceiptPending({ attempt_id: "attempt", receipt_id: "receipt" });
    store.create("runtime_receipt", "receipt", { task_id: "task", work_loop_id: "loop", run_id: "run", attempt_id: "attempt", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "key", result_digest: "done", raw_content: false });
    const repaired = service.runtimeAttemptRecordReceipt({ attempt_id: "attempt", receipt_id: "receipt", result_digest: "done" });
    assert.equal(repaired.idempotent, true); assert.equal((repaired.attempt as JsonObject).status, "observing");
    service.runtimeAttemptObserve({ attempt_id: "attempt", observation_id: "observation", observed_status: "observed", evidence_digest: "evidence" });
    service.runtimeAttemptRecover({ attempt_id: "attempt" });
    const restored = service.runtimeAttemptObserve({ attempt_id: "attempt", observation_id: "observation", observed_status: "observed", evidence_digest: "evidence" });
    assert.equal(restored.idempotent, false); assert.equal((restored.attempt as JsonObject).status, "observing");
    assert.equal(service.runtimeAttemptObserve({ attempt_id: "attempt", observation_id: "observation", observed_status: "observed", evidence_digest: "evidence" }).idempotent, true);
    service.runtimeAttemptPrepare({ attempt_id: "unlinked", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "other" });
    service.runtimeAttemptDispatch({ attempt_id: "unlinked" });
    store.create("runtime_receipt", "orphan", { task_id: "task", work_loop_id: "loop", run_id: "run", attempt_id: "unlinked", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "other", result_digest: "done", raw_content: false });
    const linked = service.runtimeAttemptRecordReceipt({ attempt_id: "unlinked", receipt_id: "orphan", result_digest: "done" });
    assert.equal(linked.idempotent, true); assert.equal((linked.attempt as JsonObject).status, "dispatched");
    assert.equal((linked.attempt as JsonObject).receipt_id, "orphan");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy receipts must match the complete attempt identity before reconnect or resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-receipt-identity-")); const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    for (const field of ["task_id", "work_loop_id", "run_id", "host_id", "environment_digest", "effect_class", "idempotency_key"] as const) {
      const attemptId = `attempt-${field}`, receiptId = `receipt-${field}`;
      service.runtimeAttemptPrepare({ attempt_id: attemptId, task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: `key-${field}` });
      service.runtimeAttemptDispatch({ attempt_id: attemptId });
      service.runtimeAttemptReceiptPending({ attempt_id: attemptId, receipt_id: receiptId });
      store.create("runtime_receipt", receiptId, { task_id: "task", work_loop_id: "loop", run_id: "run", attempt_id: attemptId, host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: `key-${field}`, result_digest: "done", raw_content: false, [field]: "foreign" });
      assert.throws(() => service.runtimeAttemptRecordReceipt({ attempt_id: attemptId, receipt_id: receiptId, result_digest: "done" }), /conflict|belong/i, field);
      service.runtimeAttemptRecover({ attempt_id: attemptId });
      assert.throws(() => service.runtimeAttemptResolveEffect({ attempt_id: attemptId, resolution: "confirmed_success", receipt_id: receiptId }), /conflict|belong/i, field);
      assert.equal((service.runtimeAttemptGet({ attempt_id: attemptId }).attempt as JsonObject).status, "reconcile_required");
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("confirmed success requires a persisted matching receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-reconcile-proof-")); const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    service.runtimeAttemptPrepare({ attempt_id: "attempt", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: "key" });
    service.runtimeAttemptDispatch({ attempt_id: "attempt" });
    service.runtimeAttemptRecover({ attempt_id: "attempt" });
    assert.throws(() => service.runtimeAttemptResolveEffect({ attempt_id: "attempt", resolution: "confirmed_success" }), /receipt/i);
    assert.equal((service.runtimeAttemptGet({ attempt_id: "attempt" }).attempt as JsonObject).status, "reconcile_required");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy observations must match their attempt identity before reconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-observation-identity-")); const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    for (const field of ["task_id", "run_id", "host_id"] as const) {
      const attemptId = `attempt-${field}`, observationId = `observation-${field}`;
      service.runtimeAttemptPrepare({ attempt_id: attemptId, task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "env", effect_class: "external_write", idempotency_key: `key-${field}` });
      service.runtimeAttemptDispatch({ attempt_id: attemptId });
      store.create("runtime_observation", observationId, { task_id: "task", run_id: "run", attempt_id: attemptId, host_id: "codex", observed_status: "observed", evidence_digest: "evidence", raw_content: false, [field]: "foreign" });
      assert.throws(() => service.runtimeAttemptObserve({ attempt_id: attemptId, observation_id: observationId, observed_status: "observed", evidence_digest: "evidence" }), /belong|conflict/i, field);
      assert.equal((service.runtimeAttemptGet({ attempt_id: attemptId }).attempt as JsonObject).status, "dispatched");
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
