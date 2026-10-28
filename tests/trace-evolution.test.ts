import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { assertCurrentReleaseVersion } from "./release-version.ts";
import { McpServer, CORE_TOOLS } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService, VERSION } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { TRACE_SCHEMA_VERSION, TraceKernel } from "../core/trace-kernel.ts";
import { MaintenanceKernel } from "../core/maintenance.ts";
import { stableDigest } from "../core/digest.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-evolution-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  store.create("task", "task", { title: "Trace task", goal: "verify" });
  return { root, store, service: new CraftService(store) };
}

test("Trace lookup uses journal IDs and falls back if the journal is incomplete", async () => {
  const f = await fixture();
  try {
    f.service.traceStart({ trace_id: "indexed", task_id: "task" });
    f.service.traceAppend({ trace_id: "indexed", event_id: "custom-event", event_kind: "action" });
    const events = f.store.events.bind(f.store);
    let requestedLimit: number | undefined;
    f.store.events = (stream, limit) => { requestedLimit = limit; return events(stream, limit); };
    const shardFind = f.store.traceShards.find.bind(f.store.traceShards);
    let locatedTrace: string | undefined;
    f.store.traceShards.find = (kind, id, version, traceId) => { if (kind === "trace_event") locatedTrace = traceId; return shardFind(kind, id, version, traceId); };
    const list = f.store.list.bind(f.store);
    f.store.list = ((kind: string, ...args: unknown[]) => {
      if (kind === "trace_event") throw new Error("unbounded scan");
      return (list as (...values: unknown[]) => JsonObject[])(kind, ...args);
    }) as typeof f.store.list;
    assert.deepEqual((f.service.traceGet({ trace_id: "indexed" }).events as JsonObject[]).map(event => event.id), ["custom-event"]);
    assert.equal(requestedLimit, 2);
    assert.equal(locatedTrace, "indexed");
    f.store.list = list;
    f.store.events = () => [];
    assert.deepEqual((f.service.traceGet({ trace_id: "indexed" }).events as JsonObject[]).map(event => event.id), ["custom-event"]);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Trace journal fast path fails closed on malformed or inconsistent entries", async () => {
  const f = await fixture();
  try {
    f.service.traceStart({ trace_id: "fallback", task_id: "task" });
    f.service.traceAppend({ trace_id: "fallback", event_id: "first", event_kind: "action" });
    f.service.traceAppend({ trace_id: "fallback", event_id: "second", event_kind: "action" });
    assert.equal(f.store.events("trace:fallback", 1).length, 1);
    assert.throws(() => f.store.events("trace:fallback", 0), /positive safe integer/u);
    for (const journal of [[{ payload: {} }, { payload: { event_id: "second" } }],
      [{ payload: { event_id: "first" } }, { payload: { event_id: "first" } }],
      [{ payload: { event_id: "missing" } }, { payload: { event_id: "second" } }],
      [{ payload: { event_id: "second" } }, { payload: { event_id: "first" } }]]) {
      f.store.events = () => journal;
      assert.deepEqual((f.service.traceGet({ trace_id: "fallback" }).events as JsonObject[]).map(event => event.id), ["first", "second"]);
    }
    const find = f.store.find.bind(f.store);
    f.store.find = ((kind: string, id: string, ...args: unknown[]) => {
      const record = (find as (...values: unknown[]) => JsonObject | null)(kind, id, ...args);
      return kind === "trace" && record ? { ...record, event_count: 10_001 } : record;
    }) as typeof f.store.find;
    assert.equal((f.service.traceGet({ trace_id: "fallback" }).events as JsonObject[]).length, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Trace lookup retries a concurrent append and bounds repeated changes", async () => {
  const f = await fixture();
  try {
    f.service.traceStart({ trace_id: "racing", task_id: "task" });
    f.service.traceAppend({ trace_id: "racing", event_kind: "initial" });
    const events = f.store.events.bind(f.store);
    let remaining = 1;
    f.store.events = (stream, limit) => {
      if (remaining-- > 0) f.service.traceAppend({ trace_id: "racing", event_kind: "concurrent" });
      return events(stream, limit);
    };
    const result = f.service.traceGet({ trace_id: "racing" });
    assert.equal((result.trace as JsonObject).event_count, 2);
    assert.equal((result.events as JsonObject[]).length, 2);
    remaining = 2;
    assert.throws(() => f.service.traceGet({ trace_id: "racing" }), /changed during lookup/u);
    const find = f.store.find.bind(f.store);
    let reads = 0;
    f.store.find = ((kind: string, id: string, ...args: unknown[]) => {
      if (kind === "trace" && ++reads === 2) return null;
      return (find as (...values: unknown[]) => JsonObject | null)(kind, id, ...args);
    }) as typeof f.store.find;
    remaining = 0;
    assert.throws(() => f.service.traceGet({ trace_id: "racing" }), /changed during lookup/u);
    f.store.find = find;
    const list = f.store.list.bind(f.store);
    let appendOnFeedback = true;
    f.store.list = ((kind: string, ...args: unknown[]) => {
      const records = (list as (...values: unknown[]) => JsonObject[])(kind, ...args);
      if (kind === "trace_feedback" && appendOnFeedback) { appendOnFeedback = false; f.service.traceAppend({ trace_id: "racing", event_kind: "feedback-race" }); }
      return records;
    }) as typeof f.store.list;
    const afterFeedback = f.service.traceGet({ trace_id: "racing" });
    assert.equal((afterFeedback.trace as JsonObject).event_count, (afterFeedback.events as JsonObject[]).length);
    reads = 0;
    f.store.find = ((kind: string, id: string, ...args: unknown[]) => {
      if (kind === "trace" && ++reads === 3) return null;
      return (find as (...values: unknown[]) => JsonObject | null)(kind, id, ...args);
    }) as typeof f.store.find;
    assert.throws(() => f.service.traceGet({ trace_id: "racing" }), /changed during lookup/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("feedback and its Trace event commit together and cannot be reused across Traces", async () => {
  const f = await fixture();
  try {
    f.service.traceStart({ trace_id: "feedback-first", task_id: "task" });
    f.service.traceStart({ trace_id: "feedback-second", task_id: "task" });
    f.service.traceFeedback({ trace_id: "feedback-first", feedback_id: "shared-feedback", signal: "corrected", summary: "same", value: {}, outcome: "verified" });
    assert.throws(() => f.service.traceFeedback({ trace_id: "feedback-second", feedback_id: "shared-feedback", signal: "corrected", summary: "same" }), /idempotency conflict/u);
    assert.throws(() => f.service.traceFeedback({ trace_id: "feedback-first", feedback_id: "shared-feedback", signal: "corrected", summary: "same", value: { changed: true } }), /idempotency conflict/u);
    assert.throws(() => f.service.traceFeedback({ trace_id: "feedback-first", feedback_id: "shared-feedback", signal: "corrected", summary: "same", actor: "model" }), /idempotency conflict/u);
    assert.throws(() => f.service.traceFeedback({ trace_id: "feedback-first", feedback_id: "shared-feedback", signal: "corrected", summary: "same", outcome: "better" }), /idempotency conflict/u);
    assert.throws(() => f.service.traceFeedback({ trace_id: "feedback-first", feedback_id: "shared-feedback", signal: "corrected", summary: "same", evidence_ids: ["other"] }), /idempotency conflict/u);
    assert.equal(f.service.traceFeedback({ trace_id: "feedback-first", feedback_id: "shared-feedback", signal: "corrected", summary: "same",
      value: {}, actor: "human", evidence_ids: [], outcome: "verified" }).idempotent, true);
    f.service.traceFinalize({ trace_id: "feedback-second", status: "completed", summary: "done" });
    assert.throws(() => f.service.traceFeedback({ trace_id: "feedback-second", feedback_id: "terminal-feedback", signal: "corrected", summary: "late" }), /terminal Trace/u);
    assert.equal(f.store.find("trace_feedback", "terminal-feedback"), null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("feedback rollback also preserves legacy central Trace data", async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString();
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("trace", "legacy-feedback", 1, JSON.stringify({ task_id: "task", status: "completed", event_count: 0, next_sequence: 0 }), now, now);
    assert.throws(() => f.service.traceFeedback({ trace_id: "legacy-feedback", feedback_id: "legacy-terminal", signal: "corrected", summary: "late" }), /terminal Trace/u);
    assert.equal(f.store.find("trace_feedback", "legacy-terminal"), null);
    assert.equal(f.store.events("trace:legacy-feedback").length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("simultaneous feedback IDs across different Trace shards do not both commit", async () => {
  const f = await fixture();
  const otherStore = await new CraftStore(craftPaths(join(f.root, "data"))).open();
  try {
    const otherService = new CraftService(otherStore);
    f.service.traceStart({ trace_id: "race-a", task_id: "task" });
    f.service.traceStart({ trace_id: "race-b", task_id: "task" });
    const find = f.store.find.bind(f.store);
    let interleaved = false;
    f.store.find = ((kind: string, id: string, ...args: unknown[]) => {
      const found = (find as (...values: unknown[]) => JsonObject | null)(kind, id, ...args);
      if (!interleaved && kind === "trace_feedback" && id === "racing-feedback") {
        interleaved = true;
        otherService.traceFeedback({ trace_id: "race-b", feedback_id: id, signal: "corrected", summary: "observed" });
      }
      return found;
    }) as typeof f.store.find;
    assert.throws(() => f.service.traceFeedback({ trace_id: "race-a", feedback_id: "racing-feedback", signal: "corrected", summary: "observed" }), /conflict/u);
    assert.equal(f.store.find("trace_feedback", "racing-feedback"), null);
    assert.equal(otherService.traceFeedback({ trace_id: "race-b", feedback_id: "racing-feedback", signal: "corrected", summary: "observed" }).idempotent, false);
    assert.throws(() => f.service.traceFeedback({ trace_id: "race-a", feedback_id: "racing-feedback", signal: "corrected", summary: "observed" }), /idempotency conflict/u);
  } finally { otherStore.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("different feedback lock partitions do not block each other", async () => {
  const f = await fixture();
  const otherStore = await new CraftStore(craftPaths(join(f.root, "data"))).open();
  try {
    const otherService = new CraftService(otherStore), firstId = "first-feedback";
    const secondId = Array.from({ length: 100 }, (_, index) => `other-feedback-${index}`)
      .find(id => stableDigest(id).slice(7, 9) !== stableDigest(firstId).slice(7, 9))!;
    f.service.traceStart({ trace_id: "race-a", task_id: "task" });
    f.service.traceStart({ trace_id: "race-b", task_id: "task" });
    const find = f.store.find.bind(f.store);
    let interleaved = false;
    f.store.find = ((kind: string, id: string, ...args: unknown[]) => {
      const found = (find as (...values: unknown[]) => JsonObject | null)(kind, id, ...args);
      if (!interleaved && kind === "trace_feedback" && id === firstId) {
        interleaved = true;
        otherService.traceFeedback({ trace_id: "race-b", feedback_id: secondId, signal: "corrected", summary: "observed" });
      }
      return found;
    }) as typeof f.store.find;
    assert.equal(f.service.traceFeedback({ trace_id: "race-a", feedback_id: firstId, signal: "corrected", summary: "observed" }).idempotent, false);
    assert.equal(otherStore.find("trace_feedback", secondId)?.trace_id, "race-b");
  } finally { otherStore.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a crashed lock owner releases its feedback partition", async () => {
  const f = await fixture();
  const directory = join(f.store.paths.runtimeDir, "trace-feedback-locks");
  mkdirSync(directory, { recursive: true });
  const lockFile = join(directory, `${stableDigest("crash-feedback").slice(7, 9)}.db`);
  const child = spawn(process.execPath, ["-e", "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('ready'); setInterval(() => {}, 1000);", lockFile], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(child.stdout!, "data");
    f.service.traceStart({ trace_id: "crash-trace", task_id: "task" });
    const feedback = { trace_id: "crash-trace", feedback_id: "crash-feedback", signal: "corrected", summary: "observed" };
    assert.throws(() => f.service.traceFeedback(feedback), /busy/u);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.equal(f.service.traceFeedback(feedback).idempotent, false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("feedback locks reject unsafe paths and report unexpected database errors", async () => {
  const f = await fixture();
  try {
    f.service.traceStart({ trace_id: "lock-path", task_id: "task" });
    const runtime = f.store.paths.runtimeDir, directory = join(runtime, "trace-feedback-locks"), target = join(f.root, "target");
    mkdirSync(runtime, { recursive: true }); mkdirSync(target);
    symlinkSync(target, directory, "dir");
    const input = { trace_id: "lock-path", feedback_id: "lock-id", signal: "corrected", summary: "safe" };
    assert.throws(() => f.service.traceFeedback(input), /directory is unsafe/u);
    unlinkSync(directory); mkdirSync(directory);
    const lockFile = join(directory, `${stableDigest("lock-id").slice(7, 9)}.db`);
    symlinkSync(target, lockFile, "dir");
    assert.throws(() => f.service.traceFeedback(input), /file is unsafe/u);
    unlinkSync(lockFile);
    symlinkSync(join(f.root, "missing"), lockFile);
    assert.throws(() => f.service.traceFeedback(input), /file is unsafe/u);
    unlinkSync(lockFile);
    const original = DatabaseSync.prototype.exec;
    try {
      DatabaseSync.prototype.exec = function (sql: string) { if (sql === "BEGIN IMMEDIATE") throw new Error("unexpected storage error"); return original.call(this, sql); };
      assert.throws(() => f.service.traceFeedback(input), /unexpected storage error/u);
    } finally { DatabaseSync.prototype.exec = original; }
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Trace lookup detects a concurrent archive and reads it on retry", async () => {
  const f = await fixture();
  try {
    f.service.traceStart({ trace_id: "archive-race", task_id: "task" });
    f.service.traceAppend({ trace_id: "archive-race", event_kind: "action" });
    f.service.traceFinalize({ trace_id: "archive-race", status: "completed", summary: "done" });
    const events = f.store.events.bind(f.store);
    let archive = true;
    f.store.events = (stream, limit) => {
      const result = events(stream, limit);
      if (archive) { archive = false; f.service.traceRetentionSweep({ now: "2100-01-01T00:00:00.000Z" }); }
      return result;
    };
    assert.throws(() => f.service.traceGet({ trace_id: "archive-race" }), /changed during lookup/u);
    const result = f.service.traceGet({ trace_id: "archive-race" });
    assert.equal(result.archived, true);
    assert.equal((result.events as JsonObject[]).length, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Experience result binding preserves content-free response and result references in Trace storage", async () => {
  const f = await fixture();
  try {
    const response = `sha256:${"a".repeat(64)}`, result = `sha256:${"b".repeat(64)}`;
    f.service.traceStart({ trace_id: "binding", task_id: "task", operation_id: "ticket" });
    const appended = f.service.traceAppend({ trace_id: "binding", event_kind: "model.result_bound", actor: "experience-learning-worker",
      source: "craft-experience", trust: "observed", operation_id: "ticket", input_refs: [response], output_refs: ["request", result],
      data: { request_id: "request", request_version: 1, response_digest: response, result_digest: result, decision: "unclassified" } });
    const event = appended.event as JsonObject;
    assert.deepEqual(event.input_refs, [response]);
    assert.deepEqual(event.output_refs, ["request", result]);
    assert.equal(event.content_stored, false);
    assert.equal(event.trust, "observed");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Trace Kernel provides canonical append, observation, feedback and terminal closure", async () => {
  const f = await fixture();
  try {
    const start = f.service.traceStart({ trace_id: "trace", task_id: "task", trial_id: "trial", model_fingerprint: "model:v1", environment_fingerprint: "env:v1", capability_fingerprint: "cap:v1", policy_fingerprint: "policy:v1", metadata: { source: "test" } });
    assert.equal((start.trace as JsonObject).schema, TRACE_SCHEMA_VERSION);
    assert.equal(f.service.traceStart({ trace_id: "trace", task_id: "task", trial_id: "trial", model_fingerprint: "model:v1", environment_fingerprint: "env:v1", capability_fingerprint: "cap:v1", policy_fingerprint: "policy:v1", metadata: { source: "test" } }).idempotent, true);
    assert.throws(() => f.service.traceStart({ trace_id: "trace", task_id: "other" }), /idempotency conflict/);
    const eventInput = { trace_id: "trace", event_id: "event-1", event_kind: "action.started", operation_id: "craft_knowledge_search", actor: "model", source: "codex", trust: "untrusted", data: { action: "inspect" }, action_contract: { effect: "read_only" }, state_before: { digest: "before" }, state_after: { digest: "after" }, input_refs: ["input-1"], output_refs: ["output-1"], capability_revision: "cap:v1", policy_revision: "policy:v1", model_fingerprint: "model:v1", environment_fingerprint: "env:v1", workspace_before: "snap-before", workspace_after: "snap-after", usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: 0.01, duration_ms: 20, summary: "inspect" };
    const first = f.service.traceAppend(eventInput); assert.equal((first.event as JsonObject).sequence, 1);
    assert.equal(f.service.traceAppend(eventInput).idempotent, true);
    assert.throws(() => f.service.traceAppend({ ...eventInput, data: { action: "different" } }), /idempotency conflict/);
    assert.throws(() => f.service.traceAppend({ trace_id: "trace", sequence: 3, event_kind: "gap" }), /contiguous/);
    assert.throws(() => f.service.traceAppend({ trace_id: "trace", event_kind: "secret", data: { token: "bad" } }), /sensitive/);
    const observed = f.service.traceObserve({ trace_id: "trace", event_id: "event-2", state_before: { digest: "after" }, state_after: { digest: "final" }, workspace_before: "snap-after", workspace_after: "snap-final", summary: "reobserved" });
    assert.equal((observed.event as JsonObject).trust, "observed");
    const feedback = f.service.traceFeedback({ trace_id: "trace", feedback_id: "feedback", signal: "corrected", summary: "user corrected output", value: { changed_paths: 1 }, evidence_ids: ["evidence-1"], outcome: "better" });
    assert.equal((feedback.feedback as JsonObject).signal, "corrected");
    assert.equal(f.service.traceFeedback({ trace_id: "trace", feedback_id: "feedback", signal: "corrected", summary: "user corrected output" }).idempotent, true);
    assert.throws(() => f.service.traceFeedback({ trace_id: "trace", signal: "unknown", summary: "no" }), /unsupported/);
    const final = f.service.traceFinalize({ trace_id: "trace", status: "completed", summary: "observed complete", verdict: "passed", evidence_ids: ["evidence-1"] });
    assert.equal((final.trace as JsonObject).status, "completed");
    assert.equal(f.service.traceFinalize({ trace_id: "trace", status: "failed", summary: "ignored" }).idempotent, true);
    assert.throws(() => f.service.traceAppend({ trace_id: "trace", event_kind: "late" }), /terminal/);
    assert.throws(() => f.service.traceFinalize({ trace_id: "new", status: "running", summary: "bad" }), /Unknown trace/);
    f.service.traceStart({ trace_id: "invalid-final", task_id: "task" });
    assert.throws(() => f.service.traceFinalize({ trace_id: "invalid-final", status: "running", summary: "bad" }), /unsupported/);
    const details = f.service.traceGet({ trace_id: "trace" }); assert.equal((details.events as JsonObject[]).length, 4); assert.equal((details.feedback as JsonObject[]).length, 1);
    assert.equal((f.service.traceQuery({ trace_id: "trace", event_kind: "state.observed" }).events as JsonObject[]).length, 1);
    assert.equal((f.service.traceQuery({ operation_id: "craft_knowledge_search" }).events as JsonObject[]).length, 1);
    assert.equal((f.service.traceQuery({ operation_id: "craft_memory_ledger_list" }).events as JsonObject[]).length, 0);
    assert.equal((f.service.traceQuery({ task_id: "task", limit: 1 }).events as JsonObject[]).length, 1);
    assert.equal((f.service.traceReplayBundle({ trace_id: "trace" }).replayable), false);
    assert.equal((f.service.traceCaseCompile({ trace_id: "trace", case_id: "case", summary: "sanitized trace case" }).case as JsonObject).sanitized, true);
    assert.equal(f.service.traceCaseCompile({ trace_id: "trace", case_id: "case", summary: "sanitized trace case" }).idempotent, true);
    assert.throws(() => f.service.traceCaseCompile({ trace_id: "trace", case_id: "held", partition: "held_out", summary: "held" }), /approved_by/);
    assert.throws(() => f.service.traceCaseCompile({ trace_id: "trace", case_id: "bad", partition: "unknown", summary: "bad" }), /unsupported/);
    assert.throws(() => f.service.traceGet({ trace_id: "missing-archive" }), /Unknown trace/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Trace replay and retention policies are deterministic and bounded", async () => {
  const f = await fixture();
  try {
    f.service.traceStart({ trace_id: "replay", task_id: "task", model_fingerprint: "m", environment_fingerprint: "e", capability_fingerprint: "c", policy_fingerprint: "p" });
    f.service.traceAppend({ trace_id: "replay", event_kind: "action", action_contract: { effect: "read_only" }, data: { operation: "read" } });
    f.service.traceFinalize({ trace_id: "replay", status: "failed", summary: "failed safely" });
    assert.equal(f.service.traceReplayBundle({ trace_id: "replay" }).replayable, true);
    assert.equal(f.service.traceRetentionPlan({ policy_id: "policy", max_days: 7, max_events: 10, pii_mode: "digest_only" }).idempotent, false);
    assert.equal(f.service.traceRetentionPlan({ policy_id: "policy", max_days: 7, max_events: 10, pii_mode: "digest_only" }).idempotent, true);
    assert.throws(() => f.service.traceRetentionPlan({ policy_id: "policy", max_days: 8, max_events: 10 }), /idempotency conflict/);
    assert.throws(() => f.service.traceRetentionPlan({ max_days: 0 }), /positive integer/);
    assert.throws(() => f.service.traceRetentionPlan({ max_events: 0 }), /positive integer/);
    assert.throws(() => f.service.traceQuery({ limit: 0 }), /between 1 and 10000/);
    assertCurrentReleaseVersion(VERSION);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("legacy Trial Trace is projected into the canonical Trace and MCP surfaces expose it", async () => {
  const f = await fixture();
  try {
    f.store.create("trial", "trial", { task_id: "task", subject_type: "workflow", subject_id: "subject", subject_version: 1 });
    const appended = f.service.trialTraceAppend({ trial_id: "trial", event_type: "workflow.started", source: "program_verified", data: { phase: "start" } }); assert.equal(appended.sequence, 1);
    assert.equal((f.service.traceGet({ trace_id: "trial:trial" }).events as JsonObject[]).length, 1);
    f.service.outcomeRecord({ trial_id: "trial", verdict: "passed", summary: "done", scores: {}, costs: {}, evidence_ids: [], source: "program_verified" });
    assert.equal((f.service.traceGet({ trace_id: "trial:trial" }).events as JsonObject[]).length, 3);
    const mcp = new McpServer(f.service, "full");
    for (const [name, args] of [["craft_trace_get", { trace_id: "trial:trial" }], ["craft_trace_query", { trace_id: "trial:trial" }], ["craft_trace_replay_bundle", { trace_id: "trial:trial" }]] as [string, JsonObject][]) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } }); assert.equal((response?.result as JsonObject).isError, false);
    }
    const calls: [string, JsonObject][] = [
      ["craft_trace_start", { trace_id: "mcp-trace", task_id: "task" }],
      ["craft_trace_append", { trace_id: "mcp-trace", event_kind: "action", operation_id: "craft_knowledge_search", data: {}, action_contract: { effect: "read_only" } }],
      ["craft_trace_observe", { trace_id: "mcp-trace", state_before: {}, state_after: {}, summary: "observed" }],
      ["craft_trace_feedback", { trace_id: "mcp-trace", signal: "accepted", summary: "accepted" }],
      ["craft_trace_finalize", { trace_id: "mcp-trace", status: "completed", summary: "complete" }],
      ["craft_trace_get", { trace_id: "mcp-trace" }],
      ["craft_trace_query", { trace_id: "mcp-trace", operation_id: "craft_knowledge_search" }],
      ["craft_trace_replay_bundle", { trace_id: "mcp-trace" }],
      ["craft_trace_case_compile", { trace_id: "mcp-trace", summary: "case" }],
      ["craft_trace_retention_plan", { policy_id: "mcp-policy", max_days: 10, max_events: 20 }],
      ["craft_trace_retention_sweep", { now: "2030-01-01T00:00:00.000Z", max_days: 7 }],
    ];
    for (const [name, args] of calls) { const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } }); assert.equal((response?.result as JsonObject).isError, false); }
    assert.ok(CORE_TOOLS.some((tool) => tool.name === "craft_trace_get"));
    assert.ok(mcp.tools.some((tool) => tool.name === "craft_trace_case_compile"));
    const kernel = new TraceKernel(f.store); assert.equal((kernel.query({ trace_id: "trial:trial" }).count), 3);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Trace retention archives terminal records for seven days and preserves active work", async () => {
  const f = await fixture();
  try {
    f.service.traceStart({ trace_id: "old", task_id: "task" });
    f.service.traceAppend({ trace_id: "old", event_kind: "action", operation_id: "craft_experience_observe", data: {}, action_contract: { effect: "read_only" } });
    f.service.traceFeedback({ trace_id: "old", signal: "corrected", summary: "reviewed" });
    f.service.traceFinalize({ trace_id: "old", status: "completed", summary: "done" });
    const old = new Date("2020-01-01T00:00:00.000Z").toISOString();
    const record = f.store.get("trace", "old");
    f.store.save("trace", "old", { ...record, last_event_at: old, updated_at: old });
    f.service.traceStart({ trace_id: "active", task_id: "task" });
    const result = f.service.traceRetentionSweep({ now: "2030-01-01T00:00:00.000Z" });
    assert.equal(result.archived, 1); assert.equal(result.deleted, 1); assert.equal(result.max_days, 7);
    assert.throws(() => f.store.get("trace", "old"), /Unknown trace/);
    const archived = f.service.traceGet({ trace_id: "old" });
    assert.equal(archived.archived, true); assert.equal((archived.trace as JsonObject).status, "completed"); assert.equal((archived.events as JsonObject[]).length, 3);
    assert.equal((f.service.traceQuery({ trace_id: "old" }).events as JsonObject[]).every((event) => event.archived === true), true);
    assert.equal((f.service.traceQuery({ trace_id: "old", operation_id: "craft_experience_observe" }).events as JsonObject[]).length, 1);
    assert.equal(f.store.events("trace:old").length, 0);
    assert.equal(f.store.get("trace", "active").status, "running");
    const archiveDir = join(f.store.paths.logsDir, "trace-archive");
    assert.equal(existsSync(archiveDir), true); assert.equal(readdirSync(archiveDir).length, 1);
    assert.equal(f.service.traceRetentionSweep({ now: "2030-01-01T00:00:00.000Z" }).deleted, 0);
    assert.throws(() => f.service.traceRetentionSweep({ now: "invalid" }), /ISO timestamp/);
    assert.throws(() => f.service.traceRetentionSweep({ max_days: 0 }), /positive integer/);
    assert.throws(() => f.service.traceRetentionSweep({ limit: 0 }), /between 1 and 10000/);
    f.service.traceStart({ trace_id: "maintenance-old", task_id: "task" });
    f.service.traceFinalize({ trace_id: "maintenance-old", status: "completed", summary: "maintenance cleanup" });
    const maintenanceRecord = f.store.get("trace", "maintenance-old");
    f.store.save("trace", "maintenance-old", { ...maintenanceRecord, last_event_at: old, updated_at: old });
    const maintenance = new MaintenanceKernel(f.service).tick({ now: "2030-01-01T00:00:00.000Z" });
    assert.equal((maintenance.trace_retention as JsonObject).deleted, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Trace Kernel handles omitted optional fields, alternate event names, and bounded validation", async () => {
  const f = await fixture();
  try {
    const started = f.service.traceStart({ task_id: "task" });
    const traceId = String((started.trace as JsonObject).id);
    assert.equal(String((started.trace as JsonObject).metadata_digest).startsWith("sha256:"), true);
    assert.equal(f.service.traceStart({ trace_id: traceId, task_id: "task" }).idempotent, true);
    const event = f.service.traceAppend({ trace_id: traceId, event_type: "legacy.event", data: {} });
    assert.equal((event.event as JsonObject).event_kind, "legacy.event");
    assert.equal(f.service.traceObserve({ trace_id: traceId, data: null, state_before: null, state_after: null }).event !== undefined, true);
    assert.throws(() => f.service.traceAppend({ trace_id: traceId, event_kind: "bad", data: [], action_contract: [] }), /object/);
    assert.throws(() => f.service.traceAppend({ trace_id: traceId, event_kind: "bad", data: {}, trust: "bad" }), /unsupported/);
    assert.throws(() => f.service.traceAppend({ trace_id: traceId, event_kind: "bad", data: {}, input_refs: ["same", "same"] }), /unique/);
    assert.throws(() => f.service.traceFeedback({ trace_id: traceId, signal: "bad", summary: "x" }), /unsupported/);
    const feedback = f.service.traceFeedback({ trace_id: traceId, signal: "accepted", summary: "accepted" });
    assert.equal((feedback.feedback as JsonObject).value, null);
    assert.throws(() => f.service.traceFeedback({ trace_id: traceId, signal: "rejected", summary: "x", value: [] }), /object/);
    assert.throws(() => f.service.traceQuery({ limit: 1.5 }), /between/);
    assert.equal((f.service.traceQuery({}).count as number) >= 3, true);
    const human = f.service.traceAppend({ trace_id: traceId, event_kind: "human.note", source: "human", data: {} });
    assert.equal((human.event as JsonObject).trust, "human");
    f.service.traceFeedback({ trace_id: traceId, feedback_id: "feedback-conflict", signal: "accepted", summary: "one" });
    assert.throws(() => f.service.traceFeedback({ trace_id: traceId, feedback_id: "feedback-conflict", signal: "rejected", summary: "two" }), /idempotency conflict/);
    const machineFeedback = f.service.traceFeedback({ trace_id: traceId, feedback_id: "machine-feedback", signal: "retried", summary: "machine retry", actor: "model" });
    assert.equal((machineFeedback.feedback as JsonObject).actor, "model");
    f.service.traceStart({ trace_id: "held-trace", task_id: "task" });
    f.service.traceFinalize({ trace_id: "held-trace", status: "completed", summary: "held source" });
    const held = f.service.traceCaseCompile({ trace_id: "held-trace", case_id: "held-approved", partition: "held_out", approved_by: "reviewer", summary: "held case" });
    assert.equal((held.case as JsonObject).approved_by, "reviewer");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Trace Kernel closes remaining malformed, conflict, and retention branches", async () => {
  const f = await fixture();
  try {
    const started = f.service.traceStart({ trace_id: "branch-trace", task_id: "task" });
    assert.throws(() => f.service.traceStart({ trace_id: "branch-trace", task_id: "other" }), /idempotency conflict/);
    assert.throws(() => f.service.traceAppend({ trace_id: "branch-trace", event_kind: "x", data: {}, cost_usd: -1 }), /non-negative/);
    assert.throws(() => f.service.traceAppend({ trace_id: "branch-trace", event_kind: "x", data: {}, input_refs: "bad" as never }), /array/);
    assert.throws(() => f.service.traceAppend({ trace_id: "branch-trace", event_kind: "x", data: {}, action_contract: "bad" as never }), /object/);
    const event = f.service.traceAppend({ trace_id: "branch-trace", event_id: "same", event_kind: "x", data: {} });
    assert.equal(f.service.traceAppend({ trace_id: "branch-trace", event_id: "same", event_kind: "x", data: {} }).idempotent, true);
    assert.throws(() => f.service.traceAppend({ trace_id: "branch-trace", event_id: "same", event_kind: "different", data: {} }), /idempotency conflict/);
    assert.throws(() => f.service.traceFeedback({ trace_id: "branch-trace", feedback_id: "f", signal: "accepted", summary: "a", value: { token: "secret-value" } }), /sensitive/);
    f.service.traceFinalize({ trace_id: "branch-trace", status: "blocked", summary: "done" });
    assert.equal((f.service.traceQuery({ trace_id: "branch-trace", event_kind: "missing" }).events as JsonObject[]).length, 0);
    assert.throws(() => f.service.traceCaseCompile({ trace_id: "branch-trace", partition: "held_out", approved_by: "", summary: "bad" }), /approved_by/);
    assert.throws(() => f.service.traceRetentionPlan({ policy_id: "branch-policy", max_days: 1, max_events: 1, replace: "yes" as never }), /boolean/);
    assert.equal(f.service.traceRetentionPlan({ policy_id: "branch-policy", max_days: 1, max_events: 1, pii_mode: "digest_only" }).idempotent, false);
    assert.throws(() => f.service.traceRetentionPlan({ policy_id: "branch-policy", max_days: 2, max_events: 2 }), /idempotency conflict/);
    assert.equal(f.service.traceRetentionPlan({ policy_id: "branch-policy", max_days: 2, max_events: 2, replace: true }).idempotent, false);
    assert.ok(event.event);
    assert.throws(() => f.service.traceQuery({ trace_id: "" }), /trace_id/);
    f.service.traceStart({ trace_id: "running-case", task_id: "task" });
    assert.throws(() => f.service.traceCaseCompile({ trace_id: "running-case", summary: "not terminal" }), /terminal/);
    assert.equal(f.service.traceCaseCompile({ trace_id: "branch-trace", case_id: "branch-case", summary: "case" }).idempotent, false);
    assert.equal(f.service.traceCaseCompile({ trace_id: "branch-trace", case_id: "branch-case", summary: "case" }).idempotent, true);
    assert.throws(() => f.service.traceCaseCompile({ trace_id: "branch-trace", case_id: "branch-case", summary: "changed" }), /idempotency conflict/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
