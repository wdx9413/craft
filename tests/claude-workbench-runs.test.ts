import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { ClaudeWorkbenchAdapter } from "../core/interfaces/claude-workbench-adapter.ts";
import { ClaudeWorkbenchRuns } from "../core/interfaces/claude-workbench-runs.ts";

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

test("Claude run acknowledges creation only after durable reservation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-runs-"))); const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "t", {});
  let launches = 0; let dispatched = "";
  const adapter = new ClaudeWorkbenchAdapter(({ options, prompt }) => { launches++; dispatched = prompt; return { async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: options.sessionId, cwd: root, permissionMode: "default", model: "model" } as SDKMessage;
    yield { type: "result", subtype: "success", session_id: options.sessionId } as SDKMessage;
  }, close() {} }; });
  const runs = new ClaudeWorkbenchRuns(store, adapter);
  const args = { task_id: "t", workspace: root, permission: "ask" as const, operation_id: "first", executable: join(root, "claude"), prompt: "secret-marker" };
  try {
    const run = runs.create(args); assert.equal(store.list("workbench_claude_creation", 10).length, 1); assert.equal(launches, 0);
    assert.throws(() => runs.create(args), /already used/); args.prompt = "modified";
    await settle(); const events = runs.registry.events("t", run.run_id, 0);
    assert.equal(events.state, "completed"); assert.equal(events.events.length, 2); assert.equal(launches, 1); assert.equal(dispatched, "secret-marker");
    assert.equal(store.list("task_message", 10).length, 0); assert.equal(JSON.stringify(store.list("workbench_claude_creation", 10)).includes("secret-marker"), false);
    const cancelled = runs.create({ ...args, operation_id: "cancel" }); runs.close(); await settle();
    assert.equal(runs.registry.events("t", cancelled.run_id, 0).state, "unknown"); assert.equal(launches, 1);
  } finally { runs.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
