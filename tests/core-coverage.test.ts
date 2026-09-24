import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AutonomyKernel } from "../core/autonomy.ts";
import { GenericCliHostKernel } from "../core/generic-driver.ts";
import { defineHooks } from "../core/hooks.ts";
import { defineHostProfile, hostProfilesFromConfig } from "../core/host-registry.ts";
import { KnowledgeIndex, locateSnippet, scanKnowledgeBase } from "../core/knowledge-index.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { classifyComplexity } from "../core/token-budget.ts";
import { describeJsonFailure, normalizeWorkflowDefinition } from "../core/workflow-registry.ts";

async function scratch(name: string) {
  const root = await mkdtemp(join(tmpdir(), `craft-cov-${name}-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store };
}

const profile = () => defineHostProfile({
  host: "cov-host", kind: "agent-cli", command: "node", output_format: "text",
  argv_template: ["-p", "{prompt}"], models: [], default_model: null,
});
const ok = { exitCode: 0, signal: null, stdout: "ok", stderr: "", timedOut: false, outputLimited: false };

test("generic driver rejects empty text, bad integers, unknown sandbox and duplicate dispatch", async () => {
  const f = await scratch("g1");
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    const kernel = new GenericCliHostKernel(f.store, profile(), async () => ok);
    assert.throws(() => kernel.prepare({ workspace: f.root, prompt: "go" }), /task_id must not be empty/);
    assert.throws(() => kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "go", sandbox: "bogus" }), /sandbox is unsupported/);
    assert.throws(() => kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "go", timeout_ms: 10 }), /timeout_ms must be an integer/);
    // A valid explicit timeout exercises the `Number(value)` arm instead of the default.
    const explicit = kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "go", timeout_ms: 1_000 }) as JsonObject;
    assert.equal((explicit.dispatch as JsonObject).timeout_ms, 1_000);
    const again = kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "go" }) as JsonObject;
    assert.equal((again.dispatch as JsonObject).id, (again.dispatch as JsonObject).id);
    const first = kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "one", dispatch_id: "dup" }) as JsonObject;
    assert.ok(first.dispatch);
    assert.throws(() => kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "two", dispatch_id: "dup" }), /idempotency conflict/);
    // Replaying the identical request is idempotent, not an error.
    const replay = kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "one", dispatch_id: "dup" }) as JsonObject;
    assert.equal(replay.idempotent, true);
    assert.equal((replay.dispatch as JsonObject).id, "dup");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("generic driver refuses a dispatch that is not executable", async () => {
  const f = await scratch("g2");
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    const kernel = new GenericCliHostKernel(f.store, profile(), async () => ok);
    const prepared = kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "go" }) as JsonObject;
    const dispatch = prepared.dispatch as JsonObject;
    f.store.save(kernel.dispatchKind, String(dispatch.id), { ...dispatch, status: "running" });
    await assert.rejects(kernel.execute({ dispatch_id: dispatch.id, prompt: "go" }), /not executable/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("generic driver consumes workspace-write authorization exactly once", async () => {
  const f = await scratch("g3");
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    const kernel = new GenericCliHostKernel(f.store, profile(), async () => ok);
    const prepared = kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "go", sandbox: "workspace-write" }) as JsonObject;
    const dispatch = prepared.dispatch as JsonObject;
    const autonomy = new AutonomyKernel(f.store);
    autonomy.policySave({ policy_id: "pol", task_id: task.id, name: "coverage policy", rules: { sandbox_write: { level: "automatic" } } });
    autonomy.request({ policy_id: "pol", policy_version: 1, task_id: task.id, action: "sandbox_write",
      target: resolve(f.root), request_digest: dispatch.request_digest, requested_by: "tester", request_id: "req" });
    const executed = await kernel.execute({ dispatch_id: dispatch.id, prompt: "go", authorization_request_id: "req" }) as JsonObject;
    assert.equal((executed.receipt as JsonObject).status, "completed");
    assert.ok(String((executed.dispatch as JsonObject).authorization_consumption_id).length > 0);

    // A second dispatch reusing an already-consumed authority must be refused.
    const second = kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "go", sandbox: "workspace-write" }) as JsonObject;
    const secondDispatch = second.dispatch as JsonObject;
    autonomy.request({ policy_id: "pol", policy_version: 1, task_id: task.id, action: "sandbox_write",
      target: resolve(f.root), request_digest: secondDispatch.request_digest, requested_by: "tester", request_id: "req2" });
    f.store.create("autonomy_consumption", "autonomy_use_req2", { request_id: "req2", task_id: task.id,
      action: "sandbox_write", target: resolve(f.root), request_digest: secondDispatch.request_digest,
      idempotency_key: `cov-host:${String(secondDispatch.id)}`, notification_ref: null, consumed_at: new Date().toISOString() });
    await assert.rejects(kernel.execute({ dispatch_id: secondDispatch.id, prompt: "go", authorization_request_id: "req2" }), /already consumed/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("generic driver records a failed receipt when the host process throws", async () => {
  const f = await scratch("g4");
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    const kernel = new GenericCliHostKernel(f.store, profile(), async () => { throw new Error("spawn failed"); });
    const prepared = kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "go" }) as JsonObject;
    const executed = await kernel.execute({ dispatch_id: (prepared.dispatch as JsonObject).id, prompt: "go" },
      { signal: new AbortController().signal }) as JsonObject;
    const receipt = executed.receipt as JsonObject;
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.cancelled, false);
    assert.match(String(receipt.stderr_digest), /^sha256:/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("generic driver survives a host that throws a non-Error", async () => {
  const f = await scratch("g5");
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    // A misbehaving transport can reject with anything; the driver must still terminate.
    const kernel = new GenericCliHostKernel(f.store, profile(), (async () => { throw "string failure"; }) as never);
    const prepared = kernel.prepare({ task_id: task.id, workspace: f.root, prompt: "go" }) as JsonObject;
    const executed = await kernel.execute({ dispatch_id: (prepared.dispatch as JsonObject).id, prompt: "go" }) as JsonObject;
    assert.equal((executed.receipt as JsonObject).status, "failed");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("hooks and host profiles fail closed on malformed entries", () => {
  assert.throws(() => defineHooks([1]), /Each hook must be an object/);
  assert.throws(() => hostProfilesFromConfig([1]), /Each declared host must be an object/);
  const base = { host: "cov", kind: "agent-cli", command: "x", output_format: "text" };
  assert.throws(() => defineHostProfile({ ...base, argv_template: "x" }), /must be an array of strings/);
  assert.throws(() => defineHostProfile({ ...base, argv_template: ["a"], models: ["m", "m"] }), /must not repeat an entry/);
});

test("knowledge scan skips links and enforces its file limit", async () => {
  const f = await scratch("k1");
  try {
    await mkdir(join(f.root, "real"), { recursive: true });
    await writeFile(join(f.root, "real", "a.md"), "# A\nalpha beta gamma");
    await writeFile(join(f.root, "b.md"), "beta");
    await symlink(join(f.root, "real"), join(f.root, "link"), "junction");
    const documents = scanKnowledgeBase(f.root);
    assert.deepEqual(documents.map((item) => item.path).sort(), ["b.md", "real/a.md"]);
    assert.throws(() => scanKnowledgeBase(f.root, { limit: 1 }), /exceeds 1 files/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("knowledge search covers both tokenizers and null headings", async () => {
  const f = await scratch("k2");
  try {
    await writeFile(join(f.root, "plain.md"), "hello world without any heading");
    const index = new KnowledgeIndex(join(f.root, "index.db"));
    try {
      const current = scanKnowledgeBase(f.root);
      index.apply({ added: current, changed: [], removed: [] }, f.root);
      const trigram = index.search("hello");
      assert.equal(trigram.length, 1);
      assert.equal(trigram[0].heading, null);
      const like = index.search("h");
      assert.equal(like.length, 1);
      assert.equal(like[0].heading, null);
    } finally { index.close(); }
    assert.deepEqual(locateSnippet("abc xyz", ["yz", "ab"]).length > 0, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("token budget and workflow definitions report missing optional input", () => {
  assert.equal(classifyComplexity({ distinct_paths: 0, context_chars: 0,
    requires_external_write: false, requires_multi_step_reasoning: false } as never), "small");
  assert.throws(() => normalizeWorkflowDefinition(null), /must be an object/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "wf", title: "T" }), /at least one step/);
  assert.match(describeJsonFailure("w.json", new Error("bad")), /\(bad\)$/);
  assert.match(describeJsonFailure("w.json", "string failure"), /\(string failure\)$/);
});
