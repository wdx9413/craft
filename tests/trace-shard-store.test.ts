import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { TraceKernel } from "../core/trace-kernel.ts";
import { migrateTraceStorage } from "../scripts/trace-storage-migration.ts";
import { TraceShardStore, type TraceRecordRow } from "../common/craft-common-store-local/src/trace-shards.ts";

test("new Trace writes stay outside the central database and remain readable after reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-shards-"));
  const paths = craftPaths(root);
  let store = await new CraftStore(paths).open();
  try {
    const trace = new TraceKernel(store);
    trace.start({ trace_id: "trace-shard-a", task_id: "task-a" });
    trace.append({ trace_id: "trace-shard-a", event_kind: "task.started", summary: "started" });
    trace.finalize({ trace_id: "trace-shard-a", status: "completed", summary: "done" });
    assert.equal(store.database.prepare("SELECT count(*) n FROM records WHERE kind IN ('trace','trace_event')").get()?.n, 0);
    assert.equal((trace.get({ trace_id: "trace-shard-a" }).events as unknown[]).length, 2);
    store.close();
    store = await new CraftStore(paths).open();
    assert.equal((new TraceKernel(store).get({ trace_id: "trace-shard-a" }).trace as { status: string }).status, "completed");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex Hook turn journals share Trace shard writes without entering Trace retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-turn-shards-"));
  const paths = craftPaths(root);
  let store = await new CraftStore(paths).open();
  try {
    const turn = store.create("codex_hook_turn", "hook-turn-shard-a", {
      trace_id: "hook-turn-shard-a", session_id: "session-a", turn_id: "turn-a", signals: [], content_stored: false,
    });
    assert.equal(store.database.prepare("SELECT count(*) n FROM records WHERE kind='codex_hook_turn'").get()?.n, 0);
    assert.equal(store.find("codex_hook_turn", String(turn.id))?.turn_id, "turn-a");
    assert.equal(store.count("codex_hook_turn"), 1);
    store.save("codex_hook_turn", String(turn.id), { ...turn, trace_id: String(turn.trace_id), signals: [{ kind: "edit" }] });
    assert.equal((store.list("codex_hook_turn", 10)[0]!.signals as unknown[]).length, 1);
    assert.throws(() => store.createBatch([{ kind: "codex_hook_turn", id: "invalid-hook-turn", payload: { signals: [] } }]), /one Trace/u);
    assert.deepEqual(store.createBatch([
      { kind: "codex_hook_turn", id: "batch-hook-turn", payload: { trace_id: "batch-hook-trace", session_id: "session-batch", signals: [] } },
      { kind: "trace_event", id: "batch-hook-event", payload: { trace_id: "batch-hook-trace", event_kind: "hook.test" } },
    ]).map(item => item.version), [1, 1]);
    assert.deepEqual(store.saveBatch([
      { kind: "codex_hook_turn", id: "batch-hook-turn", payload: { trace_id: "batch-hook-trace", session_id: "session-batch", signals: [{ kind: "edit" }] } },
      { kind: "trace_event", id: "batch-hook-event", payload: { trace_id: "batch-hook-trace", event_kind: "hook.updated" } },
    ]).map(item => item.version), [2, 2]);
    store.close();
    store = await new CraftStore(paths).open();
    assert.equal(store.get("codex_hook_turn", String(turn.id)).turn_id, "turn-a");
    assert.equal((store.get("codex_hook_turn", "batch-hook-turn").signals as unknown[]).length, 1);
    assert.equal(store.listTraceRetentionCandidates("9999-01-01T00:00:00.000Z", 10).length, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Hook signal turn lookup uses scoped indexed rows across shards and orders only the requested turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-signal-lookup-"));
  const shards = new TraceShardStore(root);
  try {
    assert.deepEqual(shards.hookSignalsForTurn("project", "p1", "s1", "t1", 100), []);
    for (let index = 0; index < 40; index++) {
      const id = `hook-signal-${index}`;
      const sameTurn = index % 2 === 0;
      const observed = 40 - index;
      shards.create("codex_hook_signal", id, { trace_id: id, scope: { kind: "project", id: "p1" },
        session_id: sameTurn ? "s1" : "s2", turn_id: sameTurn ? "t1" : "t2", observed_at_ms: observed,
        signal: { id, kind: "edit" }, content_stored: false });
    }
    const rows = shards.hookSignalsForTurn("project", "p1", "s1", "t1", 100);
    assert.equal(rows.length, 20);
    assert(rows.every(row => row.session_id === "s1" && row.turn_id === "t1"));
    assert.deepEqual(rows.map(row => row.observed_at_ms), [...rows.map(row => row.observed_at_ms)].sort((a, b) => Number(a) - Number(b)));
    shards.create("codex_hook_signal", "hook-signal-no-time", { trace_id: "hook-signal-no-time", scope: { kind: "project", id: "p1" },
      session_id: "s1", turn_id: "t1", signal: { id: "hook-signal-no-time", kind: "edit" }, content_stored: false });
    assert.equal(shards.hookSignalsForTurn("project", "p1", "s1", "t1", 100).at(-1)?.id, "hook-signal-no-time");
    for (const id of ["hook-signal-tie-b", "hook-signal-tie-a"]) shards.create("codex_hook_signal", id, {
      trace_id: id, scope: { kind: "project", id: "p1" }, session_id: "s1", turn_id: "t1", observed_at_ms: 50,
      signal: { id, kind: "edit" }, content_stored: false,
    });
    const tied = shards.hookSignalsForTurn("project", "p1", "s1", "t1", 100).filter(row => row.observed_at_ms === 50);
    assert.deepEqual(tied.map(row => row.id), ["hook-signal-tie-a", "hook-signal-tie-b"]);
    assert.deepEqual(shards.hookSignalsForTurn("project", "p2", "s1", "t1", 100), []);
    assert.equal(shards.hookSignalsForTurn("project", "p1", "s1", "t1", 3).length, 3);
    assert.deepEqual(shards.hookSignalsForTurn("project", "p1", "s1", "t1", 0), []);
    const legacyRoot = await mkdtemp(join(tmpdir(), "craft-hook-signal-legacy-shard-"));
    const legacyDirectory = join(legacyRoot, "trace", "v1");
    await mkdir(legacyDirectory, { recursive: true });
    const legacyDb = new DatabaseSync(join(legacyDirectory, "00.db"));
    legacyDb.exec("CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id,version))");
    legacyDb.close();
    const legacyShards = new TraceShardStore(legacyRoot);
    assert.deepEqual(legacyShards.hookSignalsForTurn("project", "p1", "s1", "t1", 10), []);
    legacyShards.close();
    await rm(legacyRoot, { recursive: true, force: true });
  } finally { shards.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy central Traces keep their existing write path", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-legacy-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("trace", "legacy-trace", 1, JSON.stringify({ status: "completed", next_sequence: 0, event_count: 0, started_at: "2020-01-01T00:00:00.000Z" }), now, now);
    const event = store.create("trace_event", "legacy-event", { trace_id: "legacy-trace", sequence: 1 });
    assert.equal(event.version, 1);
    assert.equal(store.find("trace_event", "legacy-event")?.trace_id, "legacy-trace");
    assert.equal(store.database.prepare("SELECT count(*) n FROM records WHERE kind='trace_event'").get()?.n, 1);
    assert.equal(store.listTraceChildren("trace_event", "legacy-trace").length, 1);
    assert.equal(store.listTraceRetentionCandidates("9999-01-01T00:00:00.000Z", 10).some(row => row.id === "legacy-trace"), true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy Trace rows override a duplicate shard projection and retention sorts missing event times", async t => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-legacy-precedence-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("trace", "duplicate-trace", { status: "completed", last_event_at: "2020-01-01T00:00:00.000Z" });
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("trace", "duplicate-trace", 1, JSON.stringify({ status: "failed", last_event_at: "2020-01-01T00:00:00.000Z" }), now, now);
    assert.equal(store.list("trace", 10).find(row => row.id === "duplicate-trace")?.status, "failed");
    store.create("trace", "retention-with-event-time", { status: "completed", last_event_at: "2021-01-01T00:00:00.000Z" });
    store.create("trace", "retention-without-event-time", { status: "completed", started_at: "2020-01-01T00:00:00.000Z" });
    assert.equal(store.listTraceRetentionCandidates("9999-01-01T00:00:00.000Z", 10)
      .some(row => row.id === "retention-without-event-time"), true);
    const retentionRows = [
      { id: "event-first", last_event_at: "2020-01-01T00:00:00.000Z", updated_at: "2020-01-01T00:00:00.000Z" },
      { id: "missing-event-middle", updated_at: "2021-01-01T00:00:00.000Z" },
      { id: "event-last", last_event_at: "2022-01-01T00:00:00.000Z", updated_at: "2022-01-01T00:00:00.000Z" },
    ];
    const retention = t.mock.method(store.traceShards, "retentionCandidates", () => retentionRows);
    assert.equal(store.listTraceRetentionCandidates("9999-01-01T00:00:00.000Z", 10).length, 4);
    retention.mock.restore();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Trace optimistic updates and legacy removal stay scoped to one trace", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-update-remove-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open();
  try {
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("trace", "legacy-remove", 1, JSON.stringify({ status: "completed" }), now, now);
    store.create("trace_event", "legacy-event-remove", { trace_id: "legacy-remove" });
    store.save("trace_event", "legacy-event-remove", { trace_id: "legacy-remove", summary: "updated" });
    store.create("trace_feedback", "legacy-feedback-remove", { trace_id: "legacy-remove" });
    store.create("telemetry_event", "legacy-telemetry-remove", { trace_id: "legacy-remove" });
    store.appendEvent("trace:legacy-remove", "completed", { ok: true });
    store.traceTransaction("legacy-remove", () => store.appendEvent("trace:legacy-remove", "nested", { ok: true }));
    assert.equal(store.removeTraceRecords("legacy-remove", ["legacy-event-remove"], ["legacy-feedback-remove"], ["legacy-telemetry-remove"]), 7);
    assert.equal(store.find("trace", "legacy-remove"), null);
    const trace = store.create("trace", "optimistic-trace", { status: "running" });
    assert.equal(store.updateIfVersion("trace", "optimistic-trace", 1, { status: "completed" }).version, 2);
    assert.throws(() => store.updateIfVersion("trace", "optimistic-trace", Number(trace.version), { status: "failed" }), /Concurrent update/u);
    store.create("trace_event", "optimistic-event", { trace_id: "optimistic-trace", sequence: 1 });
    assert.equal(store.updateIfVersion("trace_event", "optimistic-event", 1, { trace_id: "optimistic-trace", sequence: 1 }).version, 2);
    assert.throws(() => store.updateIfVersion("trace_event", "optimistic-event", 1, { trace_id: "optimistic-trace" }), /Concurrent update/u);
    assert.equal(store.updateIfVersion("trace_event", "orphan-event", 0, { trace_id: "optimistic-trace", sequence: 0 }).version, 1);
    assert.throws(() => store.updateIfVersion("trace_event", "orphan-invalid", 0, {}), /must not be empty/u);
    const saved = store.saveBatch([
      { kind: "trace", id: "batch-save", payload: { status: "running" } },
      { kind: "trace_event", id: "batch-save-event", payload: { trace_id: "batch-save", sequence: 1 } },
    ]);
    assert.deepEqual(saved.map(row => row.id), ["batch-save", "batch-save-event"]);
    assert.throws(() => store.createBatch([
      { kind: "trace", id: "mixed-batch", payload: {} },
      { kind: "task", id: "unrelated", payload: {} },
    ]), /one Trace/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a writer lock on one Trace shard does not block another shard", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-concurrent-"));
  const store = await new CraftStore(craftPaths(root)).open();
  let locked: DatabaseSync | undefined;
  try {
    const trace = new TraceKernel(store);
    trace.start({ trace_id: "trace-shard-a", task_id: "task-a" });
    locked = new DatabaseSync(join(root, "trace", "v1", "0b.db"));
    locked.exec("BEGIN IMMEDIATE");
    trace.start({ trace_id: "trace-shard-b", task_id: "task-b" });
    assert.equal((trace.get({ trace_id: "trace-shard-b" }).trace as { status: string }).status, "running");
  } finally {
    locked?.exec("ROLLBACK");
    locked?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a central writer lock does not block a new Trace write", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-central-lock-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open();
  const locked = new DatabaseSync(paths.databaseFile);
  try {
    locked.exec("BEGIN IMMEDIATE");
    const trace = new TraceKernel(store);
    trace.start({ trace_id: "independent-trace", task_id: "task" });
    trace.append({ trace_id: "independent-trace", event_kind: "task.started", summary: "started" });
    assert.equal((trace.get({ trace_id: "independent-trace" }).events as unknown[]).length, 1);
  } finally { locked.exec("ROLLBACK"); locked.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Trace batches commit one Trace atomically and reject cross-shard writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-batch-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    assert.throws(() => store.createBatch([
      { kind: "trace", id: "batch-trace", payload: { status: "running" } },
      { kind: "trace_event", id: "batch-event", payload: { trace_id: "batch-trace" } },
      { kind: "trace_event", id: "batch-event", payload: { trace_id: "batch-trace" } },
    ]), /already exists/u);
    assert.equal(store.find("trace", "batch-trace"), null);
    assert.equal(store.find("trace_event", "batch-event"), null);
    assert.throws(() => store.createBatch([
      { kind: "trace", id: "batch-trace", payload: {} },
      { kind: "trace_event", id: "foreign-event", payload: { trace_id: "other-trace" } },
    ]), /one Trace/u);
    assert.deepEqual(store.createBatch([
      { kind: "trace", id: "batch-trace", payload: { status: "running" } },
      { kind: "trace_event", id: "batch-event", payload: { trace_id: "batch-trace" } },
    ]).map(item => item.id), ["batch-trace", "batch-event"]);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("offline migration preserves historical versions and events, then is repeatable", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-migrate-"));
  const paths = craftPaths(root);
  const store = await new CraftStore(paths).open();
  try {
    const now = new Date().toISOString();
    const insert = store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)");
    insert.run("trace", "old-trace", 1, JSON.stringify({ status: "running", event_count: 0 }), now, now);
    insert.run("trace", "old-trace", 2, JSON.stringify({ status: "completed", event_count: 1 }), now, now);
    insert.run("trace_event", "old-event", 1, JSON.stringify({ trace_id: "old-trace", sequence: 1 }), now, now);
    store.database.prepare("INSERT INTO events(stream,sequence,event_type,payload_json,created_at) VALUES(?,?,?,?,?)")
      .run("trace:old-trace", 1, "task.done", JSON.stringify({ trace_id: "old-trace" }), now);
  } finally { store.close(); }
  try {
    const dry = await migrateTraceStorage(root);
    assert.deepEqual({ traces: dry.trace_count, versions: dry.record_versions, events: dry.event_count, backup: dry.backup },
      { traces: 1, versions: 3, events: 1, backup: null });
    const cli = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/trace-storage-migration.ts", `--data-root=${root}`],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).record_versions, 3);
    const invalidCli = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/trace-storage-migration.ts"],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(invalidCli.status, 0);
    assert.match(invalidCli.stderr, /Usage: trace-storage-migration/u);
    const source = new DatabaseSync(paths.databaseFile, { readOnly: true });
    const partial = new TraceShardStore(root);
    try {
      const first = source.prepare("SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind='trace' AND version=1")
        .get() as TraceRecordRow;
      partial.importLegacy("old-trace", [first], []);
    } finally { partial.close(); source.close(); }
    const applied = await migrateTraceStorage(root, true);
    assert.equal(applied.migrated, 1);
    assert.ok(applied.backup);
    const backup = new DatabaseSync(applied.backup!, { readOnly: true });
    try { assert.equal(backup.prepare("SELECT COUNT(*) n FROM records WHERE kind='trace'").get()?.n, 2); }
    finally { backup.close(); }
    const reopened = await new CraftStore(paths).open();
    try {
      assert.equal(reopened.find("trace", "old-trace")?.version, 2);
      assert.equal(reopened.find("trace", "old-trace", 1)?.status, "running");
      assert.equal(reopened.find("trace_event", "old-event")?.trace_id, "old-trace");
      assert.equal(reopened.events("trace:old-trace").length, 1);
      assert.equal(reopened.database.prepare("SELECT COUNT(*) n FROM records WHERE kind IN ('trace','trace_event')").get()?.n, 0);
    } finally { reopened.close(); }
    assert.equal((await migrateTraceStorage(root, true)).migrated, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("migration conflicts leave central Trace records intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-conflict-"));
  const paths = craftPaths(root), store = await new CraftStore(paths).open();
  const now = new Date().toISOString();
  try {
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("trace", "conflict-trace", 1, JSON.stringify({ status: "completed" }), now, now);
  } finally { store.close(); }
  const shard = new TraceShardStore(root);
  try {
    shard.importLegacy("conflict-trace", [{ kind: "trace", id: "conflict-trace", version: 1,
      payload_json: JSON.stringify({ status: "failed" }), created_at: now, updated_at: now }], []);
  } finally { shard.close(); }
  try {
    await assert.rejects(migrateTraceStorage(root, true), /conflicts with shard/u);
    const main = new DatabaseSync(paths.databaseFile, { readOnly: true });
    try { assert.equal(main.prepare("SELECT count(*) n FROM records WHERE kind='trace'").get()?.n, 1); }
    finally { main.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Trace shard reads, filtering, retention, nested transactions and removal handle empty and owned data", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-shard-api-"));
  const shards = new TraceShardStore(root);
  const traceId = "owned-trace";
  try {
    assert.equal(shards.find("trace", traceId), null);
    assert.deepEqual(shards.events(traceId), []);
    assert.deepEqual(shards.children("trace_event", traceId), []);
    assert.deepEqual(shards.retentionCandidates("2026-01-01T00:00:00.000Z", 10), []);
    assert.equal(shards.remove(traceId, [], [], []), 0);
    assert.throws(() => shards.create("trace_event", "missing-owner", {}), /requires trace_id/u);
    assert.throws(() => shards.events(""), /must not be empty/u);

    const base = { status: "completed", last_event_at: "2025-01-01T00:00:00.000Z" };
    shards.create("trace", traceId, base);
    assert.throws(() => shards.create("trace", traceId, base), /already exists/u);
    shards.save("trace", traceId, { ...base, status: "completed" });
    shards.create("trace", "another-old-trace", base);
    shards.create("trace", "trace-without-last-event", { status: "completed", started_at: "2024-01-01T00:00:00.000Z" });
    shards.create("trace_event", "event-a", { trace_id: traceId, sequence: 1, summary: "first" });
    shards.save("trace_event", "event-a", { trace_id: traceId, sequence: 1, summary: "latest" });
    shards.create("trace_feedback", "feedback-a", { trace_id: traceId, helpful: true });
    shards.create("telemetry_event", "telemetry-a", { trace_id: traceId });
    shards.create("trace_archive", "archive-a", { archived: true });
    shards.appendEvent(traceId, "started", { sequence: 1 });
    shards.appendEvent(traceId, "completed", { sequence: 2 });

    const existing = (shards as unknown as { existing(): Array<[string, DatabaseSync]> }).existing();
    for (const [, database] of existing) database.prepare("UPDATE records SET updated_at=? WHERE kind='trace'").run("2025-02-01T00:00:00.000Z");

    assert.equal(shards.find("trace", traceId, 1)?.status, "completed");
    assert.equal(shards.find("trace_event", "event-a")?.summary, "latest");
    assert.equal(shards.find("trace_event", "missing", undefined, traceId), null);
    const listedTraces = shards.list("trace", 10);
    assert.equal(listedTraces.length, 3);
    assert.deepEqual(listedTraces.map(item => String(item.id)), [traceId, "another-old-trace", "trace-without-last-event"].sort((a, b) => b.localeCompare(a)),
      "equal update times use a deterministic descending ID tie-breaker");
    assert.equal(shards.list("trace_event", 10).length, 1);
    assert.equal(shards.list("trace_event", 10, row => row.summary === "latest").length, 1);
    assert.equal(shards.count("trace_event"), 1);
    assert.equal(shards.children("trace_event", traceId)[0]?.summary, "latest");
    assert.equal(shards.retentionCandidates("2030-01-01T00:00:00.000Z", 10).length, 3);
    assert.deepEqual(shards.events(traceId).map(item => item.sequence), [1, 2]);

    assert.throws(() => shards.transaction(traceId, () => shards.transaction(traceId, () => { throw new Error("nested rollback"); })), /nested rollback/u);
    assert.equal(shards.events(traceId).length, 2);
    assert.equal(shards.transaction(traceId, () => "recovered"), "recovered");
    const originalExec = DatabaseSync.prototype.exec;
    try {
      DatabaseSync.prototype.exec = function (this: DatabaseSync, statement: string) {
        const result = originalExec.call(this, statement);
        if (statement === "ROLLBACK") throw new Error("rollback failed after execution");
        return result;
      } as typeof DatabaseSync.prototype.exec;
      assert.throws(() => shards.transaction(traceId, () => { throw new Error("operation failed"); }), /rollback failed after execution/u);
    } finally { DatabaseSync.prototype.exec = originalExec; }
    assert.equal(shards.transaction(traceId, () => "reset"), "reset");
    const now = "2026-01-01T00:00:00.000Z";
    assert.throws(() => shards.importLegacy(traceId, [{ kind: "unknown", id: "x", version: 1,
      payload_json: "{}", created_at: now, updated_at: now }], []), /different owner/u);
    assert.throws(() => shards.importLegacy(traceId, [{ kind: "trace", id: "elsewhere", version: 1,
      payload_json: "{}", created_at: now, updated_at: now }], []), /different owner/u);
    assert.throws(() => shards.importLegacy(traceId, [], [{ stream: "trace:elsewhere", sequence: 1,
      event_type: "x", payload_json: "{}", created_at: now }]), /different owner/u);
    assert.throws(() => shards.importLegacy(traceId, [], [{ stream: `trace:${traceId}`, sequence: 1,
      event_type: "changed", payload_json: "{}", created_at: now }]), /conflicts with shard/u);
    assert.equal(shards.remove(traceId, ["event-a", "absent"], ["feedback-a"], ["telemetry-a"]), 8);
    assert.equal(shards.find("trace", traceId), null);
    assert.equal(shards.events(traceId).length, 0);
  } finally { shards.close(); await rm(root, { recursive: true, force: true }); }

  const unsafeRoot = await mkdtemp(join(tmpdir(), "craft-trace-shard-link-"));
  try {
    await mkdir(join(unsafeRoot, "outside"));
    await symlink(join(unsafeRoot, "outside"), join(unsafeRoot, "trace"));
    assert.throws(() => new TraceShardStore(unsafeRoot).appendEvent(traceId, "event", {}), /regular directories/u);
  } finally { await rm(unsafeRoot, { recursive: true, force: true }); }

  const shardZeroId = Array.from({ length: 10_000 }, (_, index) => `trace-shard-zero-${index}`)
    .find(value => createHash("sha256").update(value).digest()[0]! % 16 === 0)!;
  const linkedRoot = await mkdtemp(join(tmpdir(), "craft-trace-shard-file-link-"));
  try {
    const directory = join(linkedRoot, "trace", "v1"), outside = join(linkedRoot, "outside.db");
    await mkdir(directory, { recursive: true }); await writeFile(outside, ""); await symlink(outside, join(directory, "00.db"));
    assert.throws(() => new TraceShardStore(linkedRoot).appendEvent(shardZeroId, "event", {}), /regular file/u);
  } finally { await rm(linkedRoot, { recursive: true, force: true }); }

  const corruptRoot = await mkdtemp(join(tmpdir(), "craft-trace-shard-corrupt-"));
  try {
    const directory = join(corruptRoot, "trace", "v1");
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "00.db"), "not a SQLite database");
    assert.throws(() => new TraceShardStore(corruptRoot).appendEvent(shardZeroId, "event", {}));
  } finally { await rm(corruptRoot, { recursive: true, force: true }); }
});
