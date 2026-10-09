import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

interface HookCommand { command: string; timeout: number }
interface HookManifest { hooks: Record<string, Array<{ hooks: HookCommand[] }>> }
const root = resolve(import.meta.dirname, "..");

async function replayFixture(host: "codex" | "claude") {
  const temporary = await mkdtemp(join(tmpdir(), "craft-hook-process-"));
  const data = join(temporary, "data");
  const manifest = JSON.parse(await readFile(join(root, "plugins/craft-context/hooks", host === "codex" ? "codex-hooks.json" : "hooks.json"), "utf8")) as HookManifest;
  const bundle = join(root, "plugins/craft-context/dist/plugin/craft-codex-hook.cjs");
  const repository = join(temporary, "repo");
  const git = spawnSync("git", ["init", "-q", repository], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  const store = await new CraftStore(craftPaths(data)).open();
  const base = { cwd: repository, session_id: `${host}-process`, source: host };
  const execute = (event: JsonObject): Promise<JsonObject> => new Promise((resolveResult, reject) => {
    const eventName = String(event.hook_event_name);
    const handler = manifest.hooks[eventName]?.[0]?.hooks[0];
    assert(handler, `Missing ${host} ${eventName} command`);
    assert.equal(handler.command, `node "\${${host === "codex" ? "PLUGIN_ROOT" : "CLAUDE_PLUGIN_ROOT"}}/dist/plugin/craft-codex-hook.cjs" --member context`);
    const child = spawn(process.execPath, [bundle, "--member", "context"], { cwd: repository,
      env: { PATH: process.env.PATH, CRAFT_DATA_DIR: data, NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      try {
        assert.equal(signal, null, stderr);
        assert.equal(code, 0, stderr);
        resolveResult(JSON.parse(stdout) as JsonObject);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ ...base, ...event }));
  });
  return { store, execute, async close() { store.close(); await rm(temporary, { recursive: true, force: true }); } };
}

for (const host of ["codex", "claude"] as const) {
  test(`${host} packaged Hook commands correlate separate processes and preserve concurrent verification signals`, async () => {
    const f = await replayFixture(host);
    try {
      await f.execute({ hook_event_name: "SessionStart" });
      await f.execute({ hook_event_name: "UserPromptSubmit", prompt: "Verify a fixture-only change without retaining this sentence" });
      await f.execute({ hook_event_name: "PostToolUse", tool_use_id: "edit", tool_name: "Edit" });
      await Promise.all(["npm test", "pytest"].map((command, index) => f.execute({ hook_event_name: "PostToolUse", tool_use_id: `verify-${index}`,
        tool_name: "Bash", tool_input: { command }, tool_response: { exit_code: 0 } })));
      const journal = f.store.list("codex_hook_turn", 10)[0]!;
      assert.equal((journal.signals as JsonObject[]).length, 3);
      assert.equal((journal.verification_receipts as JsonObject[]).length, 2);
      assert.equal(journal.verification_outcome, "passed");
      await f.execute({ hook_event_name: "Stop" });
      const closed = f.store.get("codex_hook_turn", String(journal.id));
      assert(closed.closed_at);
      assert.equal(f.store.list("workflow_evolution_observation", 10).length, 1);
      await f.execute({ hook_event_name: "Stop", turn_id: journal.turn_id });
      await f.execute({ hook_event_name: "PostToolUse", turn_id: journal.turn_id, tool_use_id: "late", tool_name: "Edit" });
      assert.deepEqual(f.store.get("codex_hook_turn", String(journal.id)), closed);
      assert.equal(f.store.list("workflow_evolution_observation", 10).length, 1);
      assert(!JSON.stringify(closed).includes("fixture-only change"));
      assert.deepEqual(f.store.list("context_hook_session", 10)[0]!.pending_turn_ids, []);
      assert(f.store.list("activation_proof_receipt", 100).some(proof => proof.host === host && proof.event === "Stop"
        && proof.component === "experience" && proof.observation_written === true));
      assert.equal(f.store.events("codex-hook").filter(event => event.event_type === "codex_hook.failed").length, 0);
    } finally { await f.close(); }
  });
}

test("concurrent packaged prompts reject ambiguous signals and session boundaries restore correlation", async () => {
  const f = await replayFixture("codex");
  try {
    await Promise.all(["one", "two"].map(prompt => f.execute({ hook_event_name: "UserPromptSubmit", prompt })));
    const session = f.store.list("context_hook_session", 10)[0]!;
    assert.equal((session.pending_turn_ids as string[]).length, 2);
    await f.execute({ hook_event_name: "PostToolUse", tool_name: "Edit" });
    await f.execute({ hook_event_name: "Stop" });
    assert.deepEqual(f.store.list("codex_hook_turn", 10), []);
    await f.execute({ hook_event_name: "SessionEnd" });
    assert.deepEqual(f.store.get("context_hook_session", String(session.id)).pending_turn_ids, []);
    await f.execute({ hook_event_name: "UserPromptSubmit", prompt: "fresh" });
    await f.execute({ hook_event_name: "PostToolUse", tool_name: "Edit" });
    assert.equal(f.store.list("codex_hook_turn", 10).length, 1);
  } finally { await f.close(); }
});
