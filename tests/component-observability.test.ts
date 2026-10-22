import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { TraceKernel } from "../core/trace-kernel.ts";
import { ComponentTraceKernel } from "../core/component-trace.ts";
import { observeOperation } from "../common/craft-common-log/src/index.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { toOtlpTrace } from "../common/craft-common-log/src/otlp.ts";
import { DatabaseSync } from "node:sqlite";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-observability-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const trace = new TraceKernel(store), capture = new ComponentTraceKernel(trace, "test-session");
  return { store, trace, capture, async close() { store.close(); await rm(root, { recursive: true }); } };
}

test("reusing a terminal trace creates an observable linked call without reopening history", async () => {
  const f = await fixture();
  try {
    f.trace.start({ trace_id: "closed", task_id: "task" });
    f.trace.finalize({ trace_id: "closed", status: "completed", summary: "Done" });
    let calls = 0;
    const result = await f.capture.capture({ requestId: "1", component: "experience", operation: "inspect", input: { trace_id: "closed" }, handler: () => { calls++; return { status: "ready" }; } });
    assert.equal(calls, 1); assert.equal(result.ok, true);
    assert.notEqual(result.correlation?.trace_id, "closed");
    assert.equal(result.correlation?.linked_trace_id, "closed");
    const events = f.trace.get({ trace_id: result.correlation?.trace_id }).events as JsonObject[];
    assert.ok(events.some(event => event.event_kind === "component.call.completed" && typeof event.duration_ms === "number"));
    assert.equal(f.trace.get({ trace_id: "closed" }).events instanceof Array, true);
  } finally { await f.close(); }
});

test("partial results retain transport completion and safe receipt references without retaining content", async () => {
  const f = await fixture();
  try {
    const result = await f.capture.capture({ requestId: "2", component: "context", operation: "open", input: { query: "private prompt", input_refs: { diff: "artifact:diff" } }, handler: () => ({ partial: true, receipt: { id: "receipt:one" }, content: "private result" }) });
    assert.equal(result.ok, true);
    const events = f.trace.get({ trace_id: result.correlation?.trace_id }).events as JsonObject[];
    const event = events.find(event => event.event_kind === "component.call.completed")!;
    assert.deepEqual(events.find(event => event.event_kind === "component.call.started")!.input_refs, ["artifact:diff"]);
    assert.equal(event.status, "partial"); assert.ok((event.output_refs as string[]).includes("receipt:one"));
    assert.ok(!JSON.stringify(events).includes("private"));
    assert.ok(f.store.count("telemetry_event") >= 2);
    assert.equal(f.store.find("maintenance_component", "trace_retention"), null);
  } finally { await f.close(); }
});

test("service startup does not run retention maintenance synchronously", async () => {
  const f = await fixture();
  try {
    await CraftService.open(f.store);
    assert.equal(f.store.find("maintenance_component", "trace_retention"), null);
  } finally { await f.close(); }
});

test("parallel calls keep child spans under their own parent across asynchronous boundaries", async () => {
  const f = await fixture();
  try {
    const run = (id: string) => f.capture.capture({ requestId: id, component: "context", operation: "open", input: {}, handler: async () => {
      await Promise.resolve();
      return observeOperation(f.store, "knowledge", "contribute", { query: "private prompt" }, async () => { await Promise.resolve(); return { receipt_id: `receipt:${id}` }; });
    } });
    const results = await Promise.all([run("one"), run("two")]);
    assert.notEqual(results[0].correlation?.trace_id, results[1].correlation?.trace_id);
    for (const result of results) {
      const events = f.trace.get({ trace_id: result.correlation?.trace_id }).events as JsonObject[];
      const child = events.find(event => event.source === "knowledge")!;
      assert.equal(child.parent_span_id, result.correlation?.span_id);
      assert.equal(events.filter(event => event.span_id === child.span_id).length, 2);
      const exported = toOtlpTrace({ trace_id: result.correlation?.trace_id }, events);
      const resource = (exported.resourceSpans as JsonObject[])[0];
      const spans = ((resource.scopeSpans as JsonObject[])[0].spans as JsonObject[]);
      assert.equal(new Set(spans.map(span => span.spanId)).size, spans.length);
    }
    assert.ok(!JSON.stringify(f.store.list("telemetry_event", 100)).includes("private prompt"));
  } finally { await f.close(); }
});

test("SDK Context reads and all scoped contributors emit spans without an MCP server", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    await service.contextOpen({ project_root: f.store.paths.root, include_codebase: false, query: "inspect" });
    const events = f.store.list("telemetry_event", 100);
    for (const member of ["context", "knowledge", "memory", "experience"]) assert.ok(events.some(event => event.capability_id === member));
    assert.equal(new Set(events.map(event => event.trace_id)).size, 1);
    assert.ok(events.some(event => event.parent_span_id !== null));
    const traceId = String(events[0]!.trace_id);
    const trace = f.trace.get({ trace_id: traceId });
    assert.equal((trace.trace as JsonObject).status, "completed");
    assert.equal((trace.events as JsonObject[]).filter(event => event.event_kind === "trace.finalized").length, 1);
  } finally { await f.close(); }
});

test("MCP rejects unknown tools and malformed argument containers inside call capture", async () => {
  const f = await fixture();
  try {
    const server = new McpServer(new CraftService(f.store));
    for (const params of [{ name: "not-installed", arguments: {} }, { name: "craft_context_open", arguments: [] }, { name: "craft_context_open", arguments: null }, []]) {
      const result = await server.handle({ jsonrpc: "2.0", id: "bad", method: "tools/call", params });
      const correlation = ((result!.error as JsonObject).data as JsonObject).trace_correlation as JsonObject;
      const events = f.trace.get({ trace_id: correlation.trace_id }).events as JsonObject[];
      assert.ok(events.some(event => event.error_class === "ERR_INVALID_PARAMS"));
    }
  } finally { await f.close(); }
});

test("MCP read-only capability calls do not write component traces or telemetry", async () => {
  const f = await fixture();
  try {
    const server = new McpServer(new CraftService(f.store));
    const response = await server.handle({ jsonrpc: "2.0", id: "readonly", method: "tools/call",
      params: { name: "craft_memory_search", arguments: { query: "no matching memory" } } });
    assert.equal((response?.result as JsonObject).isError, false);
    await server.operationJournal.flush();
    assert.equal(f.store.count("trace"), 0);
    assert.equal(f.store.count("trace_event"), 0);
    assert.equal(f.store.count("telemetry_event"), 0);
    const partitions = await readdir(join(f.store.paths.runtimeDir, "operation-journal"));
    const lineSets = await Promise.all(partitions.map(async partition => {
      const journalFiles = await readdir(join(f.store.paths.runtimeDir, "operation-journal", partition));
      return Promise.all(journalFiles.map(async file => (await readFile(join(f.store.paths.runtimeDir, "operation-journal", partition, file), "utf8"))
        .trim().split("\n").map(line => JSON.parse(line) as JsonObject)));
    }));
    const lines = lineSets.flat(2);
    assert.ok(lines.some(event => event.capability_id === "craft-mcp" && event.operation === "craft_memory_search"));
    assert.ok(lines.some(event => event.outcome === "succeeded"));
    assert.ok(lines.some(event => (event.attributes as JsonObject).input_ref_0_id === "readonly"));
    assert.equal(JSON.stringify(lines).includes("no matching memory"), false);
  } finally { await f.close(); }
});

test("MCP read-only calls complete while another connection owns the primary writer lock", async () => {
  const f = await fixture();
  const writer = new DatabaseSync(f.store.paths.databaseFile);
  try {
    const server = new McpServer(new CraftService(f.store));
    writer.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;");
    let storeTransactions = 0;
    const transaction = f.store.transaction.bind(f.store);
    f.store.transaction = ((operation) => { storeTransactions += 1; return transaction(operation); }) as typeof f.store.transaction;

    const response = await server.handle({ jsonrpc: "2.0", id: "readonly-under-writer", method: "tools/call",
      params: { name: "craft_memory_search", arguments: { query: "no matching memory" } } });

    assert.equal((response?.result as JsonObject).isError, false);
    assert.equal(storeTransactions, 0, "read-only dispatch must not attempt a primary database write");
    assert.equal(f.store.count("trace"), 0);
    writer.exec("ROLLBACK;");
  } finally { try { writer.exec("ROLLBACK;"); } catch { /* The successful path already released it. */ } writer.close(); await f.close(); }
});

test("retention preserves telemetry in a verified archive and reports read-back failure without dropping hot data", async () => {
  const f = await fixture();
  try {
    const result = await f.capture.capture({ requestId: "archive", component: "context", operation: "open", input: {}, handler: () => ({ receipt_id: "receipt:archive" }) });
    const id = String(result.correlation?.trace_id);
    f.store.save("trace", id, { ...f.store.get("trace", id), finalized_at: "2000-01-01T00:00:00.000Z", last_event_at: "2000-01-01T00:00:00.000Z" });
    const read = f.trace.archives.read.bind(f.trace.archives);
    f.trace.archives.read = () => { throw new Error("corrupt archive"); };
    assert.throws(() => f.trace.retentionSweep(), /corrupt/);
    assert.ok(f.store.find("trace", id)); assert.equal(f.store.count("telemetry_event"), 2);
    f.trace.archives.read = read;
    assert.equal(f.trace.retentionSweep().archived, 1);
    assert.equal(f.store.count("telemetry_event"), 0);
    assert.equal((f.trace.get({ trace_id: id }).telemetry_events as JsonObject[]).length, 2);
    assert.equal((f.trace.get({ trace_id: id }).archive as JsonObject).archive_format, "craft.trace.archive.v2");
  } finally { await f.close(); }
});

test("archive file operations run outside the SQLite write transaction", async () => {
  const f = await fixture();
  try {
    const result = await f.capture.capture({ requestId: "short-transaction", component: "context", operation: "open", input: {}, handler: () => ({ receipt_id: "receipt:short" }) });
    const id = String(result.correlation?.trace_id);
    f.store.save("trace", id, { ...f.store.get("trace", id), last_event_at: "2000-01-01T00:00:00.000Z" });
    const probeWriteLock = () => {
      const probe = new DatabaseSync(f.store.paths.databaseFile);
      try { probe.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK;"); }
      finally { probe.close(); }
    };
    const write = f.trace.archives.write.bind(f.trace.archives);
    const read = f.trace.archives.read.bind(f.trace.archives);
    f.trace.archives.write = bundle => { probeWriteLock(); return write(bundle); };
    f.trace.archives.read = pointer => { probeWriteLock(); return read(pointer); };
    assert.equal(f.trace.retentionSweep({ now: "2030-01-01T00:00:00.000Z" }).deleted, 1);
  } finally { await f.close(); }
});

test("retention leaves hot records intact when a trace changes during archive I/O", async () => {
  const f = await fixture();
  try {
    const result = await f.capture.capture({ requestId: "archive-race", component: "context", operation: "open", input: {}, handler: () => ({ receipt_id: "receipt:race" }) });
    const id = String(result.correlation?.trace_id);
    f.store.save("trace", id, { ...f.store.get("trace", id), last_event_at: "2000-01-01T00:00:00.000Z" });
    const write = f.trace.archives.write.bind(f.trace.archives);
    f.trace.archives.write = bundle => {
      const pointer = write(bundle);
      f.store.save("trace", id, { ...f.store.get("trace", id), summary: "updated during archive" });
      return pointer;
    };
    const sweep = f.trace.retentionSweep({ now: "2030-01-01T00:00:00.000Z" });
    assert.equal(sweep.archived, 0);
    assert.equal(f.store.get("trace", id).summary, "updated during archive");
    assert.equal(f.store.find("trace_archive", id), null);
  } finally { await f.close(); }
});

test("retention reuses a published archive pointer when its digest matches", async () => {
  const f = await fixture();
  try {
    f.trace.start({ trace_id: "published-pointer", task_id: "task" });
    f.trace.finalize({ trace_id: "published-pointer", status: "completed", summary: "old" });
    f.store.save("trace", "published-pointer", { ...f.store.get("trace", "published-pointer"), last_event_at: "2000-01-01T00:00:00.000Z" });
    const trace = f.store.get("trace", "published-pointer");
    const events = f.store.listTraceChildren("trace_event", "published-pointer");
    const feedback = f.store.listTraceChildren("trace_feedback", "published-pointer");
    const telemetry = f.store.listTraceChildren("telemetry_event", "published-pointer");
    const pointer = f.trace.archives.write({ trace_id: "published-pointer", trace_version: Number(trace.version), archived_at: "2030-01-01T00:00:00.000Z", trace, events, feedback, ...(telemetry.length ? { telemetry_events: telemetry } : {}) });
    f.store.create("trace_archive", "published-pointer", { trace_id: "published-pointer", trace_version: trace.version, task_id: trace.task_id, status: trace.status, archived_at: "2030-01-01T00:00:00.000Z", last_event_at: trace.last_event_at, event_count: events.length, feedback_count: feedback.length, archive_backend_id: pointer.backend_id ?? "local", archive_storage: pointer.storage, archive_locator: pointer.locator, archive_uri: pointer.uri, archive_format: pointer.format, content_digest: pointer.content_digest, bytes: pointer.bytes });
    assert.equal(f.trace.retentionSweep({ now: "2030-01-01T00:00:00.000Z" }).deleted, 1);
  } finally { await f.close(); }
});

test("retention refuses to delete hot records when archive read-back names another trace", async () => {
  const f = await fixture();
  try {
    f.trace.start({ trace_id: "archive-mismatch", task_id: "task" });
    f.trace.finalize({ trace_id: "archive-mismatch", status: "completed", summary: "old" });
    f.store.save("trace", "archive-mismatch", { ...f.store.get("trace", "archive-mismatch"), last_event_at: "2000-01-01T00:00:00.000Z" });
    f.trace.archives.read = () => ({ trace_id: "another-trace", trace_version: 1, archived_at: "2030-01-01T00:00:00.000Z", trace: {}, events: [], feedback: [] });
    assert.throws(() => f.trace.retentionSweep({ now: "2030-01-01T00:00:00.000Z" }), /does not match/);
    assert.equal(f.store.get("trace", "archive-mismatch").status, "completed");
  } finally { await f.close(); }
});

test("retention rejects an archive pointer published concurrently with a conflicting digest", async () => {
  const f = await fixture();
  try {
    f.trace.start({ trace_id: "archive-pointer-conflict", task_id: "task" });
    f.trace.finalize({ trace_id: "archive-pointer-conflict", status: "completed", summary: "old" });
    f.store.save("trace", "archive-pointer-conflict", { ...f.store.get("trace", "archive-pointer-conflict"), last_event_at: "2000-01-01T00:00:00.000Z" });
    const write = f.trace.archives.write.bind(f.trace.archives);
    f.trace.archives.write = bundle => {
      const pointer = write(bundle);
      f.store.create("trace_archive", "archive-pointer-conflict", { trace_id: "archive-pointer-conflict", trace_version: bundle.trace_version, task_id: "task", status: "completed", archived_at: "2030-01-01T00:00:00.000Z", event_count: 0, feedback_count: 0, archive_backend_id: pointer.backend_id ?? "local", archive_storage: pointer.storage, archive_locator: pointer.locator, archive_uri: pointer.uri, archive_format: pointer.format, content_digest: "sha256:conflict", bytes: pointer.bytes });
      return pointer;
    };
    assert.throws(() => f.trace.retentionSweep({ now: "2030-01-01T00:00:00.000Z" }), /idempotency conflict/);
    assert.equal(f.store.get("trace", "archive-pointer-conflict").status, "completed");
  } finally { await f.close(); }
});

test("retention applies its candidate limit in the SQLite query", async () => {
  const f = await fixture();
  try {
    for (const id of ["bounded-one", "bounded-two", "bounded-three"]) {
      f.trace.start({ trace_id: id, task_id: "task" });
      f.trace.finalize({ trace_id: id, status: "completed", summary: "old" });
      f.store.save("trace", id, { ...f.store.get("trace", id), last_event_at: "2000-01-01T00:00:00.000Z" });
    }
    const result = f.trace.retentionSweep({ now: "2030-01-01T00:00:00.000Z", limit: 1 });
    assert.equal(result.scanned, 1);
    assert.equal(f.store.count("trace"), 2);
  } finally { await f.close(); }
});

test("retention preserves hot evidence when read-back omits current child records", async () => {
  for (const missing of ["events", "feedback", "telemetry_events"] as const) {
    const f = await fixture();
    try {
      const captured = await f.capture.capture({ requestId: "incomplete", component: "context", operation: "read", input: {}, handler: () => ({}) });
      const id = String(captured.correlation?.trace_id);
      f.store.create("trace_feedback", "late-feedback", { trace_id: id, signal: "corrected" });
      const read = f.trace.archives.read.bind(f.trace.archives);
      f.trace.archives.read = pointer => ({ ...read(pointer), [missing]: [] });
      assert.throws(() => f.trace.retentionSweep({ now: "2030-01-01T00:00:00.000Z" }), /current child records/);
      assert.ok(f.store.find("trace", id));
      assert.ok(f.store.find("trace_feedback", "late-feedback"));
      assert.equal(f.store.listTraceChildren("telemetry_event", id).length, 2);
      assert.equal(f.store.find("trace_archive", id), null);
    } finally { await f.close(); }
  }
});

test("retention preserves the legacy timestamp when no last-event timestamp exists", async () => {
  const f = await fixture();
  try {
    const legacy = f.store.create("trace", "legacy-time", { status: "completed", task_id: "task" });
    assert.equal(f.trace.retentionSweep({ now: "2030-01-01T00:00:00.000Z" }).deleted, 1);
    assert.equal(f.store.get("trace_archive", "legacy-time").last_event_at, legacy.updated_at);
  } finally { await f.close(); }
});

test("maintenance records archive failure and applies a retry delay", async () => {
  const f = await fixture();
  try {
    f.store.create("maintenance_component", "trace_retention", { status: "healthy", last_success_at: "2029-12-01T00:00:00.000Z", next_run_at: "2029-12-01T01:00:00.000Z", consecutive_failures: 2 });
    f.trace.start({ trace_id: "maintenance-failure", task_id: "task" });
    f.trace.finalize({ trace_id: "maintenance-failure", status: "completed", summary: "old" });
    f.store.save("trace", "maintenance-failure", { ...f.store.get("trace", "maintenance-failure"), last_event_at: "2000-01-01T00:00:00.000Z" });
    f.trace.archives.write = () => { throw new Error("archive offline"); };
    assert.equal(f.trace.maintain({ now: "2030-01-01T00:00:00.000Z" }).status, "failed");
    assert.equal(f.trace.maintain({ now: "2030-01-01T00:00:30.000Z" }).status, "not_due");
    assert.equal(f.store.get("maintenance_component", "trace_retention").last_success_at, "2029-12-01T00:00:00.000Z");
    assert.equal(f.store.get("maintenance_component", "trace_retention").consecutive_failures, 3);
    assert.equal(f.store.get("trace", "maintenance-failure").status, "completed");
  } finally { await f.close(); }
});

test("maintenance validates time and falls back to the prior success cadence", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.trace.maintain({ now: "invalid" }), /ISO timestamp/);
    for (const limit of [0, 21, 1.5]) assert.throws(() => f.trace.maintain({ limit }), /maintenance limit/u);
    f.store.create("maintenance_component", "trace_retention", { status: "healthy", last_success_at: "2030-01-01T00:00:00.000Z" });
    assert.equal(f.trace.maintain({ now: "2030-01-01T00:30:00.000Z" }).status, "not_due");
    f.store.remove("maintenance_component", "trace_retention");
    f.trace.start({ trace_id: "maintenance-empty-failure", task_id: "task" });
    f.trace.finalize({ trace_id: "maintenance-empty-failure", status: "completed", summary: "old" });
    f.store.save("trace", "maintenance-empty-failure", { ...f.store.get("trace", "maintenance-empty-failure"), last_event_at: "2000-01-01T00:00:00.000Z" });
    f.trace.archives.write = () => { throw new Error("archive offline"); };
    assert.equal(f.trace.maintain({ now: "2030-01-01T01:00:00.000Z" }).status, "failed");
    assert.equal(f.store.get("maintenance_component", "trace_retention").last_success_at, null);
    assert.equal(f.store.get("maintenance_component", "trace_retention").consecutive_failures, 1);
  } finally { await f.close(); }
});

test("maintenance schedules a short retry when one batch reaches its archive limit", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 20; index += 1) {
      const id = `maintenance-batch-${index}`;
      f.trace.start({ trace_id: id, task_id: "task" });
      f.trace.finalize({ trace_id: id, status: "completed", summary: "old" });
      f.store.save("trace", id, { ...f.store.get("trace", id), last_event_at: "2000-01-01T00:00:00.000Z" });
    }
    const result = f.trace.maintain({ now: "2030-01-01T00:00:00.000Z" });
    assert.equal(result.status, "completed");
    assert.equal((result.maintenance as JsonObject).next_run_at, "2030-01-01T00:01:00.000Z");
  } finally { await f.close(); }
});

test("isolated maintenance can restrict a sweep to one trace and retain the remaining backlog", async () => {
  const f = await fixture();
  try {
    for (const id of ["child-first", "child-second"]) {
      f.trace.start({ trace_id: id, task_id: "task" });
      f.trace.finalize({ trace_id: id, status: "completed", summary: "old" });
      f.store.save("trace", id, { ...f.store.get("trace", id), last_event_at: "2000-01-01T00:00:00.000Z" });
    }
    const result = f.trace.maintain({ now: "2030-01-01T00:00:00.000Z", limit: 1 });
    assert.equal((result.result as JsonObject).archived, 1);
    assert.equal(f.store.count("trace"), 1);
    assert.equal((result.maintenance as JsonObject).next_run_at, "2030-01-01T00:01:00.000Z");
  } finally { await f.close(); }
});

test("maintenance advances its next sweep when a full retention batch is archived", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 20; index++) {
      const id = `full-retention-batch-${index}`;
      f.trace.start({ trace_id: id, task_id: "task" });
      f.trace.finalize({ trace_id: id, status: "completed", summary: "old" });
      f.store.save("trace", id, { ...f.store.get("trace", id), last_event_at: "2000-01-01T00:00:00.000Z" });
    }
    const result = f.trace.maintain({ now: "2030-01-01T00:00:00.000Z" });
    assert.equal(result.status, "completed");
    assert.equal((result.result as JsonObject).archived, 20);
    assert.equal((result.maintenance as JsonObject).next_run_at, "2030-01-01T00:01:00.000Z");
  } finally { await f.close(); }
});

test("expired retention owners cannot overwrite a newer worker's success or failure state", async () => {
  for (const outcome of ["success", "failure", "removed"] as const) {
    const f = await fixture();
    const peer = await new CraftStore(f.store.paths).open();
    try {
      let winner: JsonObject | null = null;
      f.trace.retentionSweep = () => {
        assert.equal(new TraceKernel(peer).maintain({ now: "2030-01-01T00:00:30.000Z" }).status, "not_due");
        if (outcome === "removed") peer.remove("maintenance_component", "trace_retention");
        else {
          const next = new TraceKernel(peer);
          if (outcome === "failure") next.retentionSweep = () => { throw new Error("new worker failed"); };
          const takeover = next.maintain({ now: "2030-01-01T00:01:01.000Z" });
          assert.equal(takeover.status, outcome === "failure" ? "failed" : "completed");
          winner = peer.get("maintenance_component", "trace_retention");
        }
        if (outcome === "success") throw new Error("old worker failed after takeover");
        return { archived: 0 };
      };
      const result = f.trace.maintain({ now: "2030-01-01T00:00:00.000Z" });
      assert.equal(result.status, "superseded");
      assert.deepEqual(f.store.find("maintenance_component", "trace_retention"), winner);
    } finally { peer.close(); await f.close(); }
  }
});

test("on-use retention archives overdue traces and keeps its cadence after reopening the store", async () => {
  const f = await fixture();
  try {
    f.trace.start({ trace_id: "old", task_id: "task" });
    f.trace.finalize({ trace_id: "old", status: "completed", summary: "Done" });
    f.store.save("trace", "old", { ...f.store.get("trace", "old"), finalized_at: "2000-01-01T00:00:00.000Z", last_event_at: "2000-01-01T00:00:00.000Z" });
    assert.equal(f.trace.maintain().status, "completed");
    assert.equal(f.trace.get({ trace_id: "old" }).archived, true);
    f.store.close(); await f.store.open();
    assert.equal(f.trace.maintain().status, "not_due");
    assert.equal(f.store.get("maintenance_component", "trace_retention").status, "healthy");
  } finally { await f.close(); }
});
