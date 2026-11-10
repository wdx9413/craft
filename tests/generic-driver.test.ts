import assert from "node:assert/strict";
import { HostProcessCleanupError } from "../core/host-driver.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GenericCliHostKernel } from "../core/generic-driver.ts";
import type { HostExecutionResult } from "../core/host-driver.ts";
import { defineHostProfile } from "../core/host-registry.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-generic-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const task = store.create("task", `task_${process.pid}`, { title: "test", goal: "test" });
  const profile = defineHostProfile({ host: "generic-test", kind: "agent-cli", command: "node", output_format: "text", argv_template: ["-e", "console.log('ok')"], models: [], default_model: null });
  return { root, store, task, profile };
}

test("GenericCliHostKernel constructor rejects builtin and non-agent-cli profiles", () => {
  const store = new CraftStore(craftPaths(join(tmpdir(), `craft-generic-ctor-${process.pid}`)));
  const builtin = defineHostProfile({ host: "custom", kind: "agent-cli", command: "x", output_format: "text", argv_template: ["x"] });
  (builtin as unknown as JsonObject).builtin = true;
  assert.throws(() => new GenericCliHostKernel(store, builtin as never), /declared host profile/);
  const mcp = defineHostProfile({ host: "custom", kind: "generic-mcp", command: "x", output_format: "text", argv_template: [] });
  assert.throws(() => new GenericCliHostKernel(store, mcp), /agent-cli profile/);
});

test("GenericCliHostKernel prepare and execute produce a receipt", async () => {
  const f = await fixture();
  try {
    const kernel = new GenericCliHostKernel(f.store, f.profile, async () => ({ exitCode: 0, signal: null, stdout: "hello", stderr: "", timedOut: false, cancelled: false, outputLimited: false }));
    const prepared = kernel.prepare({ task_id: f.task.id, workspace: f.root, prompt: "go" }) as JsonObject;
    assert.equal(prepared.idempotent, false);
    const executed = await kernel.execute({ dispatch_id: (prepared.dispatch as JsonObject).id, prompt: "go" }) as JsonObject;
    const receipt = executed.receipt as JsonObject;
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.final_message, "hello");
    assert.equal(receipt.host, "generic-test");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("GenericCliHostKernel execute idempotent on completed", async () => {
  const f = await fixture();
  try {
    const kernel = new GenericCliHostKernel(f.store, f.profile, async () => ({ exitCode: 0, signal: null, stdout: "x", stderr: "", timedOut: false, cancelled: false, outputLimited: false }));
    const p = kernel.prepare({ task_id: f.task.id, workspace: f.root, prompt: "go" }) as JsonObject;
    await kernel.execute({ dispatch_id: (p.dispatch as JsonObject).id, prompt: "go" });
    const again = await kernel.execute({ dispatch_id: (p.dispatch as JsonObject).id, prompt: "go" }) as JsonObject;
    assert.equal(again.idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("generic Host refuses to execute a prepared dispatch after profile drift", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const kernel = new GenericCliHostKernel(f.store, f.profile, async () => { calls++; return { exitCode: 0, signal: null, stdout: "x", stderr: "", timedOut: false, cancelled: false, outputLimited: false }; });
    const dispatch = kernel.prepare({ task_id: f.task.id, workspace: f.root, prompt: "go" }).dispatch as JsonObject;
    f.profile.argv_template.push("changed");
    await assert.rejects(kernel.execute({ dispatch_id: dispatch.id, prompt: "go" }), /profile changed/u);
    assert.equal(calls, 0);
    assert.equal(f.store.get(f.profile.dispatch_kind, String(dispatch.id)).status, "prepared");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("GenericCliHostKernel execute fails on bad prompt or status", async () => {
  const f = await fixture();
  try {
    const kernel = new GenericCliHostKernel(f.store, f.profile, async () => ({ exitCode: 1, signal: null, stdout: "", stderr: "err", timedOut: false, cancelled: false, outputLimited: false }));
    const p = kernel.prepare({ task_id: f.task.id, workspace: f.root, prompt: "go" }) as JsonObject;
    const executed = await kernel.execute({ dispatch_id: (p.dispatch as JsonObject).id, prompt: "go" }) as JsonObject;
    assert.equal((executed.receipt as JsonObject).status, "failed");
    await assert.rejects(kernel.execute({ dispatch_id: (p.dispatch as JsonObject).id, prompt: "wrong" }), /does not match/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("GenericCliHostKernel execute handles workspace-write autonomy", async () => {
  const f = await fixture();
  try {
    const kernel = new GenericCliHostKernel(f.store, f.profile, async () => ({ exitCode: 0, signal: null, stdout: "ok", stderr: "", timedOut: false, cancelled: false, outputLimited: false }));
    const p = kernel.prepare({ task_id: f.task.id, workspace: f.root, prompt: "go", sandbox: "workspace-write" }) as JsonObject;
    // Without authorization_request_id, the autonomy consumption plan will throw because no request exists.
    await assert.rejects(kernel.execute({ dispatch_id: (p.dispatch as JsonObject).id, prompt: "go" }), /request_id/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

for (const failure of ["cancelled", "outputLimited", "signal", "timedOut"] as const) {
  test(`generic Host never reports success after ${failure}`, async () => {
    const f = await fixture();
    try {
      const result: HostExecutionResult = { exitCode: 0, signal: failure === "signal" ? "SIGTERM" : null, stdout: "partial", stderr: "", timedOut: failure === "timedOut", cancelled: failure === "cancelled", outputLimited: failure === "outputLimited" };
      const kernel = new GenericCliHostKernel(f.store, f.profile, async () => result);
      const dispatch = kernel.prepare({ task_id: f.task.id, workspace: f.root, prompt: "go" }).dispatch as JsonObject;
      const executed = await kernel.execute({ dispatch_id: dispatch.id, prompt: "go" });
      assert.equal((executed.receipt as JsonObject).status, "failed");
    } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
  });
}

test("generic Host preserves unconfirmed cleanup instead of manufacturing a terminal receipt", async () => {
  const f = await fixture();
  try {
    const failure = new HostProcessCleanupError(new Error("simulated cleanup failure"));
    const driver = new GenericCliHostKernel(f.store, f.profile, async () => { throw failure; });
    const dispatch = driver.prepare({ task_id: f.task.id, workspace: f.root, prompt: "go" }).dispatch as JsonObject;
    await assert.rejects(driver.execute({ dispatch_id: dispatch.id, prompt: "go" }), error => error === failure);
    assert.equal(f.store.get(driver.dispatchKind, String(dispatch.id)).status, "running");
    await assert.rejects(driver.execute({ dispatch_id: dispatch.id, prompt: "go", resume: true }), /cleanup could not be confirmed/u);
    assert.equal(f.store.find(`${driver.dispatchKind}_receipt`, `receipt_${dispatch.id}`), null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
