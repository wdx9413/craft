import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CodexHookBridge } from "../core/codex-hook-bridge.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";

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
  const bridge = new CodexHookBridge(await CraftService.open(store));
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
  return { store, bridge, execute, repository, async close() { store.close(); await rm(temporary, { recursive: true, force: true }); } };
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
      const turn = f.store.list("context_hook_session", 10)[0]!;
      const journal = f.bridge.journal.find({ cwd: f.repository, session_id: `${host}-process`, turn_id: String(turn.last_turn_id) }, true)!;
      assert.equal((journal.signals as JsonObject[]).length, 3);
      assert.equal((journal.verification_receipts as JsonObject[]).length, 2,
        JSON.stringify((journal.signals as JsonObject[]).map(signal => ({ kind: signal.kind, outcome: signal.outcome, verifier: signal.verifier }))));
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
    const diagnostics = await readdir(join(f.store.paths.root, "trace", "hook-runtime", "v1"));
    const records = (await Promise.all(diagnostics.map(async name => (await readFile(join(f.store.paths.root, "trace", "hook-runtime", "v1", name), "utf8")))))
      .flatMap(content => content.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as JsonObject));
    const phases = new Map<string, string[]>();
    for (const record of records) phases.set(String(record.request_id), [...(phases.get(String(record.request_id)) ?? []), String(record.phase)]);
    assert.equal(phases.size, 2);
    assert([...phases.values()].every(value => value.length === 2 && value.includes("started") && value.includes("finished")));
    const session = f.store.list("context_hook_session", 10)[0]!;
    assert.equal((session.pending_turn_ids as string[]).length, 2);
    const ambiguousTurns = f.store.list("codex_hook_turn", 10);
    assert.equal(ambiguousTurns.length, 2);
    assert(ambiguousTurns.every(turn => typeof turn.context_receipt_id === "string" && (turn.signals as unknown[]).length === 0));
    const ambiguousIds = new Set(ambiguousTurns.map(turn => String(turn.id)));
    await f.execute({ hook_event_name: "PostToolUse", tool_name: "Edit" });
    await f.execute({ hook_event_name: "Stop" });
    const afterAmbiguousEvents = f.store.list("codex_hook_turn", 10);
    assert.deepEqual(afterAmbiguousEvents.map(turn => ({ id: turn.id, context_receipt_id: turn.context_receipt_id, signals: turn.signals })),
      ambiguousTurns.map(turn => ({ id: turn.id, context_receipt_id: turn.context_receipt_id, signals: turn.signals })));
    await f.execute({ hook_event_name: "SessionEnd" });
    assert.deepEqual(f.store.get("context_hook_session", String(session.id)).pending_turn_ids, []);
    await f.execute({ hook_event_name: "UserPromptSubmit", prompt: "fresh" });
    await f.execute({ hook_event_name: "PostToolUse", tool_name: "Edit" });
    const turns = f.store.list("codex_hook_turn", 10);
    assert.equal(turns.length, 3);
    const currentTurnId = String(f.store.list("context_hook_session", 10)[0]!.last_turn_id);
    const edited = f.bridge.journal.find({ cwd: f.repository, session_id: "codex-process", turn_id: currentTurnId }, true)!;
    assert.equal(edited.has_edit, true);
    assert(!ambiguousIds.has(String(edited.id)));
  } finally { await f.close(); }
});

test("packaged Hook returns promptly instead of waiting on the full SQLite lock timeout", async () => {
  const f = await replayFixture("codex");
  let locked = false;
  try {
    f.store.database.exec("BEGIN IMMEDIATE");
    locked = true;
    const started = performance.now();
    const child = spawnSync(process.execPath, [join(root, "plugins/craft-context/dist/plugin/craft-codex-hook.cjs"), "--member", "context"], {
      cwd: root, encoding: "utf8", timeout: 4_000,
      env: { PATH: process.env.PATH, CRAFT_DATA_DIR: f.store.paths.root, NODE_NO_WARNINGS: "1" },
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: f.store.paths.root, session_id: "busy-timeout", prompt: "verify the change" }),
    });
    const elapsed = performance.now() - started;
    f.store.database.exec("ROLLBACK");
    locked = false;
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert(elapsed < 1_000, `Hook exceeded its contention response budget: ${elapsed.toFixed(0)}ms`);
    const traces = f.store.list("trace_event", 1_000);
    assert(traces.some(event => event.operation_id === "handle.context.UserPromptSubmit" && event.error_class === "STORAGE_BUSY"));
  } finally {
    if (locked) f.store.database.exec("ROLLBACK");
    await f.close();
  }
});

test("packaged PostToolUse records an edit while the central database has a writer", async () => {
  const f = await replayFixture("codex");
  let locked = false;
  try {
    await f.execute({ hook_event_name: "UserPromptSubmit", prompt: "verify a fixture edit" });
    f.store.database.exec("BEGIN IMMEDIATE");
    locked = true;
    const started = performance.now();
    const child = spawnSync(process.execPath, [join(root, "plugins/craft-context/dist/plugin/craft-codex-hook.cjs"), "--member", "context"], {
      cwd: f.repository, encoding: "utf8", timeout: 4_000,
      env: { PATH: process.env.PATH, CRAFT_DATA_DIR: f.store.paths.root, NODE_NO_WARNINGS: "1" },
      input: JSON.stringify({ hook_event_name: "PostToolUse", cwd: f.repository, session_id: "codex-process", tool_use_id: "locked-edit",
        tool_name: "Edit", tool_input: { file_path: join(f.repository, "fixture.ts") } }),
    });
    const elapsed = performance.now() - started;
    f.store.database.exec("ROLLBACK");
    locked = false;
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert(elapsed < 3_000, `PostToolUse exceeded its Host-facing response budget: ${elapsed.toFixed(0)}ms`);
    assert(f.store.list("codex_hook_signal", 10).some(record => record.session_id === "codex-process"
      && (record.signal as JsonObject | undefined)?.kind === "edit"));
    const diagnostics = await readdir(join(f.store.paths.root, "trace", "hook-runtime", "v1"));
    const records = (await Promise.all(diagnostics.map(async name => (await readFile(join(f.store.paths.root, "trace", "hook-runtime", "v1", name), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as JsonObject)))).flat();
    assert(records.some(record => record.event === "PostToolUse" && record.outcome === "completed"));
  } finally {
    if (locked) f.store.database.exec("ROLLBACK");
    await f.close();
  }
});

test("packaged PostToolUse preserves same-turn signals under concurrent Hook processes", async t => {
  const f = await replayFixture("codex");
  const calls = 16;
  try {
    await f.execute({ hook_event_name: "UserPromptSubmit", turn_id: "stress-turn", prompt: "Run a concurrent Hook persistence regression." });
    await Promise.all(Array.from({ length: calls }, (_, index) => f.execute({ hook_event_name: "PostToolUse", turn_id: "stress-turn",
      tool_use_id: `stress-${index}`, tool_name: index % 2 ? "Edit" : "Bash",
      ...(index % 2 ? {} : { tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } }) })));
    const diagnosticFiles = await readdir(join(f.store.paths.root, "trace", "hook-runtime", "v1"));
    const diagnosticRecords = (await Promise.all(diagnosticFiles.map(async name =>
      (await readFile(join(f.store.paths.root, "trace", "hook-runtime", "v1", name), "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as JsonObject)))).flat();
    const runtimes = diagnosticRecords.filter(record => record.phase === "finished").map(record => Number(record.process_elapsed_ms)).sort((a, b) => a - b);
    const postToolRuntimes = diagnosticRecords.filter(record => record.phase === "finished" && record.event === "PostToolUse")
      .map(record => Number(record.process_elapsed_ms)).sort((a, b) => a - b);
    const percentile = (values: number[], q: number) => values[Math.ceil(values.length * q) - 1] ?? 0;
    const failures = diagnosticRecords.filter(record => record.event === "PostToolUse" && record.outcome === "failed");
    assert.equal(failures.length, 0, JSON.stringify({ failures: failures.map(record => record.error_code),
      p95_process_elapsed_ms: runtimes[Math.ceil(runtimes.length * 0.95) - 1], max_process_elapsed_ms: runtimes.at(-1) }));
    assert(runtimes.at(-1)! < 3_000, `Concurrent PostToolUse exceeded 3s: max ${runtimes.at(-1)}ms`);
    assert.equal(diagnosticRecords.filter(record => record.event === "PostToolUse" && record.outcome === "completed").length, calls);
    t.diagnostic(`16 concurrent PostToolUse process elapsed ms: p50=${percentile(postToolRuntimes, 0.5)} p95=${percentile(postToolRuntimes, 0.95)} max=${percentile(postToolRuntimes, 1)}`);
    const signals = f.store.list("codex_hook_signal", 100, item => item.session_id === "codex-process" && item.turn_id === "stress-turn");
    assert.equal(signals.length, calls);
    assert.equal(new Set(signals.map(item => (item.signal as JsonObject).id)).size, calls);
  } finally { await f.close(); }
});

test("packaged Hook skips SQLite for PostToolUse events that cannot produce a signal", async () => {
  const f = await replayFixture("codex");
  try {
    const result = await f.execute({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git status --short" }, tool_response: { exit_code: 0 } });
    assert.deepEqual(result, {});
    assert.equal(f.store.list("trace_event", 100).filter(event => event.operation_id === "handle.context.PostToolUse").length, 0);
    const diagnostics = await readdir(join(f.store.paths.root, "trace", "hook-runtime", "v1"));
    assert.equal(diagnostics.length, 1);
    const records = (await readFile(join(f.store.paths.root, "trace", "hook-runtime", "v1", diagnostics[0]!), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as JsonObject);
    assert.deepEqual(records.map(record => record.phase), ["started", "finished"]);
    assert.equal(records[1]!.store_open_ms, 0);
    assert.equal(records[1]!.handler_ms, 0);
  } finally { await f.close(); }
});

test("Context SessionStart records a runtime receipt without opening SQLite", async () => {
  const f = await replayFixture("codex");
  try {
    const now = new Date().toISOString();
    // A maintenance-only legacy row must not prevent a short-lived Hook from
    // recording its trace. Full CLI/MCP startup still validates it.
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("memory_ledger", "legacy-invalid", 1, "{", now, now);
    await f.execute({ hook_event_name: "SessionStart" });
    assert.equal(f.store.list("trace_event", 100).some(event => event.operation_id === "handle.context.SessionStart"), false);
    assert.equal(f.store.events("codex-hook").filter(event => event.event_type === "codex_hook.lifecycle").length, 0);
    const files = await readdir(join(f.store.paths.root, "trace", "hook-runtime", "v1"));
    assert.equal(files.length, 1);
    const records = (await readFile(join(f.store.paths.root, "trace", "hook-runtime", "v1", files[0]!), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as JsonObject);
    assert.deepEqual(records.map(record => record.phase), ["started", "finished"]);
    assert.equal(records[1]!.event, "SessionStart");
    assert.equal(records[1]!.outcome, "skipped");
    assert.equal(records[1]!.store_open_ms, 0);
    assert.equal(f.store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_ledger' AND id='legacy-invalid'")
      .get()?.payload_json, "{");
  } finally { await f.close(); }
});

test("packaged Hook records event and phase timings without logging prompt content", async () => {
  const f = await replayFixture("codex");
  try {
    await f.execute({ hook_event_name: "UserPromptSubmit", prompt: "sensitive prompt must not be logged" });
    const directory = join(f.store.paths.root, "trace", "hook-runtime", "v1");
    const names = await readdir(directory);
    assert.equal(names.length, 1);
    const records = (await readFile(join(directory, names[0]!), "utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as JsonObject);
    assert.deepEqual(records.map(record => record.phase), ["started", "finished"]);
    assert.equal(records[0]!.event, "UserPromptSubmit");
    assert.equal(records[0]!.member, "context");
    assert.equal(records[1]!.store_open_ms === undefined, false);
    assert.equal(records[1]!.handler_ms === undefined, false);
    assert.equal(records[1]!.process_elapsed_ms === undefined, false);
    assert.equal(records[1]!.input_read_ms === undefined, false);
    assert.equal(records[1]!.input_parse_ms === undefined, false);
    assert.equal(records[1]!.output_write_ms === undefined, false);
    assert.equal(records[1]!.store_close_ms === undefined, false);
    assert(!JSON.stringify(records).includes("sensitive prompt must not be logged"));
    assert(!JSON.stringify(records).includes("codex-process"));
  } finally { await f.close(); }
});
