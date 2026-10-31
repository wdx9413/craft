import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CodexWorkbenchSessions } from "../../core/interfaces/codex-workbench-sessions.ts";
import { ClaudeWorkbenchRuns } from "../../core/interfaces/claude-workbench-runs.ts";
import { ClaudeWorkbenchHistory } from "../../core/interfaces/claude-workbench-history.ts";
import { claudeWorkbenchModels } from "../../core/interfaces/claude-workbench-models.ts";
import { findClaudeExecutable } from "../../core/interfaces/claude-executable.ts";

// Explicit opt-in: this smoke calls real models and leaves native transcripts for inspection.
assert.equal(process.env.CRAFT_NATIVE_LIVE, "1", "Set CRAFT_NATIVE_LIVE=1 to authorize real model calls");
const codexModel = process.env.CRAFT_NATIVE_CODEX_MODEL;
const claudeModel = process.env.CRAFT_NATIVE_CLAUDE_MODEL;
assert.ok(codexModel && claudeModel, "Select both models explicitly with CRAFT_NATIVE_CODEX_MODEL and CRAFT_NATIVE_CLAUDE_MODEL");
const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-native-dialogue-")));
const workspace = join(root, "project"); mkdirSync(workspace);
const store = await new CraftStore(craftPaths(join(root, "data"))).open();
const receipt: Record<string, unknown> = { root, platform: process.platform, node: process.version, started_at: new Date().toISOString() };
const pause = () => new Promise(resolve => setTimeout(resolve, 150));
async function until<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    assert.ok(Date.now() < deadline, "Native turn exceeded 90 seconds; inspect native history before retrying");
    await pause();
  }
}

async function codex() {
  const task = "native-codex"; store.create("task", task, { title: "Native dialogue smoke" });
  let sessions = new CodexWorkbenchSessions(store);
  const marker = `craft_${randomUUID().replaceAll("-", "")}`;
  try {
    const catalog = await sessions.models();
    assert.ok((catalog.models as Array<{ id: string }>).some(model => model.id === codexModel), "Selected Codex model is not in live catalog");
    const created = await sessions.create({ task_id: task, workspace, model: codexModel, permission: "ask", operation_id: randomUUID() });
    const link = created.link as Record<string, unknown>; const id = String(link.id);
    const turn = async (prompt: string) => {
      await sessions.send(task, id, prompt, randomUUID());
      const result = await until(() => sessions.events(task, id, null, 0), state => {
        const status = state.status as { link: Record<string, unknown> };
        return !["starting", "running"].includes(String(status.link.turn_state));
      });
      const status = result.status as { link: Record<string, unknown> };
      assert.equal(status.link.turn_state, "idle"); assert.equal(status.link.last_turn_status, "completed");
    };
    await turn(`Remember this marker: ${marker}. Reply with the marker only. Do not use tools.`);
    const first = await sessions.history(task, id);
    assert.ok(JSON.stringify(first).includes(marker));
    sessions.close(); await new Promise(resolve => setTimeout(resolve, 500));
    sessions = new CodexWorkbenchSessions(store);
    await sessions.resume(task, id);
    await turn("What marker did I ask you to remember? Reply with that marker only. Do not use tools.");
    const history = await sessions.history(task, id);
    const thread = history.thread as { turns: Array<{ items: Array<{ type: string; text?: string }> }> };
    const answers = thread.turns.flatMap(turn => turn.items).filter(item => item.type === "agentMessage").map(item => item.text ?? "");
    assert.ok(answers.length >= 2 && answers.slice(-2).every(text => text.includes(marker)), "Both native assistant replies must contain the marker");
    assert.equal(sessions.links.get(task, id).native_session_id, link.native_session_id);
    return { passed: true, model: codexModel, native_session_id: link.native_session_id, assistant_replies: answers.length, resumed: true };
  } finally { sessions.close(); }
}

async function claude() {
  const task = "native-claude"; store.create("task", task, { title: "Native dialogue smoke" });
  let runs = new ClaudeWorkbenchRuns(store);
  const executable = findClaudeExecutable(); const marker = `craft_${randomUUID().replaceAll("-", "")}`;
  try {
    const catalog = await claudeWorkbenchModels(workspace);
    assert.ok(catalog.models.some(model => model.id === claudeModel && model.id !== "default"), "Selected Claude model is not in live catalog");
    const wait = async (runId: string) => {
      const result = await until(() => runs.registry.events(task, runId, 0), state => state.state !== "running");
      assert.equal(result.state, "completed", `Claude run outcome: ${result.reason}`);
      assert.ok(result.events.some(({ event }) => event.type === "result" && event.subtype === "success" && !event.is_error), "Claude result must be successful");
    };
    const first = runs.create({ task_id: task, workspace, model: claudeModel, permission: "ask", operation_id: randomUUID(), executable, prompt: `Remember this marker: ${marker}. Reply with the marker only. Do not use tools.` });
    await wait(first.run_id);
    const links = runs.first.links.list(task).links as Array<Record<string, unknown>>; assert.equal(links.length, 1);
    const link = links[0]; const id = String(link.id);
    runs.close(); runs = new ClaudeWorkbenchRuns(store);
    const next = runs.send({ task_id: task, link_id: id, executable, operation_id: randomUUID(), prompt: "What marker did I ask you to remember? Reply with that marker only. Do not use tools." });
    await wait(next.run_id);
    const history = await new ClaudeWorkbenchHistory(runs.first.links).read(task, id);
    const answers = history.messages.filter(message => message.type === "assistant");
    assert.ok(answers.length >= 2 && answers.slice(-2).every(message => JSON.stringify(message).includes(marker)), "Both native assistant replies must contain the marker");
    assert.equal(runs.first.links.get(task, id).native_session_id, link.native_session_id);
    return { passed: true, model: claudeModel, native_session_id: link.native_session_id, assistant_replies: answers.length, resumed: true };
  } finally { runs.close(); }
}

try {
  for (const [provider, run] of [["codex", codex], ["claude", claude]] as const) {
    try { receipt[provider] = await run(); }
    catch (error) { receipt[provider] = { passed: false, error: error instanceof Error ? error.message : String(error) }; process.exitCode = 1; }
    writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ provider, result: receipt[provider] }));
  }
  assert.equal(store.list("task_message", 10).length, 0, "Native dialogue must not be duplicated in Craft task messages");
  receipt.task_messages = 0;
} finally {
  receipt.finished_at = new Date().toISOString();
  writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  store.close(); console.log(`Receipt: ${join(root, "receipt.json")}`);
}
