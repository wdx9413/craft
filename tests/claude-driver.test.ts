import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeHostKernel } from "../src/claude-driver.ts";
import type { HostExecutor } from "../src/host-driver.ts";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

const success: HostExecutor = async () => ({ exitCode: 0, signal: null, stderr: "progress", timedOut: false, outputLimited: false, stdout: [
  JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "fallback" }, null, "bad"] } }),
  JSON.stringify({ type: "result", subtype: "success", result: "token=secret-value", usage: { input_tokens: 3 }, total_cost_usd: 0.02 }),
].join("\n") });
async function fixture(name: string, executor: HostExecutor = success) { const root = join(tmpdir(), `craft-claude-${name}-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store); const task = service.taskOpen({ title: name, goal: "Run Claude safely" }).task as JsonObject; return { root, store, service, task, driver: new ClaudeHostKernel(store, executor) }; }

test("Claude Driver prepares bounded read-only execution and captures a sanitized stream receipt", async () => {
  let seen: JsonObject | undefined; const f = await fixture("read", async (request) => { seen = request as unknown as JsonObject; return success(request); });
  try {
    const prepared = f.driver.prepare({ dispatch_id: "read", task_id: f.task.id, workspace: f.root, prompt: "inspect", model: "sonnet", max_turns: 4, max_budget_usd: 1.5, timeout_ms: 2000, output_limit: 4096 }); const dispatch = prepared.dispatch as JsonObject;
    assert.equal(prepared.idempotent, false); assert.equal(f.driver.host, "claude-code"); assert.equal(f.driver.prepare({ dispatch_id: "read", task_id: f.task.id, workspace: f.root, prompt: "inspect", model: "sonnet", max_turns: 4, max_budget_usd: 1.5, timeout_ms: 2000, output_limit: 4096 }).idempotent, true);
    assert.match(String((f.driver.prepare({ task_id: f.task.id, workspace: f.root, prompt: "generated" }).dispatch as JsonObject).id), /^claude_dispatch_[a-f0-9]{32}$/u);
    assert.throws(() => f.driver.prepare({ dispatch_id: "read", task_id: f.task.id, workspace: f.root, prompt: "drift" }), /idempotency/);
    const result = await f.driver.execute({ dispatch_id: dispatch.id, prompt: "inspect" }); const receipt = result.receipt as JsonObject; assert.equal(receipt.status, "completed"); assert.equal(receipt.session_id, "session-1"); assert.equal(receipt.final_message, "[redacted]"); assert.equal(receipt.cost_usd, 0.02); assert.match(await readFile(new URL(String(receipt.uri)), "utf8"), /claude-code/u);
    const argv = seen?.argv as string[]; assert.ok(argv.includes("plan")); assert.ok(argv.includes("Read,Glob,Grep")); assert.ok(argv.includes("--max-budget-usd")); assert.ok(argv.includes("--model")); assert.equal(seen?.stdin, "inspect"); assert.equal((await f.driver.execute({ dispatch_id: dispatch.id, prompt: "inspect" })).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Claude workspace writes consume exact Craft authorization and expose MCP protocol", async () => {
  const f = await fixture("write");
  try {
    const dispatch = f.driver.prepare({ dispatch_id: "write", task_id: f.task.id, workspace: f.root, prompt: "edit", sandbox: "workspace-write" }).dispatch as JsonObject;
    const policy = f.service.autonomyPolicySave({ policy_id: "policy", task_id: f.task.id, name: "Writes", rules: { sandbox_write: { level: "human_approval" } } }).policy as JsonObject;
    const auth = f.service.autonomyRequest({ request_id: "auth", policy_id: policy.id, policy_version: policy.version, task_id: f.task.id, action: "sandbox_write", target: dispatch.workspace, request_digest: dispatch.request_digest, requested_by: "driver" }).request as JsonObject;
    await assert.rejects(f.driver.execute({ dispatch_id: dispatch.id, prompt: "edit", authorization_request_id: auth.id }), /not authorized/); f.service.autonomyDecide({ request_id: auth.id, decision: "approve", actor: "human", approval_ref: "ui:1" });
    let seen: JsonObject | undefined; f.driver.executor = async (request) => { seen = request as unknown as JsonObject; return success(request); }; assert.equal(((await f.driver.execute({ dispatch_id: dispatch.id, prompt: "edit", authorization_request_id: auth.id })).receipt as JsonObject).status, "completed"); assert.ok((seen?.argv as string[]).includes("acceptEdits")); assert.ok((seen?.argv as string[]).includes("Read,Glob,Grep,Edit,Write"));
    const replay = f.driver.prepare({ dispatch_id: "replay", task_id: f.task.id, workspace: f.root, prompt: "edit", sandbox: "workspace-write" }).dispatch as JsonObject; const replayAuth = f.service.autonomyRequest({ request_id: "replay-auth", policy_id: policy.id, policy_version: policy.version, task_id: f.task.id, action: "sandbox_write", target: replay.workspace, request_digest: replay.request_digest, requested_by: "driver" }).request as JsonObject; f.service.autonomyDecide({ request_id: replayAuth.id, decision: "approve", actor: "human", approval_ref: "ui:2" }); f.service.autonomyConsume({ request_id: replayAuth.id, task_id: f.task.id, action: "sandbox_write", target: replay.workspace, request_digest: replay.request_digest, idempotency_key: `claude:${replay.id}` }); await assert.rejects(f.driver.execute({ dispatch_id: replay.id, prompt: "edit", authorization_request_id: replayAuth.id }), /already consumed/);
    f.service.claudeHost.executor = success; const mcp = new McpServer(f.service, "full"); const prepared = await mcp.handlers.craft_claude_dispatch_prepare({ dispatch_id: "mcp", task_id: f.task.id, workspace: f.root, prompt: "inspect" }); assert.equal((prepared.dispatch as JsonObject).status, "prepared"); assert.equal(((await mcp.handlers.craft_claude_dispatch_execute({ dispatch_id: "mcp", prompt: "inspect" })).receipt as JsonObject).status, "completed"); assert.ok(mcp.tools.some((item) => item.name === "craft_claude_dispatch_prepare"));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Claude Driver fails closed on invalid configuration, drift, replay, process and protocol failure", async () => {
  const f = await fixture("fail", async () => { throw new Error("missing"); });
  try {
    assert.throws(() => f.driver.prepare({ task_id: f.task.id, workspace: f.root, prompt: " " }), /empty/); assert.throws(() => f.driver.prepare({ task_id: f.task.id, workspace: f.root, prompt: "x", sandbox: "danger" }), /unsupported/); assert.throws(() => f.driver.prepare({ task_id: f.task.id, workspace: f.root, prompt: "x", max_turns: 0 }), /max_turns/); assert.throws(() => f.driver.prepare({ task_id: f.task.id, workspace: f.root, prompt: "x", max_budget_usd: 0 }), /max_budget/); assert.throws(() => f.driver.prepare({ task_id: f.task.id, workspace: f.root, prompt: "x", max_budget_usd: "bad" }), /max_budget/);
    const dispatch = f.driver.prepare({ dispatch_id: "error", task_id: f.task.id, workspace: f.root, prompt: "x" }).dispatch as JsonObject; await assert.rejects(f.driver.execute({ dispatch_id: dispatch.id, prompt: "y" }), /digest/); assert.equal(((await f.driver.execute({ dispatch_id: dispatch.id, prompt: "x" })).receipt as JsonObject).status, "failed");
    const nonError = new ClaudeHostKernel(f.store, async () => { throw "bad"; }); nonError.prepare({ dispatch_id: "non-error", task_id: f.task.id, workspace: f.root, prompt: "x" }); await nonError.execute({ dispatch_id: "non-error", prompt: "x" });
    const aborted = new AbortController(); aborted.abort(); const cancelled = new ClaudeHostKernel(f.store, async () => { throw new Error("cancelled"); }); cancelled.prepare({ dispatch_id: "cancelled", task_id: f.task.id, workspace: f.root, prompt: "x" }); assert.equal(((await cancelled.execute({ dispatch_id: "cancelled", prompt: "x" }, { signal: aborted.signal })).receipt as JsonObject).cancelled, true);
    const flagged = new ClaudeHostKernel(f.store, async () => ({ exitCode: 1, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false })); flagged.prepare({ dispatch_id: "flagged", task_id: f.task.id, workspace: f.root, prompt: "x" }); assert.equal(((await flagged.execute({ dispatch_id: "flagged", prompt: "x" })).receipt as JsonObject).cancelled, true);
    const variants = [
      ["assistant", { exitCode: 0, timedOut: false, stdout: `${JSON.stringify({ type: "assistant", message: { content: "bad" } })}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } })}\n${JSON.stringify({ type: "result", session_id: "s2", subtype: "success", total_cost_usd: "bad", usage: [] })}` }],
      ["invalid", { exitCode: 0, timedOut: false, stdout: "null\n1\n[]\nbad" }], ["timeout", { exitCode: 0, timedOut: true, stdout: "{}" }], ["exit", { exitCode: 2, timedOut: false, stdout: "{}" }], ["result-error", { exitCode: 0, timedOut: false, stdout: JSON.stringify({ type: "result", subtype: "error" }) }],
    ] as const;
    for (const [id, variant] of variants) { const driver = new ClaudeHostKernel(f.store, async () => ({ signal: null, stderr: "", outputLimited: false, ...variant })); driver.prepare({ dispatch_id: id, task_id: f.task.id, workspace: f.root, prompt: "x" }); const result = await driver.execute({ dispatch_id: id, prompt: "x" }); assert.ok((result.receipt as JsonObject).status); }
    const blocked = f.driver.prepare({ dispatch_id: "blocked", task_id: f.task.id, workspace: f.root, prompt: "x" }).dispatch as JsonObject; f.store.save("claude_dispatch", "blocked", { ...blocked, status: "running" }); await assert.rejects(f.driver.execute({ dispatch_id: "blocked", prompt: "x" }), /not executable/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
