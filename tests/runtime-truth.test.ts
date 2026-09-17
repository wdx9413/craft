import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { compactConversation, createWorkNote, exportOtlp, parseSseFrames, parseToolCalls, standardizeTrace, toOtlpTrace, toolResultMessage, traceCorrelation } from "../src/runtime-truth.ts";
import { RuntimeTruthKernel } from "../src/runtime-truth-kernel.ts";
import { CraftService } from "../src/service.ts";
import { McpServer } from "../src/mcp.ts";

test("Runtime Truth standardizes legacy traces and maps every span kind to OTLP", () => {
  const legacy = standardizeTrace({ schema: "craft.trace.v1", trace_id: "t", sequence: 1, event_kind: "tool.result", input_refs: ["in"], output_refs: ["out"], data: { token: "hidden" } });
  assert.equal(legacy.schema, "craft.trace"); assert.equal(legacy.schema_revision, 1); assert.equal(legacy.legacy_schema, "craft.trace.v1"); assert.equal(legacy.raw_content, false);
  const correlation = traceCorrelation({ trace_id: "t", run_id: "r", operation_id: "o" }); assert.equal(correlation.trace_id, "t"); assert.equal((correlation.baggage as JsonObject).run_id, "r"); assert.equal((correlation.baggage as JsonObject).operation_id, "o");
  const otlp = toOtlpTrace(legacy, [legacy, { trace_id: "t", sequence: 2, event_kind: "model.request", trust: "observed", data: {} }, { trace_id: "t", sequence: 3, event_kind: "state.observed", trust: "observed", data: {} }]);
  const spans = (((otlp.resourceSpans as JsonObject[])[0]!.scopeSpans as JsonObject[])[0]!.spans as JsonObject[]);
  assert.deepEqual(spans.map((span) => span.kind), [3, 2, 1]); assert.equal(spans[0]!.status && (spans[0]!.status as JsonObject).code, 1);
  assert.throws(() => standardizeTrace({ trace_id: "" }), /trace_id/);
  assert.throws(() => standardizeTrace({ trace_id: "t", sequence: -1 }), /sequence/);
});

test("SSE and provider Tool Calls normalize to one safe shape", () => {
  assert.deepEqual(parseSseFrames("event: message\ndata: {\"delta\":1}\n\ndata: [DONE]\n"), [{ delta: 1 }]);
  assert.throws(() => parseSseFrames("data: nope"), /valid JSON/);
  assert.throws(() => parseSseFrames(1 as never), /string/);
  const openai = parseToolCalls({ choices: [{ message: { tool_calls: [{ id: "call", function: { name: "search", arguments: "{\"q\":\"x\"}" } }] } }] });
  assert.deepEqual(openai, [{ id: "call", name: "search", arguments: { q: "x" } }]);
  const anthropic = parseToolCalls({ content: [{ type: "tool_use", id: "a", name: "write", input: { path: "x" } }] });
  assert.deepEqual(anthropic, [{ id: "a", name: "write", arguments: { path: "x" } }]);
  assert.throws(() => parseToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: "bad" } }] } }] }), /valid JSON/);
  assert.deepEqual(toolResultMessage("call", { token: "secret", ok: true }), { role: "tool", tool_call_id: "call", content: "{\"ok\":true}" });
});

test("conversation compaction and work notes are deterministic and bounded", () => {
  const short = [{ role: "user" as const, content: "hello" }];
  assert.equal(compactConversation(short, 256).compacted, false);
  const long = [{ role: "system" as const, content: "constraint" }, ...Array.from({ length: 12 }, (_, index) => ({ role: "user" as const, content: `${index}-` + "x".repeat(120) }))];
  const compacted = compactConversation(long, 512); assert.equal(compacted.compacted, true); assert.ok(compacted.omitted > 0); assert.equal(compacted.messages[0]!.role, "system");
    assert.throws(() => compactConversation([], 256), /at least one/); assert.throws(() => compactConversation(short, 1), /at least 256/);
  const note = createWorkNote({ goal: "Ship", decisions: ["Keep API"], constraints: ["No secrets"], open_questions: ["OTLP endpoint"], artifacts: ["trace"] });
  assert.equal(note.raw_content, false); assert.match(String(note.digest), /^sha256:/);
  assert.throws(() => createWorkNote({ goal: " " }), /goal/);
});

test("OTLP export validates endpoint and accepts an injected transport", async () => {
  const payload = { resourceSpans: [] };
  const success = await exportOtlp("https://otel.example/v1/traces", payload, async () => ({ status: 202, body: "ok" }));
  assert.equal(success.accepted, true); assert.equal(success.status, 202);
  await assert.rejects(() => exportOtlp("file:///tmp/x", payload, async () => ({ status: 202, body: "" })), /HTTP\(S\)/);
  await assert.rejects(() => exportOtlp("https://otel.example", payload, async () => ({ status: 500, body: "bad" })), /HTTP 500/);
});

test("Runtime Truth covers fallback fields, provider variants, and rejection boundaries", () => {
  const normalized = standardizeTrace({ id: "fallback", event_type: "event", data: { token: "redact", keep: true }, status: null, trust: "human", actor: "user", parent_span_id: "parent" });
  assert.equal(normalized.trace_id, "fallback"); assert.equal(normalized.event_kind, "event"); assert.equal(normalized.parent_span_id, "parent");
  assert.throws(() => standardizeTrace({ trace_id: "x", trust: "" }), /trust/);
  assert.throws(() => standardizeTrace({ trace_id: "x", input_refs: [1] as never }), /input_refs/);
  assert.deepEqual(parseToolCalls({}), []);
  assert.deepEqual(parseToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "search", arguments: {} } }] } }], content: [{ type: "tool_use", id: "u", name: "use" }] }), [{ id: "tool_1", name: "search", arguments: {} }, { id: "u", name: "use", arguments: {} }]);
  assert.throws(() => parseToolCalls({ content: [{ type: "tool_use", id: "", name: "use" }] }), /tool_use id/);
  assert.deepEqual(parseSseFrames("comment\ndata: \ndata: [DONE]\n"), []);
  assert.equal(toOtlpTrace({ trace_id: "x", event_kind: "run", status: "failed", parent_span_id: "p", data: {} }).resourceSpans !== undefined, true);
});

test("Runtime Truth persistence and Full MCP expose the same bounded operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-runtime-truth-")); const store = await new CraftStore(craftPaths(root)).open();
  try {
    const kernel = new RuntimeTruthKernel(store);
    const trace = kernel.standardize({ export_id: "trace", trace: { trace_id: "t", event_kind: "run.started", data: { ok: true } } });
    assert.equal((kernel.standardize({ export_id: "trace", trace: { trace_id: "t", event_kind: "run.started", data: { ok: true } } })).idempotent, true);
    assert.equal((kernel.otlp({ trace: { trace_id: "t", event_kind: "run.started", data: {} } })).format, "otlp/json");
    assert.throws(() => kernel.otlp({ trace: { trace_id: "t" }, events: "invalid" }), /events must be an array/);
    const compacted = kernel.compact({ session_id: "s", messages: [{ role: "user", content: "one" }] }); assert.equal((compacted.compaction as JsonObject).id, "s");
    const exported = await kernel.export({ export_id: "otel", endpoint: "https://otel.example/v1/traces", trace: { trace_id: "t", event_kind: "run.started" }, fetch_impl: async () => ({ status: 202, body: "ok" }) } as never); assert.equal((exported.export as JsonObject).accepted, true); assert.equal((await kernel.export({ export_id: "otel", endpoint: "https://otel.example/v1/traces", trace: { trace_id: "t", event_kind: "run.started" }, fetch_impl: async () => ({ status: 202, body: "ok" }) } as never)).idempotent, true);
    const previousFetch = globalThis.fetch; globalThis.fetch = (async () => new Response("ok", { status: 202 })) as typeof fetch;
    try { const defaultExport = await kernel.export({ export_id: "otel-default", endpoint: "https://otel.example/v1/traces", trace: { trace_id: "t", event_kind: "run.started" } }); assert.equal((defaultExport.export as JsonObject).accepted, true); } finally { globalThis.fetch = previousFetch; }
    const note = kernel.workNote({ note_id: "n", goal: "Goal" }); assert.equal((note.note as JsonObject).id, "n"); assert.equal((kernel.workNote({ note_id: "n", goal: "Goal" })).idempotent, true);
    const service = new CraftService(store); const mcp = new McpServer(service, "full");
    const response = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_runtime_truth_standardize", arguments: { export_id: "mcp", trace: { trace_id: "mcp-trace", event_kind: "run.started" } } } });
    assert.equal(((response!.result as JsonObject).isError), false); assert.equal((trace.export as JsonObject).schema, "craft.trace");
    const exportResponse = await mcp.handle({ id: 2, method: "tools/call", params: { name: "craft_runtime_truth_export", arguments: { endpoint: "file:///tmp/invalid", trace: { trace_id: "mcp-trace" } } } });
    assert.equal(((exportResponse!.result as JsonObject).isError), true);
    const calls: [number, string, JsonObject][] = [[3, "craft_runtime_truth_otlp", { trace: { trace_id: "mcp-trace" } }], [4, "craft_runtime_truth_compact", { session_id: "mcp-session", messages: [{ role: "user", content: "hi" }] }], [5, "craft_runtime_truth_work_note", { note_id: "mcp-note", goal: "test" }]];
    for (const [id, name, arguments_] of calls) {
      const result = await mcp.handle({ id, method: "tools/call", params: { name, arguments: arguments_ } }); assert.equal(((result!.result as JsonObject).isError), false);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
