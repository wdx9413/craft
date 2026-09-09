import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexHostKernel, executeCodex, type CodexExecutor } from "../src/codex-driver.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { McpServer } from "../src/mcp.ts";

async function fixture(name: string, executor: CodexExecutor) {
  const root = join(tmpdir(), `craft-codex-${name}-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store); const task = service.taskOpen({ title: name, goal: "Run Codex safely" }).task as JsonObject;
  return { root, store, service, task, driver: new CodexHostKernel(store, executor) };
}
const success: CodexExecutor = async () => ({ exitCode: 0, signal: null, stderr: "progress", timedOut: false, outputLimited: false,
  stdout: [JSON.stringify({ type: "thread.started", thread_id: "thread-1" }), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } })].join("\n") });

test("Codex Host Driver prepares exact read-only work and records JSONL receipts", async () => {
  const f = await fixture("read", success);
  try {
    const prepared = f.driver.prepare({ dispatch_id: "d1", task_id: f.task.id, workspace: f.root, prompt: "inspect", model: "gpt-test", timeout_ms: 2000, output_limit: 4096 });
    assert.equal(prepared.idempotent, false); assert.equal((prepared.dispatch as JsonObject).sandbox, "read-only");
    assert.equal(f.driver.prepare({ dispatch_id: "d1", task_id: f.task.id, workspace: f.root, prompt: "inspect", model: "gpt-test", timeout_ms: 2000, output_limit: 4096 }).idempotent, true);
    assert.throws(() => f.driver.prepare({ dispatch_id: "d1", task_id: f.task.id, workspace: f.root, prompt: "changed" }), /idempotency/);
    const result = await f.driver.execute({ dispatch_id: "d1", prompt: "inspect" }); const receipt = result.receipt as JsonObject;
    assert.equal(receipt.status, "completed"); assert.equal(receipt.thread_id, "thread-1"); assert.equal(receipt.final_message, "done"); assert.deepEqual(receipt.event_types, ["thread.started", "item.completed", "turn.completed"]);
    assert.match(await readFile(new URL(String(receipt.uri)), "utf8"), /"host": "codex-cli"/u); assert.equal((await f.driver.execute({ dispatch_id: "d1", prompt: "inspect" })).idempotent, true);
    assert.equal(f.store.events(`task:${f.task.id}`).at(-1)?.event_type, "host.codex.completed");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Codex Host Driver binds workspace writes to one exact Craft authorization", async () => {
  let requestSeen: JsonObject | undefined; const capture: CodexExecutor = async (request) => { requestSeen = request as unknown as JsonObject; return success(request); };
  const f = await fixture("write", capture);
  try {
    const dispatch = f.driver.prepare({ dispatch_id: "write", task_id: f.task.id, workspace: f.root, prompt: "edit", sandbox: "workspace-write" }).dispatch as JsonObject;
    const policy = f.service.autonomyPolicySave({ policy_id: "policy", task_id: f.task.id, name: "Writes", rules: { sandbox_write: { level: "human_approval" } } }).policy as JsonObject;
    const authorization = f.service.autonomyRequest({ request_id: "approval", policy_id: policy.id, policy_version: policy.version, task_id: f.task.id, action: "sandbox_write", target: dispatch.workspace, request_digest: dispatch.request_digest, requested_by: "driver" }).request as JsonObject;
    await assert.rejects(f.driver.execute({ dispatch_id: dispatch.id, prompt: "edit", authorization_request_id: authorization.id }), /not authorized/);
    f.service.autonomyDecide({ request_id: authorization.id, decision: "approve", actor: "human", approval_ref: "ui:1" });
    const result = await f.driver.execute({ dispatch_id: dispatch.id, prompt: "edit", authorization_request_id: authorization.id });
    assert.equal((result.dispatch as JsonObject).status, "completed"); assert.deepEqual((requestSeen?.argv as string[]).slice(0, 6), ["exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "--cd"]); assert.equal((requestSeen?.argv as string[]).at(-1), "-");
    const replay = f.driver.prepare({ dispatch_id: "replay", task_id: f.task.id, workspace: f.root, prompt: "edit", sandbox: "workspace-write" }).dispatch as JsonObject;
    const replayAuthorization = f.service.autonomyRequest({ request_id: "replay-approval", policy_id: policy.id, policy_version: policy.version, task_id: f.task.id, action: "sandbox_write", target: replay.workspace, request_digest: replay.request_digest, requested_by: "driver" }).request as JsonObject;
    f.service.autonomyDecide({ request_id: replayAuthorization.id, decision: "approve", actor: "human", approval_ref: "ui:2" });
    f.service.autonomyConsume({ request_id: replayAuthorization.id, task_id: f.task.id, action: "sandbox_write", target: replay.workspace, request_digest: replay.request_digest, idempotency_key: `codex:${replay.id}` });
    await assert.rejects(f.driver.execute({ dispatch_id: replay.id, prompt: "edit", authorization_request_id: replayAuthorization.id }), /already consumed/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Codex Host Driver fails closed on drift, invalid input, process errors, and malformed output", async () => {
  const f = await fixture("failure", async () => { throw new Error("missing executable"); });
  try {
    assert.throws(() => f.driver.prepare({ task_id: f.task.id, workspace: f.root, prompt: " " }), /empty/);
    assert.throws(() => f.driver.prepare({ task_id: f.task.id, workspace: f.root, prompt: "x", sandbox: "unsafe" }), /unsupported/); assert.throws(() => f.driver.prepare({ task_id: f.task.id, workspace: f.root, prompt: "x", timeout_ms: 1 }), /timeout_ms/); assert.throws(() => f.driver.prepare({ task_id: f.task.id, workspace: f.root, prompt: "x", output_limit: 1 }), /output_limit/);
    const dispatch = f.driver.prepare({ dispatch_id: "error", task_id: f.task.id, workspace: f.root, prompt: "x" }).dispatch as JsonObject; await assert.rejects(f.driver.execute({ dispatch_id: dispatch.id, prompt: "wrong" }), /digest/);
    assert.equal(((await f.driver.execute({ dispatch_id: dispatch.id, prompt: "x" })).receipt as JsonObject).status, "failed");
    const nonError = new CodexHostKernel(f.store, async () => { throw "non-error failure"; }); nonError.prepare({ dispatch_id: "non-error", task_id: f.task.id, workspace: f.root, prompt: "x" }); assert.equal(((await nonError.execute({ dispatch_id: "non-error", prompt: "x" })).receipt as JsonObject).status, "failed");
    const aborted = new AbortController(); aborted.abort(); const cancelled = new CodexHostKernel(f.store, async () => { throw new Error("cancelled"); }); cancelled.prepare({ dispatch_id: "cancelled", task_id: f.task.id, workspace: f.root, prompt: "x" }); assert.equal(((await cancelled.execute({ dispatch_id: "cancelled", prompt: "x" }, { signal: aborted.signal })).receipt as JsonObject).cancelled, true);
    const flagged = new CodexHostKernel(f.store, async () => ({ exitCode: 1, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false })); flagged.prepare({ dispatch_id: "flagged", task_id: f.task.id, workspace: f.root, prompt: "x" }); assert.equal(((await flagged.execute({ dispatch_id: "flagged", prompt: "x" })).receipt as JsonObject).cancelled, true);
    const malformed = new CodexHostKernel(f.store, async () => ({ exitCode: 0, signal: null, stdout: "null\n1\n[]\nnot-json", stderr: "", timedOut: false, outputLimited: true }));
    const second = malformed.prepare({ dispatch_id: "bad-json", task_id: f.task.id, workspace: f.root, prompt: "x" }).dispatch as JsonObject; const bad = await malformed.execute({ dispatch_id: second.id, prompt: "x" }); assert.equal((bad.receipt as JsonObject).invalid_jsonl_lines, 4); assert.equal((bad.receipt as JsonObject).output_limited, true);
    for (const [id, execution] of [["empty", { exitCode: 0, signal: null, stdout: "{}", stderr: "", timedOut: false, outputLimited: false }], ["exit", { exitCode: 2, signal: null, stdout: "{}", stderr: "", timedOut: false, outputLimited: false }], ["timeout", { exitCode: 0, signal: "SIGTERM" as NodeJS.Signals, stdout: "{}", stderr: "", timedOut: true, outputLimited: false }]] as const) {
      const driver = new CodexHostKernel(f.store, async () => execution); driver.prepare({ dispatch_id: id, task_id: f.task.id, workspace: f.root, prompt: "x" }); const result = await driver.execute({ dispatch_id: id, prompt: "x" }); assert.ok((result.receipt as JsonObject).status);
    }
    f.store.save("codex_dispatch", "blocked", { ...second, status: "running" }); await assert.rejects(malformed.execute({ dispatch_id: "blocked", prompt: "x" }), /not executable/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("service and full MCP expose prepared and executed Codex dispatches", async () => {
  const f = await fixture("mcp", success);
  try {
    f.service.codexHost.executor = success; const mcp = new McpServer(f.service, "full");
    const prepared = await mcp.handlers.craft_codex_dispatch_prepare({ dispatch_id: "mcp", task_id: f.task.id, workspace: f.root, prompt: "inspect" }); assert.equal((prepared.dispatch as JsonObject).status, "prepared");
    const executed = await mcp.handlers.craft_codex_dispatch_execute({ dispatch_id: "mcp", prompt: "inspect" }); assert.equal((executed.receipt as JsonObject).status, "completed");
    assert.ok(mcp.tools.some((item) => item.name === "craft_codex_dispatch_prepare"));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Codex process executor uses argv without a shell and bounds or terminates output", async () => {
  const observed: JsonObject[] = []; const normal = await executeCodex({ executable: process.execPath, argv: ["-e", "process.stdin.resume();process.stdin.on('end',()=>{console.log('ok');console.error('note')})"], cwd: process.cwd(), stdin: "x", timeoutMs: 2000, outputLimit: 4096, observe: (event) => observed.push(event) }); assert.equal(normal.exitCode, 0); assert.match(normal.stdout, /ok/u); assert.match(normal.stderr, /note/u); assert.equal(normal.timedOut, false); assert.deepEqual(new Set(observed.map((event) => event.stream)), new Set(["stdout", "stderr"])); assert.ok(observed.every((event) => typeof event.digest === "string" && Number(event.bytes) > 0));
  assert.equal((await executeCodex({ executable: process.execPath, argv: ["-e", "console.log('x'.repeat(5000))"], cwd: process.cwd(), stdin: "", timeoutMs: 2000, outputLimit: 100 })).outputLimited, true);
  assert.equal((await executeCodex({ executable: process.execPath, argv: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), stdin: "", timeoutMs: 50, outputLimit: 100 })).timedOut, true);
  const controller = new AbortController(); const cancelled = executeCodex({ executable: process.execPath, argv: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), stdin: "", timeoutMs: 2000, outputLimit: 100, signal: controller.signal }); controller.abort(); assert.equal((await cancelled).cancelled, true);
  const preCancelled = new AbortController(); preCancelled.abort(); assert.equal((await executeCodex({ executable: process.execPath, argv: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), stdin: "", timeoutMs: 2000, outputLimit: 100, signal: preCancelled.signal })).cancelled, true);
  await assert.rejects(executeCodex({ executable: "craft-command-that-does-not-exist", argv: [], cwd: process.cwd(), stdin: "", timeoutMs: 100, outputLimit: 100 }));
});
