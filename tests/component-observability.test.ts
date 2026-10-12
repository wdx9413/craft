import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
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
