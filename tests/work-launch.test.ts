import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

const success = async () => ({ exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` });
const failure = async () => ({ exitCode: 2, signal: null, stderr: "failed", timedOut: false, cancelled: false, outputLimited: false, stdout: "" });
async function fixture(name: string) { const root = join(tmpdir(), `craft-launch-${name}-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store); service.codexHost.executor = success; service.claudeHost.executor = async () => ({ exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: JSON.stringify({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 2 }, total_cost_usd: 0.01 }) }); return { root, store, service }; }

test("work launch creates a task and immediately runs exact read-only work", async () => {
  const f = await fixture("read"); try {
    const input = { launch_id: "launch", title: "Inspect", goal: "Understand files", host: "codex-cli", workspace: f.root, prompt: "inspect", sandbox: "read-only" };
    const prepared = f.service.workLaunchPrepare(input); const launch = prepared.launch as JsonObject; assert.equal(prepared.approval_required, false); assert.equal(prepared.idempotent, false); assert.equal(JSON.stringify(launch).includes("inspect"), false);
    assert.equal(f.service.workLaunchPrepare(input).idempotent, true); assert.throws(() => f.service.workLaunchPrepare({ ...input, prompt: "drift" }), /conflict/); await f.service.hostRuns.wait(String(launch.run_id));
    assert.equal((f.service.workLaunchGet({ launch_id: launch.id }).launch as JsonObject).effective_status, "completed"); const trial = f.service.trialGet({ trial_id: launch.trial_id }); assert.equal((trial.outcome as JsonObject).verdict, "passed"); assert.equal(((trial.outcome as JsonObject).scores as JsonObject).host_execution_success, 1); assert.equal((trial.trace as JsonObject[]).length, 2); assert.equal(f.store.get("artifact", `artifact_${launch.run_id}`).kind, "host_run_receipt");
    assert.throws(() => f.service.workLaunchPrepare({ ...input, launch_id: "bad-host", host: "other" }), /unsupported/); assert.throws(() => f.service.workLaunchPrepare({ ...input, launch_id: "bad-sandbox", sandbox: "unsafe" }), /unsupported/); assert.throws(() => f.service.workLaunchPrepare({ ...input, launch_id: " " }), /launch_id/);
    assert.equal((f.service.info().counts as JsonObject).work_launch, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workspace-write launch requires an exact human decision before execution", async () => {
  const f = await fixture("write"); try {
    const deniedInput = { launch_id: "denied", title: "Edit", goal: "Update", host: "claude-code", workspace: f.root, prompt: "edit", sandbox: "workspace-write" }; const denied = f.service.workLaunchPrepare(deniedInput); assert.equal(denied.approval_required, true); assert.equal(f.service.workLaunchPrepare(deniedInput).approval_required, true); assert.equal((f.service.workLaunchGet({ launch_id: "denied" }).launch as JsonObject).effective_status, "awaiting_approval");
    assert.equal((f.service.workLaunchDecide({ launch_id: "denied", actor: "user", approved: false }).launch as JsonObject).status, "denied"); assert.throws(() => f.service.workLaunchDecide({ launch_id: "denied", actor: "user", approved: true, prompt: "edit" }), /awaiting/);
    f.service.workLaunchPrepare({ launch_id: "approved", title: "Edit", goal: "Update", host: "claude-code", workspace: f.root, prompt: "edit", sandbox: "workspace-write" }); assert.throws(() => f.service.workLaunchDecide({ launch_id: "approved", actor: "user", approved: true, prompt: "wrong" }), /digest/);
    const decided = f.service.workLaunchDecide({ launch_id: "approved", actor: "user", approved: true, prompt: "edit" }); assert.equal(decided.started, true); const launch = decided.launch as JsonObject; await f.service.hostRuns.wait(String(launch.run_id)); assert.equal((f.service.workLaunchGet({ launch_id: launch.id }).launch as JsonObject).effective_status, "completed"); assert.equal(f.store.get("autonomy_request", String(launch.authorization_request_id)).status, "consumed"); const outcome = f.store.get("outcome", `outcome_${launch.trial_id}`); assert.equal((outcome.costs as JsonObject).cost_usd, 0.01); assert.deepEqual((outcome.costs as JsonObject).usage, { input_tokens: 2 });
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("failed launches retry as new attempts and MCP exposes the complete protocol", async () => {
  const f = await fixture("retry"); try {
    f.service.codexHost.executor = failure; const mcp = new McpServer(f.service, "full");
    const first = await mcp.handlers.craft_work_launch_prepare({ launch_id: "first", title: "Try", goal: "Deliver", host: "codex-cli", workspace: f.root, prompt: "try", model: "model-a", timeout_ms: 5000, output_limit: 5000, acceptance_name: "Done", acceptance_criteria: [{ id: "owner", name: "Owner accepts", method: "human" }] }); const firstLaunch = first.launch as JsonObject; await f.service.hostRuns.wait(String(firstLaunch.run_id)); assert.equal(((await mcp.handlers.craft_work_launch_get({ launch_id: "first" })).launch as JsonObject).effective_status, "failed");
    assert.equal(f.store.get("outcome", `outcome_${firstLaunch.trial_id}`).verdict, "failed");
    f.service.codexHost.executor = success; const retried = await mcp.handlers.craft_work_launch_retry({ launch_id: "first", prompt: "try again" }); const second = retried.launch as JsonObject; assert.equal(second.retry_of, "first"); await f.service.hostRuns.wait(String(second.run_id));
    const inherited = f.store.get("codex_dispatch", String(second.dispatch_id)); assert.equal(inherited.model, "model-a"); assert.equal(inherited.timeout_ms, 5000); assert.equal(inherited.output_limit, 5000); assert.notEqual(second.acceptance_plan_id, firstLaunch.acceptance_plan_id); assert.equal((f.store.get("acceptance_plan", String(second.acceptance_plan_id)).criteria as JsonObject[])[0].id, "owner");
    assert.throws(() => f.service.workLaunchRetry({ launch_id: second.id, prompt: "again" }), /Only/); assert.throws(() => f.service.workLaunchRetry({ launch_id: "first", prompt: "again", new_launch_id: " " }), /new_launch_id/);
    const pending = await mcp.handlers.craft_work_launch_prepare({ launch_id: "pending", title: "Write", goal: "Edit", host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" }); assert.equal((pending.launch as JsonObject).status, "awaiting_approval"); const denied = await mcp.handlers.craft_work_launch_decide({ launch_id: "pending", actor: "user", approved: false }); assert.equal((denied.launch as JsonObject).status, "denied");
    f.service.workLaunchPrepare({ launch_id: "codex-write", title: "Write", goal: "Edit", host: "codex-cli", workspace: f.root, prompt: "edit", sandbox: "workspace-write" }); const codexWrite = f.service.workLaunchDecide({ launch_id: "codex-write", actor: "user", approved: true, prompt: "edit" }).launch as JsonObject; await f.service.hostRuns.wait(String(codexWrite.run_id));
    f.service.codexHost.executor = failure; const plain = f.service.workLaunchPrepare({ launch_id: "plain", title: "Try", goal: "Deliver", host: "codex-cli", workspace: f.root, prompt: "plain" }).launch as JsonObject; await f.service.hostRuns.wait(String(plain.run_id)); f.service.codexHost.executor = success; const plainRetry = f.service.workLaunchRetry({ launch_id: "plain", prompt: "plain again" }).launch as JsonObject; assert.equal(f.store.get("codex_dispatch", String(plainRetry.dispatch_id)).model, null); await f.service.hostRuns.wait(String(plainRetry.run_id));
    f.service.claudeHost.executor = failure; const claude = f.service.workLaunchPrepare({ launch_id: "claude-first", title: "Try", goal: "Deliver", host: "claude-code", workspace: f.root, prompt: "try", max_turns: 7, max_budget_usd: 2 }); const claudeLaunch = claude.launch as JsonObject; await f.service.hostRuns.wait(String(claudeLaunch.run_id)); f.service.claudeHost.executor = success;
    const claudeRetry = f.service.workLaunchRetry({ launch_id: "claude-first", new_launch_id: "claude-second", prompt: "try revised", model: "model-b", timeout_ms: 6000, output_limit: 6000, max_turns: 8, max_budget_usd: 3 }).launch as JsonObject; const claudeDispatch = f.store.get("claude_dispatch", String(claudeRetry.dispatch_id)); assert.equal(claudeDispatch.model, "model-b"); assert.equal(claudeDispatch.max_turns, 8); assert.equal(claudeDispatch.max_budget_usd, 3); await f.service.hostRuns.wait(String(claudeRetry.run_id));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("cancelled and owner-recovered launches produce distinct durable outcomes", async () => {
  const f = await fixture("terminal"); try {
    f.service.codexHost.executor = (request) => new Promise((resolve) => request.signal?.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false }), { once: true }));
    const cancelled = f.service.workLaunchPrepare({ launch_id: "cancelled", title: "Wait", goal: "Wait", host: "codex-cli", workspace: f.root, prompt: "wait" }).launch as JsonObject; f.service.hostRunCancel({ run_id: cancelled.run_id, reason: "user stopped" }); await f.service.hostRuns.wait(String(cancelled.run_id)); assert.equal(f.store.get("outcome", `outcome_${cancelled.trial_id}`).verdict, "cancelled");
    const interrupted = f.service.workLaunchPrepare({ launch_id: "interrupted", title: "Wait", goal: "Wait", host: "codex-cli", workspace: f.root, prompt: "wait" }).launch as JsonObject; const run = f.store.get("host_run", String(interrupted.run_id)); const recovering = new CraftService(f.store, undefined, undefined, undefined, undefined, "recovery-owner"); assert.equal(recovering.hostRunRecover({ owner_id: run.owner_id, confirmed_original_runner_stopped: true }).count, 1); const outcome = f.store.get("outcome", `outcome_${interrupted.trial_id}`); assert.equal(outcome.verdict, "blocked"); assert.equal(f.store.get("evidence", `evidence_${interrupted.run_id}`).confidence, "bounded"); assert.equal(f.store.get("artifact", `artifact_${interrupted.run_id}`).digest, null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
