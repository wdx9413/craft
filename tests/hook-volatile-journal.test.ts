import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths, sessionStorageScopeId } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { LocalSupervisor, SupervisorClient } from "../core/supervisor.ts";
import { HookTurnJournal } from "../core/codex-hook-bridge.ts";

test("concurrent Hook processes append to one volatile journal and SessionEnd removes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-volatile-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const code = `
      import { CraftStore } from ${JSON.stringify(`file://${resolve("core/infrastructure/store.ts")}`)};
      import { craftPaths } from ${JSON.stringify(`file://${resolve("core/infrastructure/paths.ts")}`)};
      import { CraftService } from ${JSON.stringify(`file://${resolve("core/service.ts")}`)};
      import { HookTurnJournal } from ${JSON.stringify(`file://${resolve("core/codex-hook-bridge.ts")}`)};
      const [root, id] = process.argv.slice(1);
      const store = await new CraftStore(craftPaths(root)).open();
      try { await new HookTurnJournal(new CraftService(store)).record({cwd: root, session_id:'concurrent', turn_id:'turn'}, {id, kind:'edit', digest:id}); }
      finally { store.close(); }
    `;
    const run = (id: string) => new Promise<void>((resolveChild, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, root, id], { env: process.env });
      let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.once("error", reject); child.once("exit", status => status === 0 ? resolveChild() : reject(new Error(stderr)));
    });
    await Promise.all(Array.from({ length: 8 }, (_, i) => run(`edit-${i}`)));
    const journal = new HookTurnJournal(service), input = { cwd: root, session_id: "concurrent", turn_id: "turn" };
    const read = await journal.find(input);
    assert.deepEqual((read?.signals as Array<{ id: string }>).map(signal => signal.id).sort(), Array.from({ length: 8 }, (_, i) => `edit-${i}`).sort());
    assert.equal(store.database.prepare("SELECT count(*) AS n FROM records WHERE kind IN ('codex_hook_turn','codex_hook_signal','context_hook_session')").get()?.n, 0);
    await Promise.all([journal.close(input), journal.record(input, { id: "racing", kind: "edit", digest: "racing" } as never)]);
    const closed = await journal.find(input);
    assert.ok(closed?.closed_at);
    const beforeLate = JSON.stringify(closed);
    await journal.record(input, { id: "after-close", kind: "edit", digest: "after-close" } as never);
    assert.equal(JSON.stringify(await journal.find(input)), beforeLate);
    await new SupervisorClient(paths).contextEnd({ session_key: sessionStorageScopeId("codex", "concurrent") });
    assert.equal(await journal.find(input), null);
    await assert.rejects(journal.record(input, { id: "late", kind: "edit", digest: "late" } as never), /SESSION_ARCHIVED/u);
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("deferred cleanup retries a temporarily unavailable same-owner Supervisor", async () => {
  const { readFile, rename } = await import("node:fs/promises");
  const { runContextCleanupWorker } = await import("../core/interfaces/context-cleanup-worker.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-cleanup-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths, { heartbeatMs: 60_000 });
  try {
    await supervisor.start();
    const statePath = join(paths.runtimeDir, "supervisor.json"), savedPath = `${statePath}.temporarily-unavailable`;
    const state = JSON.parse(await readFile(statePath, "utf8")) as { owner_id: string };
    const sessionKey = sessionStorageScopeId("codex", "deferred-cleanup"), client = new SupervisorClient(paths);
    await client.contextPut({ session_key: sessionKey, key: "hook:temporary", value: { active: true }, ttl_ms: 10_000 });
    await rename(statePath, savedPath);
    const pending = runContextCleanupWorker({ CRAFT_DATA_DIR: root, CRAFT_CLEANUP_SESSION_KEY: sessionKey, CRAFT_CLEANUP_OWNER_ID: state.owner_id }, { deadlineMs: 2000, retryMs: 20 });
    await new Promise(resolve => setTimeout(resolve, 50));
    await rename(savedPath, statePath);
    await pending;
    assert.equal((await client.contextGet({ session_key: sessionKey, key: "hook:temporary" })).status, "unavailable");
    await assert.rejects(client.contextPut({ session_key: sessionKey, key: "hook:temporary", value: {}, ttl_ms: 1000 }), /SESSION_ARCHIVED/u);
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy Hook records remain read-only and are hidden after session end", async () => {
  const { createHash } = await import("node:crypto");
  const { codexProjectScope } = await import("../core/codex-hook-bridge.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-legacy-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const scope = codexProjectScope(root)!, session_id = "legacy", turn = "turn";
    const id = `codex_hook_turn_${createHash("sha256").update(JSON.stringify({ scope, session_id, turn })).digest("hex").slice(-20)}`;
    const original = JSON.stringify({ scope, session_host: "codex", session_id, turn_id: turn, signals: [{ id: "old-edit", kind: "edit", digest: "old-edit" }], verification_outcome: null });
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("codex_hook_turn", id, 1, original, new Date().toISOString(), new Date().toISOString());
    const journal = new HookTurnJournal(service), input = { cwd: root, session_id, turn_id: turn };
    assert.equal((await journal.find(input))?.id, id);
    await journal.record(input, { id: "new-edit", kind: "edit", digest: "new-edit" } as never);
    assert.equal(((await journal.find(input))?.signals as unknown[]).length, 2);
    assert.equal(store.database.prepare("SELECT payload_json FROM records WHERE kind='codex_hook_turn' AND id=?").get(id)?.payload_json, original);
    await new SupervisorClient(paths).contextEnd({ session_key: sessionStorageScopeId("codex", session_id) });
    assert.equal(await journal.find(input), null);
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("cleanup refuses another Supervisor owner and missing identities", async () => {
  const { runContextCleanupWorker } = await import("../core/interfaces/context-cleanup-worker.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-cleanup-owner-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const sessionKey = sessionStorageScopeId("codex", "owner-change"), client = new SupervisorClient(paths);
    await client.contextPut({ session_key: sessionKey, key: "hook:test", value: { marker: true }, ttl_ms: 10000 });
    await runContextCleanupWorker({ CRAFT_DATA_DIR: root, CRAFT_CLEANUP_SESSION_KEY: sessionKey, CRAFT_CLEANUP_OWNER_ID: "different-owner" }, { deadlineMs: 100, retryMs: 10 });
    assert.equal((await client.contextGet({ session_key: sessionKey, key: "hook:test" })).status, "available");
    await assert.rejects(runContextCleanupWorker({}, { deadlineMs: 1 }), /identity is unavailable/u);
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("packaged Hook cleanup worker clears the original Supervisor", { skip: !process.env.CRAFT_TEST_PACKAGED_HOOK }, async () => {
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-package-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const state = JSON.parse(await readFile(join(paths.runtimeDir, "supervisor.json"), "utf8")) as { owner_id: string };
    const sessionKey = sessionStorageScopeId("codex", "packaged-worker"), client = new SupervisorClient(paths);
    await client.contextPut({ session_key: sessionKey, key: "hook:packaged", value: { marker: true }, ttl_ms: 10000 });
    const status = await new Promise<number>((resolveChild, reject) => {
      const child = spawn(process.execPath, [process.env.CRAFT_TEST_PACKAGED_HOOK!, "--context-cleanup-worker"], { env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_CLEANUP_SESSION_KEY: sessionKey, CRAFT_CLEANUP_OWNER_ID: state.owner_id }, stdio: "ignore" });
      child.once("error", reject); child.once("exit", code => resolveChild(code ?? -1));
    });
    assert.equal(status, 0);
    assert.equal((await client.contextGet({ session_key: sessionKey, key: "hook:packaged" })).status, "unavailable");
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("cleanup retry expires safely while the Supervisor remains unavailable", async () => {
  const { runContextCleanupWorker } = await import("../core/interfaces/context-cleanup-worker.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-cleanup-timeout-"));
  try {
    await runContextCleanupWorker({ CRAFT_DATA_DIR: root, CRAFT_CLEANUP_SESSION_KEY: sessionStorageScopeId("codex", "timeout"), CRAFT_CLEANUP_OWNER_ID: "owner" }, { deadlineMs: 15, retryMs: 3 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("detached cleanup survives its launcher and clears the session", { skip: !process.env.CRAFT_TEST_PACKAGED_HOOK }, async () => {
  const { readFile } = await import("node:fs/promises");
  const { launchContextCleanupWorker } = await import("../core/interfaces/context-cleanup-worker.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-detached-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const state = JSON.parse(await readFile(join(paths.runtimeDir, "supervisor.json"), "utf8")) as { owner_id: string };
    const sessionKey = sessionStorageScopeId("codex", "detached-worker"), client = new SupervisorClient(paths);
    await client.contextPut({ session_key: sessionKey, key: "hook:detached", value: { marker: true }, ttl_ms: 10000 });
    launchContextCleanupWorker(process.env.CRAFT_TEST_PACKAGED_HOOK!, root, sessionKey, state.owner_id);
    let status = "available";
    for (let i = 0; i < 100 && status === "available"; i++) {
      await new Promise(resolve => setTimeout(resolve, 30));
      status = String((await client.contextGet({ session_key: sessionKey, key: "hook:detached" })).status);
    }
    assert.equal(status, "unavailable");
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("journal stops after bounded CAS conflicts and does not rebind closed turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-cas-retry-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths), original = SupervisorClient.prototype.contextPut;
  try {
    await supervisor.start();
    const journal = new HookTurnJournal(service), input = { cwd: root, session_id: "cas", turn_id: "turn" };
    let attempts = 0;
    SupervisorClient.prototype.contextPut = async () => { attempts++; return { status: "changed" }; };
    await assert.rejects(journal.record(input, { id: "edit", kind: "edit", digest: "edit" } as never), /changed repeatedly/u);
    assert.equal(attempts, 32);
    SupervisorClient.prototype.contextPut = original;
    await journal.bindContextReceipt(input, { id: "first" });
    await journal.close(input);
    await journal.bindContextReceipt(input, { id: "second" });
    assert.equal((await journal.find(input))?.context_receipt_id, "first");
  } finally { SupervisorClient.prototype.contextPut = original; await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy per-signal shards are merged without a durable journal rewrite", async () => {
  const { codexProjectScope } = await import("../core/codex-hook-bridge.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-legacy-signals-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const scope = codexProjectScope(root)!, signal = { id: "old-signal", kind: "edit", digest: "edit" };
    store.create("codex_hook_signal", "old-signal", { scope, session_host: "codex", session_id: "old", turn_id: "turn", trace_id: "old-signal", signal, observed_at_ms: Date.now(), content_stored: false });
    const journal = new HookTurnJournal(service), value = await journal.find({ cwd: root, session_id: "old", turn_id: "turn" });
    assert.deepEqual(value?.signals, [signal]);
    assert.equal(store.database.prepare("SELECT count(*) n FROM records WHERE kind='codex_hook_turn'").get()?.n, 0);
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("direct finalization aligns an explicit scenario in the supplied snapshot", async () => {
  const { HookLearningCoordinator, codexProjectScope } = await import("../core/codex-hook-bridge.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-scenario-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  try {
    const scope = codexProjectScope(root)!;
    service.learningCycleFinalize = (() => ({ status: "observed", observation: null })) as typeof service.learningCycleFinalize;
    const journal: JsonObject = { id: "turn-id", turn_id: "turn", scope, context_receipt_id: "receipt", has_edit: true, verification_outcome: "failed", verification_receipts: [], signals: [
      { id: "edit", kind: "edit", digest: "edit" }, { id: "verify", kind: "verification", outcome: "failed", verifier: "test" },
    ] };
    const result = new HookLearningCoordinator(service).finalize({ turn_id: "turn", scenario_key: "coding.example" }, scope, null, journal);
    assert.equal(result?.status, "observed");
    assert.equal(journal.scenario_key, "coding.example");
    assert.equal(((journal.signals as JsonObject[])[1] as { scenario_key?: string }).scenario_key, "coding.example");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("publishing a replacement snapshot reclaims only its previous generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-snapshot-replace-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const client = new SupervisorClient(paths), session_key = sessionStorageScopeId("codex", "snapshot"), prefix = `learning-index:${"a".repeat(24)}:`;
    const old = "a".repeat(36), next = "b".repeat(36), key = `${prefix}manifest`;
    for (const generation of [old, next]) {
      await client.contextPut({ session_key, key: `${prefix}${generation}:0`, value: { data: generation }, ttl_ms: 10000 });
      const { createHash } = await import("node:crypto");
      const digest = `sha256:${createHash("sha256").update(JSON.stringify(generation)).digest("hex")}`;
      await client.contextSnapshotPublish({ session_key, key, value: { generation, count: 1, digest }, ttl_ms: 10000 });
    }
    assert.equal((await client.contextGet({ session_key, key: `${prefix}${old}:0` })).status, "unavailable");
    assert.equal((await client.contextGet({ session_key, key: `${prefix}${next}:0` })).status, "available");
    assert.equal((await client.contextSnapshotGet({ session_key, key })).encoded, next);
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Stop preserves a verified journal when goal lookup fails", async () => {
  const { CodexHookBridge, codexProjectScope } = await import("../core/codex-hook-bridge.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-goal-outage-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = await CraftService.open(store);
  const scope = codexProjectScope(root)!;
  service.scopeAliasBind({ scope_kind: "project", scope_id: scope.id, alias_kind: "path", alias: root });
  const supervisor = new LocalSupervisor(service, paths), get = SupervisorClient.prototype.contextGet;
  try {
    await supervisor.start();
    const bridge = new CodexHookBridge(service), input = { cwd: root, session_id: "goal-outage", turn_id: "turn" };
    await bridge.handle("context", { ...input, hook_event_name: "UserPromptSubmit", prompt: "make a verified change" });
    await bridge.handle("context", { ...input, hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("context", { ...input, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    SupervisorClient.prototype.contextGet = async function(args) {
      if (String(args.key).startsWith("goal:")) throw new Error("temporary failure");
      return get.call(this, args);
    };
    const result = await bridge.handle("context", { ...input, hook_event_name: "Stop" });
    assert.match(String(result.systemMessage), /尚未完成.*重试/u);
    assert.equal((await bridge.journal.find(input))?.verification_outcome, "passed");
  } finally { SupervisorClient.prototype.contextGet = get; await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("SessionEnd schedules cleanup against the lock owner if the endpoint is unavailable", async () => {
  const { rename } = await import("node:fs/promises");
  const { CodexHookBridge, codexProjectScope } = await import("../core/codex-hook-bridge.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-end-outage-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = await CraftService.open(store);
  const scope = codexProjectScope(root)!;
  service.scopeAliasBind({ scope_kind: "project", scope_id: scope.id, alias_kind: "path", alias: root });
  const supervisor = new LocalSupervisor(service, paths, { heartbeatMs: 60_000 }), end = SupervisorClient.prototype.contextEnd;
  const statePath = join(paths.runtimeDir, "supervisor.json"), moved = `${statePath}.unavailable`;
  try {
    await supervisor.start();
    await rename(statePath, moved);
    SupervisorClient.prototype.contextEnd = async () => { throw new Error("temporary outage"); };
    const calls: string[][] = [];
    const bridge = new CodexHookBridge(service, undefined, false, (session, owner) => { calls.push([session, owner]); });
    const result = await bridge.handle("context", { cwd: root, session_id: "outage", hook_event_name: "SessionEnd" });
    assert.match(String(result.systemMessage), /不可用/u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], sessionStorageScopeId("codex", "outage"));
  } finally {
    SupervisorClient.prototype.contextEnd = end;
    await rename(moved, statePath).catch(() => {});
    await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});

test("cleanup stops after an in-flight request exceeds its deadline", async () => {
  const { runContextCleanupWorker } = await import("../core/interfaces/context-cleanup-worker.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-cleanup-deadline-")), end = SupervisorClient.prototype.contextEnd;
  try {
    SupervisorClient.prototype.contextEnd = async () => { await new Promise(resolve => setTimeout(resolve, 25)); throw new Error("timeout"); };
    await runContextCleanupWorker({ CRAFT_DATA_DIR: root, CRAFT_CLEANUP_SESSION_KEY: sessionStorageScopeId("codex", "deadline"), CRAFT_CLEANUP_OWNER_ID: "owner" }, { deadlineMs: 10 });
  } finally { SupervisorClient.prototype.contextEnd = end; await rm(root, { recursive: true, force: true }); }
});

test("snapshot publication verifies content, pins chunk lifetime and rejects mutation", async () => {
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "craft-snapshot-integrity-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const client = new SupervisorClient(paths), session_key = sessionStorageScopeId("codex", "integrity"), prefix = `learning-index:${"e".repeat(24)}:`, generation = "f".repeat(36);
    const key = `${prefix}manifest`, chunk = `${prefix}${generation}:0`, value = "verified snapshot";
    await client.contextPut({ session_key, key: chunk, value: { data: value }, ttl_ms: 100 });
    await assert.rejects(client.contextSnapshotPublish({ session_key, key, value: { generation, count: 1, digest: "bad" }, ttl_ms: 1000 }), /digest mismatch/u);
    const digest = `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
    await client.contextSnapshotPublish({ session_key, key, value: { generation, count: 1, digest }, ttl_ms: 1000 });
    await assert.rejects(client.contextPut({ session_key, key: chunk, value: { data: "changed" }, ttl_ms: 1000 }), /immutable/u);
    assert.equal((await client.contextPut({ session_key, key: chunk, value: { data: value }, ttl_ms: 1 })).status, "stored");
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal((await client.contextSnapshotGet({ session_key, key })).encoded, value);
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("SessionEnd fences new finalizations while an acquired Stop completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-finalization-fence-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const client = new SupervisorClient(paths), session_key = sessionStorageScopeId("codex", "finalization"), key = "hook:state";
    await client.contextPut({ session_key, key, value: { ready: true }, ttl_ms: 10000 });
    const claim = await client.contextClaim({ session_key });
    assert.equal(typeof claim.token, "string");
    await assert.rejects(client.contextEnd({ session_key }), /SESSION_BUSY/u);
    await assert.rejects(client.contextClaim({ session_key }), /SESSION_ARCHIVED/u);
    await assert.rejects(client.contextStart({ session_key }), /SESSION_BUSY/u);
    assert.equal((await client.contextGet({ session_key, key })).status, "available");
    assert.equal((await client.contextRelease({ session_key, token: claim.token })).released, true);
    assert.equal((await client.contextEnd({ session_key })).status, "ended");
    assert.equal((await client.contextGet({ session_key, key })).status, "unavailable");
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("real Stop finalization holds the SessionEnd fence across processes", async () => {
  const { codexProjectScope } = await import("../core/codex-hook-bridge.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-stop-fence-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = await CraftService.open(store);
  const scope = codexProjectScope(root)!;
  service.scopeAliasBind({ scope_kind: "project", scope_id: scope.id, alias_kind: "path", alias: root });
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const journal = new HookTurnJournal(service), input = { cwd: root, session_id: "stop-race", turn_id: "turn" };
    await journal.bindContextReceipt(input, { id: "receipt" });
    await journal.record(input, { id: "verify", kind: "verification", verifier: "test", outcome: "failed" } as never);
    const code = `
      import { CraftStore } from ${JSON.stringify(`file://${resolve("core/infrastructure/store.ts")}`)};
      import { craftPaths } from ${JSON.stringify(`file://${resolve("core/infrastructure/paths.ts")}`)};
      import { CraftService } from ${JSON.stringify(`file://${resolve("core/service.ts")}`)};
      import { CodexHookBridge } from ${JSON.stringify(`file://${resolve("core/codex-hook-bridge.ts")}`)};
      const root = process.argv[1], store = await new CraftStore(craftPaths(root)).open(), service = await CraftService.open(store);
      service.learningCycleFinalize = () => { process.send('claimed'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); return {status:'observed',observation:null}; };
      await new CodexHookBridge(service).handle('context',{cwd:root,session_id:'stop-race',turn_id:'turn',hook_event_name:'Stop'});
      store.close();
    `;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, root], { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
    const done = new Promise<number>((resolveChild, reject) => { child.once("error", reject); child.once("exit", code => resolveChild(code ?? -1)); });
    await new Promise<void>((resolveChild, reject) => { child.once("message", () => resolveChild()); child.once("error", reject); child.once("exit", () => reject(new Error(`child exited before claim: ${stderr}`))); });
    const client = new SupervisorClient(paths), session_key = sessionStorageScopeId("codex", "stop-race");
    await assert.rejects(client.contextEnd({ session_key }), /SESSION_BUSY/u);
    assert.equal(await done, 0, stderr);
    assert.equal((await client.contextEnd({ session_key })).status, "ended");
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("SessionStart atomically resets only its own pending-turn correlation", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-start-reset-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const client = new SupervisorClient(paths), session_key = sessionStorageScopeId("codex", "start"), other = sessionStorageScopeId("codex", "other");
    for (const owner of [session_key, other]) await client.contextPut({ session_key: owner, key: "hook:session:project", value: { pending_turn_ids: ["turn"] }, ttl_ms: 10000 });
    await client.contextPut({ session_key, key: "hook:turn:keep", value: { id: "turn" }, ttl_ms: 10000 });
    await client.contextStart({ session_key });
    assert.equal((await client.contextGet({ session_key, key: "hook:session:project" })).status, "unavailable");
    assert.equal((await client.contextGet({ session_key: other, key: "hook:session:project" })).status, "available");
    assert.equal((await client.contextGet({ session_key, key: "hook:turn:keep" })).status, "available");
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("an acquired Stop can finish when SessionEnd arrives before journal close", async () => {
  const { CodexHookBridge, codexProjectScope } = await import("../core/codex-hook-bridge.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-stop-claim-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = await CraftService.open(store);
  const scope = codexProjectScope(root)!;
  service.scopeAliasBind({ scope_kind: "project", scope_id: scope.id, alias_kind: "path", alias: root });
  const supervisor = new LocalSupervisor(service, paths), original = SupervisorClient.prototype.contextClaim;
  try {
    await supervisor.start();
    const bridge = new CodexHookBridge(service), input = { cwd: root, session_id: "claim-race", turn_id: "turn" };
    await bridge.handle("context", { ...input, hook_event_name: "UserPromptSubmit", prompt: "verify this project" });
    await bridge.handle("context", { ...input, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    SupervisorClient.prototype.contextClaim = async function(args) {
      const claim = await original.call(this, args);
      await assert.rejects(this.contextEnd({ session_key: args.session_key }), /SESSION_BUSY/u);
      return claim;
    };
    const result = await bridge.handle("context", { ...input, hook_event_name: "Stop" });
    assert.match(String(result.systemMessage), /craft_experience_runbook_capture/u);
    assert.equal(store.list("workflow_evolution_observation", 10).length, 1);
    assert.equal((await new SupervisorClient(paths).contextEnd({ session_key: sessionStorageScopeId("codex", "claim-race") })).status, "ended");
  } finally { SupervisorClient.prototype.contextClaim = original; await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("claim capacity, expiry and ended purge are bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-claim-bounds-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths), now = Date.now;
  try {
    await supervisor.start();
    const client = new SupervisorClient(paths), session_key = sessionStorageScopeId("codex", "bounds");
    const claims: string[] = [];
    for (let i = 0; i < 100; i++) claims.push(String((await client.contextClaim({ session_key })).token));
    await assert.rejects(client.contextClaim({ session_key }), /capacity exceeded/u);
    await assert.rejects(client.contextRelease({ session_key }), /token is invalid/u);
    assert.equal((await client.contextRelease({ session_key, token: "missing" })).released, false);
    await assert.rejects(client.contextEnd({ session_key }), /SESSION_BUSY/u);
    await assert.rejects(client.contextPurge({ session_key, all: true }), /SESSION_ARCHIVED/u);
    await assert.rejects(client.contextPurge({ session_key, key: "goal:missing" }), /SESSION_ARCHIVED/u);
    assert.equal((await client.contextGet({ session_key, key: "goal:missing" })).ended, true);
    Date.now = () => now() + 86_400_001;
    assert.equal((await client.contextRelease({ session_key, token: claims[0] })).released, false);
    assert.equal((await client.contextEnd({ session_key })).status, "ended");
  } finally { Date.now = now; await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Stop fails closed for malformed claims and unknown goal status", async () => {
  const { CodexHookBridge, codexProjectScope } = await import("../core/codex-hook-bridge.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-hook-bad-supervisor-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = await CraftService.open(store);
  const scope = codexProjectScope(root)!;
  service.scopeAliasBind({ scope_kind: "project", scope_id: scope.id, alias_kind: "path", alias: root });
  const supervisor = new LocalSupervisor(service, paths), claim = SupervisorClient.prototype.contextClaim, get = SupervisorClient.prototype.contextGet;
  try {
    await supervisor.start();
    const bridge = new CodexHookBridge(service), input = { cwd: root, session_id: "unknown-response", turn_id: "turn" };
    await bridge.handle("context", { ...input, hook_event_name: "UserPromptSubmit", prompt: "verify this" });
    SupervisorClient.prototype.contextClaim = async () => ({});
    assert.match(String((await bridge.handle("context", { ...input, hook_event_name: "Stop" })).systemMessage), /尚未完成/u);
    SupervisorClient.prototype.contextClaim = claim;
    SupervisorClient.prototype.contextGet = async function(args) {
      return String(args.key).startsWith("goal:") ? { status: "unknown" } : get.call(this, args);
    };
    assert.match(String((await bridge.handle("context", { ...input, hook_event_name: "Stop" })).systemMessage), /尚未完成.*重试/u);
    assert.equal(store.list("workflow_evolution_observation", 10).length, 0);
  } finally { SupervisorClient.prototype.contextClaim = claim; SupervisorClient.prototype.contextGet = get; await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("volatile purge and index ownership validate scoped inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-purge-guards-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = new CraftService(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const client = new SupervisorClient(paths), session_key = sessionStorageScopeId("codex", "purge"), other = sessionStorageScopeId("codex", "other");
    await client.contextPut({ session_key, key: "index:shared", value: { session_id: "purge", session_host: "codex", source: "one", identity_digest: "current" }, ttl_ms: 10000, claim_token: "unknown" });
    await assert.rejects(client.contextPut({ session_key: other, key: "index:shared", value: {}, ttl_ms: 10000 }), /scope mismatch/u);
    assert.deepEqual(await client.contextPurge({ session_key, key: "index:shared", expected_identity_digest: "old" }), { removed: 0, changed: true });
    await assert.rejects(client.contextPurge({ session_key, prefix: 2 }), /prefix is invalid/u);
    await assert.rejects(client.contextPurge({ session_key, prefix: "x".repeat(257) }), /prefix is invalid/u);
    await client.contextPut({ session_key: other, key: "hook:other", value: {}, ttl_ms: 10000 });
    assert.equal((await client.contextPurge({ session_key, prefix: "not-matching" })).removed, 0);
    assert.equal((await client.contextPurge({ session_key, prefix: "index:" })).removed, 1);
    assert.equal((await client.contextGet({ session_key: other, key: "hook:other" })).status, "available");
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("cleanup retries with the default interval", async () => {
  const { runContextCleanupWorker } = await import("../core/interfaces/context-cleanup-worker.ts");
  const root = await mkdtemp(join(tmpdir(), "craft-cleanup-default-")), end = SupervisorClient.prototype.contextEnd;
  let attempts = 0;
  try {
    SupervisorClient.prototype.contextEnd = async () => { if (++attempts === 1) throw new Error("temporary"); return { status: "ended" }; };
    await runContextCleanupWorker({ CRAFT_DATA_DIR: root, CRAFT_CLEANUP_SESSION_KEY: sessionStorageScopeId("codex", "default"), CRAFT_CLEANUP_OWNER_ID: "owner" }, { deadlineMs: 2000 });
    assert.equal(attempts, 2);
  } finally { SupervisorClient.prototype.contextEnd = end; await rm(root, { recursive: true, force: true }); }
});

test("source Hook entry opens the bridge for a project prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-source-entry-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open(), service = await CraftService.open(store);
  const supervisor = new LocalSupervisor(service, paths);
  try {
    await supervisor.start();
    const child = spawn(process.execPath, ["--experimental-strip-types", resolve("bin/craft-codex-hook.ts"), "--member", "context"], { cwd: root,
      env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_CONTINUOUS_LEARNING: "0" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: root, session_id: "source-entry", turn_id: "turn", prompt: "check the project" }));
    const status = await new Promise<number>((resolveChild, reject) => { child.once("error", reject); child.once("exit", code => resolveChild(code ?? -1)); });
    assert.equal(status, 0, stderr);
    assert.equal(typeof JSON.parse(stdout.trim()), "object");
  } finally { await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
