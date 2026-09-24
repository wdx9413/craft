import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { MAX_TOOL_RESULT_CHARS, compactConversation, createWorkNote, exportOtlp, parseSseFrames, parseToolCalls, standardizeTrace, toOtlpTrace, toolResultMessage, traceCorrelation, truncateToolResult } from "../core/runtime-truth.ts";
import { RuntimeTruthKernel } from "../core/runtime-truth-kernel.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";

test("an oversized tool result is cut to a stated head instead of evicting the conversation", () => {
  const payload = { items: "x".repeat(MAX_TOOL_RESULT_CHARS + 500), tail: "dropped" };
  const encoded = JSON.stringify(payload);
  const message = toolResultMessage("call-1", payload);
  const content = JSON.parse(String(message.content)) as Record<string, unknown>;
  assert.equal(content.truncated, true);
  assert.equal(content.original_chars, encoded.length);
  assert.equal(content.kept_chars, MAX_TOOL_RESULT_CHARS);
  assert.ok(String(content.head).length <= MAX_TOOL_RESULT_CHARS);
  // A sensitive *field* is dropped from what is kept, so truncation cannot
  // smuggle a credential-shaped entry through under its own key.
  const secret = toolResultMessage("call-2", { api_key: "super-secret-token", note: "safe" });
  const secretContent = JSON.parse(String(secret.content)) as Record<string, unknown>;
  assert.equal("api_key" in secretContent, false);
  assert.equal(secretContent.note, "safe");

  // A result inside the ceiling is passed through untouched.
  assert.deepEqual(truncateToolResult({ ok: true }), { ok: true });
  // An explicit ceiling below the size truncates the same way.
  const small = truncateToolResult({ items: "y".repeat(40) }, 16);
  assert.equal((small as Record<string, unknown>).truncated, true);
});

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

test("compaction is governed by a token budget and can stage a real summary", () => {
  const long = [{ role: "system" as const, content: "constraint" },
    ...Array.from({ length: 12 }, (_, index) => ({ role: "user" as const, content: `${index}-` + "x".repeat(120) }))];
  // A token budget is used verbatim (this is what the loop passes); the estimate
  // is the caller's, so compaction and cost control agree on one measure.
  const tokens = (value: string) => value.length;
  const byBudget = compactConversation(long, { budget: { estimate: tokens, maxTokens: 512 } });
  assert.equal(byBudget.compacted, true);
  assert.ok(byBudget.omitted > 0);
  // Stage two: a summariser replaces the digest note with something readable.
  const summarized = compactConversation(long, {
    budget: { estimate: tokens, maxTokens: 512 },
    summarize: (dropped) => `Summary of ${dropped.length} turns: the goal was stated once.`,
  });
  assert.equal(summarized.compacted, true);
  assert.match(String(summarized.messages[1]!.content), /^Summary of \d+ turns/u);
  // Omitting both options keeps the legacy 32,000-character behaviour, so an
  // existing caller that passes an options object still gets a bounded result.
  const legacy = compactConversation(long, {});
  assert.equal(legacy.compacted, false);
  assert.throws(() => compactConversation(long, { budget: { estimate: tokens, maxTokens: 1 } }), /at least 256/u);
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
  assert.deepEqual(traceCorrelation({ trace_id: "x" }).baggage, { task_id: null, run_id: null, operation_id: null });
  assert.equal(compactConversation([{ role: "system", content: null }, { role: "user", content: "x" }], 256).compacted, false);
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
    assert.ok((kernel.standardize({ trace_id: "direct", event_kind: "direct" }).export as JsonObject).id);
    assert.equal((kernel.otlp({ trace_id: "direct", event_kind: "direct" }).format), "otlp/json");
    assert.throws(() => kernel.compact({ session_id: "bad", messages: "nope" as never }), /messages must be an array/);
    assert.ok((kernel.compact({ messages: [{ role: "user", content: "hi" }] }).compaction as JsonObject).id);
    assert.ok((kernel.workNote({ goal: "generated" }).note as JsonObject).id);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.12.43 reads back the compaction and work note a long-running session persisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-runtime-truth-read-")); const store = await new CraftStore(craftPaths(root)).open();
  try {
    const kernel = new RuntimeTruthKernel(store);
    const long = [{ role: "system" as const, content: "constraint" },
      ...Array.from({ length: 12 }, (_, index) => ({ role: "user" as const, content: `${index}-` + "x".repeat(120) }))];

    // The write half. `max_chars` is what makes it compact at all: the default budget is
    // 32,000 characters, and a 12-turn fixture is nowhere near it.
    const written = kernel.compact({ session_id: "session-read", messages: long, max_chars: 512 }); assert.equal(written.compacted, true);
    // The read half. `compact` was persist-only before this, so the one thing a resuming Host
    // needs -- the window it produced earlier -- could not be asked for at all.
    const read = kernel.compactionGet({ session_id: "session-read" });
    const compaction = read.compaction as JsonObject;
    assert.equal(compaction.id, "session-read");
    assert.equal(compaction.compacted, true);
    assert.equal(compaction.omitted, written.omitted);
    assert.equal(compaction.summary_digest, written.summary_digest);
    // And the messages survive the round trip, so a resume can rebuild the request rather than
    // only learn that a compaction once happened.
    assert.deepEqual(compaction.messages, written.messages);
    assert.equal((compaction.messages as JsonObject[])[0]!.role, "system");
    // An explicit version reads that exact revision rather than the latest; a Host replaying a
    // resume must be able to pin one, the same way every other kernel's `get` allows.
    assert.equal((kernel.compactionGet({ session_id: "session-read", version: 1 }).compaction as JsonObject).version, 1);

    // The record id is the session id, so a session that knows only its own name can resume.
    assert.throws(() => kernel.compactionGet({ session_id: "never-written" }), /context_compaction/);
    assert.throws(() => kernel.compactionGet({}), /session_id/);

    // A Host that did not name its session can still find it.
    kernel.compact({ messages: [{ role: "user", content: "generated" }] });
    const listed = kernel.compactionList({});
    assert.equal(listed.count, 2);
    const ids = (listed.compactions as JsonObject[]).map((item) => String(item.session_id));
    assert.equal(ids.length, 2);
    assert(ids.includes("session-read"), "the named session must be listed");
    // The unnamed one got a generated id, which is the point: a session that never chose a name
    // is still findable afterwards.
    const generated = ids.find((id) => id !== "session-read")!;
    assert.match(generated, /^context_/u);
    // The summary is projected without the messages, so a listing stays bounded.
    assert.equal((listed.compactions as JsonObject[]).every((item) => item.messages === undefined), true);
    assert.equal((kernel.compactionList({ limit: 1 }).compactions as JsonObject[]).length, 1);
    assert.throws(() => kernel.compactionList({ limit: 0 }), /between 1 and 1000/);
    assert.throws(() => kernel.compactionList({ limit: 1.5 }), /between 1 and 1000/);

    // The work note is the other half of "resume a long-running session", and had the same
    // write-only defect.
    kernel.workNote({ note_id: "note-read", goal: "Ship it", decisions: ["Keep the API"], open_questions: ["Which model?"] });
    const note = (kernel.workNoteGet({ note_id: "note-read" }).note as JsonObject);
    assert.equal(note.goal, "Ship it");
    assert.deepEqual(note.decisions, ["Keep the API"]);
    assert.deepEqual(note.open_questions, ["Which model?"]);
    assert.equal(note.raw_content, false);
    assert.equal((kernel.workNoteGet({ note_id: "note-read", version: 1 }).note as JsonObject).version, 1);
    assert.throws(() => kernel.workNoteGet({ note_id: "never-written" }), /work_note/);
    assert.throws(() => kernel.workNoteGet({}), /note_id/);

    // Both verbs over the MCP surface, because a Host reaches them no other way.
    const service = new CraftService(store); const mcp = new McpServer(service, "full");
    const readCalls: [number, string, JsonObject][] = [
      [10, "craft_runtime_truth_compaction_get", { session_id: "session-read" }],
      [11, "craft_runtime_truth_compaction_list", { limit: 5 }],
      [12, "craft_runtime_truth_work_note_get", { note_id: "note-read" }],
    ];
    for (const [id, name, arguments_] of readCalls) {
      const result = await mcp.handle({ id, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal(((result!.result as JsonObject).isError), false, `${name} must succeed`);
    }
    const failed = await mcp.handle({ id: 13, method: "tools/call", params: { name: "craft_runtime_truth_work_note_get", arguments: { note_id: "never-written" } } });
    assert.equal(((failed!.result as JsonObject).isError), true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
