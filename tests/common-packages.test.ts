import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CraftTelemetry, JsonlTelemetryJournal, StoreTelemetrySink, telemetryEvent, toOtlpTrace, exportOtlp, observeOperation, withoutOperationPersistence, currentOperation, operationErrorCode, operationResultStatus, operationEventId, observeMethods, observedKernel, type OperationEvent } from "../common/craft-common-log/src/index.ts";
import { CraftStore, type JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { ComponentTraceKernel } from "../core/component-trace.ts";
import { TraceKernel } from "../core/trace-kernel.ts";
import { EvaluationContractKernel } from "../common/craft-common-log/src/evaluation-contract.ts";
import { ContextBudget, ContextBudgetError, contextAssetKey, contextAssetMatches, contextAssetRef, requiredContextRef } from "../common/craft-common-base/src/context-assets.ts";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Context asset references are explicit, scoped, and compare only pinned dimensions", () => {
  assert.throws(() => contextAssetRef("unknown", { id: "x", version: 1 }, {}), /Unsupported Context asset member/u);
  assert.throws(() => contextAssetRef("memory", { version: 1 }, {}), /Context asset id/u);
  assert.throws(() => contextAssetRef("memory", { id: "x", version: 0 }, {}), /explicit and positive/u);
  const ref = contextAssetRef("memory", { memory_id: "m1", memory_version: 2, content_version: 7,
    content_digest: "sha256:content", scope: "project:p", source_id: "s", index_id: "i", checkpoint_id: "c" }, { scope: "global" });
  assert.deepEqual(ref, { member: "memory", id: "m1", version: 2, content_version: 7, digest: "sha256:content",
    scope: { kind: "project", id: "p" }, source_id: "s", index_id: "i", checkpoint_id: "c" });
  const fallback = contextAssetRef("knowledge", { id: "k", version: 1 }, { kind: "project", id: "p" });
  assert.equal(fallback.digest, stableDigest({ id: "k", version: 1 }));
  assert.equal(fallback.content_version, 1);
  assert.deepEqual(fallback.scope, { kind: "project", id: "p" });
  assert.equal(fallback.source_id, null);
  assert.equal(fallback.index_id, null);
  assert.equal(fallback.checkpoint_id, null);
  assert.equal(contextAssetKey(ref), "memory:m1@2");
  assert.equal(contextAssetMatches({ member: "memory", id: "m1" }, ref), true);
  assert.equal(contextAssetMatches({ member: "memory", id: "m1", version: 1 }, ref), false);
  assert.equal(contextAssetMatches({ member: "memory", id: "m1", digest: "other" }, ref), false);
  assert.equal(contextAssetMatches({ member: "memory", id: "m1", index_id: "other" }, ref), false);
  assert.equal(contextAssetMatches({ member: "memory", id: "m1", checkpoint_id: "other" }, ref), false);
});

test("common operation instrumentation classifies outcomes, nests spans, and preserves method contracts", async () => {
  for (const [error, code] of [[Object.assign(new Error("ignored"), { code: "EACCES" }), "EACCES"],
    [new Error("access denied"), "ACCESS_DENIED"], [new Error("state conflict"), "STATE_CONFLICT"], [new Error("budget exceeded"), "LIMIT_EXCEEDED"],
    [new Error("service unavailable"), "UNAVAILABLE"], [new Error("invalid input"), "INVALID_INPUT"], ["opaque", "OPERATION_FAILED"]] as const) {
    assert.equal(operationErrorCode(error), code);
  }
  assert.equal(operationErrorCode(Object.assign(new Error("SQLite failure"), { code: "ERR_SQLITE_ERROR", errcode: 5 })), "STORAGE_BUSY");
  assert.equal(operationErrorCode(new Error("database is locked")), "STORAGE_BUSY");
  assert.deepEqual([
    operationResultStatus({ denied: true }), operationResultStatus({ isError: true }), operationResultStatus({ valid: false }),
    operationResultStatus({ status: "failed" }), operationResultStatus({ partial: true }), operationResultStatus({ receipt: { partial: true } }),
    operationResultStatus({ status: "blocked" }), operationResultStatus({ codebase: { status: "unavailable" } }),
    operationResultStatus({ manifest_status: "unavailable" }), operationResultStatus({ status: "ready" }),
  ], ["denied", "failed", "failed", "failed", "partial", "partial", "blocked", "partial", "partial", "completed"]);

  const dir = await mkdtemp(join(tmpdir(), "craft-operation-sdk-"));
  const store = await new CraftStore(craftPaths(dir)).open();
  const otherDir = await mkdtemp(join(tmpdir(), "craft-operation-other-"));
  const otherStore = await new CraftStore(craftPaths(otherDir)).open();
  try {
    const events: OperationEvent[] = [];
    let currentInside = false;
    const input = { args: [{ receipt: { id: "input-receipt" } }] };
    const output = observeOperation(store, "fixture", "outer", input, () => {
      currentInside = currentOperation(store) !== undefined;
      assert.equal(currentOperation(otherStore), undefined);
      return observeOperation(store, "fixture", "inner", {}, () => ({ procedure_id: "proc", input_refs: { source: "source" } }));
    }, { traceId: "explicit-trace", observe: item => events.push(item) });
    assert.equal((output as JsonObject).procedure_id, "proc");
    assert.equal(currentInside, true);
    assert(events.some(item => item.phase === "started" && item.refs.includes("input-receipt")));
    assert(events.some(item => item.phase === "completed" && item.refs.includes("source")));
    assert(events.every(item => item.event.trace_id === "explicit-trace"));
    assert.equal(currentOperation(store), undefined);
    assert.equal(observeOperation(store, "fixture", "undefined-input", undefined, () => "ok"), "ok");

    const failures: unknown[] = [];
    assert.throws(() => observeOperation(store, "fixture", "sync-failure", {}, () => { throw new Error("budget exceeded"); }, { onError: error => failures.push(error) }), /budget exceeded/u);
    await assert.rejects(observeOperation(store, "fixture", "async-failure", {}, () => Promise.reject(new Error("denied")), { onError: error => failures.push(error) }), /denied/u);
    assert.throws(() => observeOperation(store, "fixture", "opaque-failure", {}, () => { throw "opaque failure"; }, { onError: error => failures.push(error) }), /opaque failure/u);
    const nonErrorEvents: OperationEvent[] = [];
    assert.throws(() => observeOperation(store, "fixture", "opaque-observed", {}, () => { throw "opaque failure"; }, { observe: item => nonErrorEvents.push(item) }), /opaque failure/u);
    assert(nonErrorEvents.some(item => item.phase === "failed" && item.event.attributes.reason_code === "OPERATION_FAILED"));
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    assert.equal(observeOperation(store, "fixture", "digest-failure", cyclic, () => "ok", { onError: error => failures.push(error) }), "ok");
    assert.equal(observeOperation(store, "fixture", "observe-failure", {}, () => "ok", {
      observe: () => { throw new Error("observer unavailable"); }, onError: error => failures.push(error),
    }), "ok");
    const failedDir = await mkdtemp(join(tmpdir(), "craft-operation-closed-"));
    const closedStore = await new CraftStore(craftPaths(failedDir)).open();
    closedStore.close();
    assert.equal(observeOperation(closedStore, "fixture", "sink-failure", {}, () => "ok", { onError: error => failures.push(error) }), "ok");
    await rm(failedDir, { recursive: true, force: true });
    assert(failures.length > 0);

    class Facade { value(inputValue: string) { return inputValue; } }
    const observed = new Facade();
    observeMethods(observed, store, name => name === "value" ? "fixture" : null);
    assert.equal(observed.value("preserved"), "preserved");
    const captured = new Facade();
    observeMethods(captured, store, () => "fixture", (_component, _name, args, run) => ({ original: run(), argument: args[0] }));
    assert.deepEqual(captured.value("captured"), { original: "captured", argument: "captured" });
    const kernel = observedKernel(store, "fixture", new Facade());
    assert.equal(typeof (kernel as unknown as { value: unknown }).value, "function");
    assert.equal(kernel.constructor, Facade);
    assert.equal(kernel.value("proxied"), "proxied");
  } finally { store.close(); otherStore.close(); await rm(dir, { recursive: true, force: true }); await rm(otherDir, { recursive: true, force: true }); }
});

test("required Context references and budgets reject invalid or over-budget inputs", () => {
  for (const invalid of [null, [], "ref"]) assert.throws(() => requiredContextRef(invalid), /must be an object/u);
  assert.throws(() => requiredContextRef({ member: "other", id: "x" }), /Unsupported required Context member/u);
  assert.throws(() => requiredContextRef({ member: "memory", id: " " }), /required Context id/u);
  assert.throws(() => requiredContextRef({ member: "memory", id: "x", version: 0 }), /must be positive/u);
  assert.throws(() => requiredContextRef({ member: "memory", id: "x", digest: " " }), /required Context digest/u);
  assert.deepEqual(requiredContextRef({ member: "memory", id: "x" }), { member: "memory", id: "x" });
  for (const args of [[0, 1], [1, 0], [1.2, 1], [1, Number.NaN]]) assert.throws(() => new ContextBudget(args[0]!, args[1]!), ContextBudgetError);
  const budget = new ContextBudget(2, 8);
  assert.throws(() => budget.reserve(-1, 0, false, "invalid"), ContextBudgetError);
  assert.throws(() => budget.reserve(0, Number.NaN, false, "invalid"), ContextBudgetError);
  assert.equal(budget.reserve(1, 4, false, "optional"), true);
  assert.equal(budget.reserve(2, 0, false, "optional"), false);
  assert.throws(() => budget.reserve(0, 5, true, "required over budget"), /required over budget/u);
  assert.equal(budget.items, 1);
  assert.equal(budget.chars, 4);
});

test("shared telemetry separates sink failure from successful business work and enforces content-free events", async () => {
  const failing = new CraftTelemetry({ append: () => { throw new Error("offline"); } });
  const captured = await failing.capture({ capability_id: "external", operation: "read", trace_id: "t" }, () => 42);
  assert.equal(captured.result, 42);
  assert.deepEqual(captured.telemetry.map(item => item.recorded), [false, false]);
  const base = { signal: "evaluation" as const, capability_id: "external", operation: "check", trace_id: "t", span_id: "s", parent_span_id: null, outcome: "verified" as const };
  assert.throws(() => telemetryEvent(base), /requires evidence_ids/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: { password: "secret" } }), /not allowed/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: { cost_usd: -1 } }), /non-negative/);
  assert.throws(() => telemetryEvent({ ...base, signal: "usage", outcome: "observed", evidence_ids: [] }), /requires measured/);
  assert.throws(() => telemetryEvent({ ...base, signal: "metric", outcome: "observed", attributes: { name: "hits" } }), /numeric measurement/);
  assert.throws(() => telemetryEvent({ ...base, signal: "usage", outcome: "observed", attributes: { input_tokens: 1.5 } }), /non-negative integer/);
  assert.throws(() => telemetryEvent({ ...base, signal: "other" as never }), /signal is unsupported/);
  assert.throws(() => telemetryEvent({ ...base, outcome: "other" as never }), /outcome is unsupported/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], occurred_at: "tomorrow" }), /ISO timestamp/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: Array(33).fill("e") }), /bounded array/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: null as never }), /attributes must be an object/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: { reason_code: "password=secretvalue" } }), /unsafe content/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: { extra_id: { nested: true } as never } }), /must be scalar/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], event_id: "e".repeat(257) }), /at most 256/);
  assert.equal(telemetryEvent({ ...base, evidence_ids: ["e"], parent_span_id: "parent" }).parent_span_id, "parent");
  assert.throws(() => telemetryEvent({ ...base, signal: "metric", outcome: "observed" }), /numeric measurement/);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: ["e"], attributes: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`item${i}_id`, "x"])) }), /32-field limit/);
  assert.equal(telemetryEvent({ ...base, signal: "metric", outcome: "observed", attributes: { count: 2 } }).attributes.count, 2);
  assert.equal(telemetryEvent({ ...base, evidence_ids: ["e"] }).evidence_ids[0], "e");
  const accepted = new CraftTelemetry({ append: () => {} });
  assert.equal((await accepted.record({ ...base, evidence_ids: ["e"] })).recorded, true);
  const rawSink = new CraftTelemetry({ append: () => { throw "offline"; } });
  assert.equal((await rawSink.record({ ...base, evidence_ids: ["e"] })).error?.message, "offline");
  await assert.rejects(() => failing.capture({ capability_id: "external", operation: "write", trace_id: "t" }, () => { throw new Error("business failed"); }), /business failed/);
  await assert.rejects(() => failing.capture({ capability_id: "external", operation: "write", trace_id: "t" }, () => { throw "raw failure"; }), /raw failure/);
  const capturedEvents: string[] = [];
  const recording = new CraftTelemetry({ append: event => { capturedEvents.push(event.outcome); } });
  assert.equal((await recording.capture({ capability_id: "external", operation: "write", trace_id: "t" }, () => "ok")).result, "ok");
  await assert.rejects(() => recording.capture({ capability_id: "external", operation: "write", trace_id: "t" }, () => { throw "raw failure"; }), /raw failure/);
  assert.deepEqual(capturedEvents, ["observed", "succeeded", "observed", "failed"]);
  assert.equal(operationEventId("trace", "request", "completed"), operationEventId("trace", "request", "completed"));
  assert.throws(() => operationEventId("", "request", "completed"), /trace_id/);
});

test("read-only operation context suppresses nested telemetry persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-readonly-operation-"));
  const store = await new CraftStore(craftPaths(dir)).open();
  try {
    const observed: OperationEvent[] = [];
    const result = await withoutOperationPersistence(store, async () => {
      await Promise.resolve();
      return observeOperation(store, "knowledge", "search", { query: "bounded" }, () => ({ matches: [] }));
    }, event => observed.push(event));
    assert.deepEqual(result, { matches: [] });
    assert.equal(store.count("telemetry_event"), 0);
    assert.equal(store.count("trace"), 0);
    assert.deepEqual(observed.map(item => item.phase), ["started", "completed"]);
    assert.equal(observed[0]!.event.attributes.input_digest !== undefined, true);
    assert.equal(observed[1]!.event.attributes.result_digest !== undefined, true);
    observeOperation(store, "fixture", "outer-read", {}, () => withoutOperationPersistence(store, () =>
      observeOperation(store, "fixture", "nested-read", {}, () => "ok")), { onError: () => undefined });
    assert.equal(store.count("telemetry_event"), 2, "only the explicitly observed outer operation is persisted");
    assert.equal(store.count("trace"), 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("JSONL telemetry journal serializes concurrent appends into private per-capability files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-telemetry-journal-"));
  try {
    const first = new JsonlTelemetryJournal(dir), second = new JsonlTelemetryJournal(dir);
    const event = (eventId: string, capability: string) => telemetryEvent({ event_id: eventId, signal: "trace", capability_id: capability,
      operation: "search", trace_id: "read-trace", span_id: `span-${eventId}`, parent_span_id: null, outcome: "succeeded",
      attributes: { stage: "completed", result_digest: "sha256:digest" } });
    await Promise.all([first.append(event("evt-one", "knowledge")), second.append(event("evt-two", "knowledge")),
      first.append(event("evt-three", "memory"))]);
    await Promise.all([first.flush(), second.flush()]);
    const partitions = await readdir(join(dir, "operation-journal"));
    assert.equal(partitions.length, 2);
    const records = await Promise.all(partitions.map(async partition => {
      const files = await readdir(join(dir, "operation-journal", partition));
      assert.deepEqual(files, [`${process.pid}.jsonl`]);
      const content = await readFile(join(dir, "operation-journal", partition, files[0]!), "utf8");
      assert.equal(content.endsWith("\n"), true);
      return content.trim().split("\n").map(line => JSON.parse(line) as JsonObject);
    }));
    assert.deepEqual(records.flat().map(item => item.event_id).sort(), ["evt-one", "evt-three", "evt-two"]);
    assert.equal(JSON.stringify(records).includes("private prompt"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("JSONL telemetry journal reports filesystem failures without changing the operation result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-telemetry-journal-failure-"));
  const blocker = join(dir, "not-a-directory");
  await writeFile(blocker, "file");
  let failures = 0;
  try {
    assert.throws(() => new JsonlTelemetryJournal(" "), /runtimeDir/u);
    const event = telemetryEvent({ event_id: "evt-failure", signal: "trace", capability_id: "knowledge", operation: "search",
      trace_id: "read-trace", span_id: "span", parent_span_id: null, outcome: "succeeded" });
    const defaultJournal = new JsonlTelemetryJournal(blocker);
    await assert.rejects(defaultJournal.append(event));
    const journal = new JsonlTelemetryJournal(blocker, () => { failures += 1; throw new Error("reporting failed"); });
    const append = journal.append(event);
    const flushing = journal.flush();
    await assert.rejects(append);
    await flushing;
    assert.equal(failures, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("local telemetry sink is idempotent and queryable by trace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-common-log-"));
  const store = await new CraftStore(craftPaths(dir)).open();
  try {
    const sink = new StoreTelemetrySink(store);
    const event = telemetryEvent({ event_id: "evt", signal: "usage", capability_id: "external", operation: "model", trace_id: "t", span_id: "s", parent_span_id: null, outcome: "observed", attributes: { input_tokens: 4, output_tokens: 5, cost_usd: 0.01 } });
    sink.append(event); sink.append(event);
    assert.equal(sink.list("t").length, 1);
    assert.equal(sink.list("other").length, 0);
    assert.throws(() => sink.append({ ...event, operation: "other" }), /idempotency conflict/);
    assert.throws(() => sink.list("t", 1001), /query bounds/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("two calls can join one Trace and telemetry failure cannot reverse business success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-shared-trace-"));
  const store = await new CraftStore(craftPaths(dir)).open();
  try {
    const kernel = new ComponentTraceKernel(new TraceKernel(store), "session");
    for (const requestId of ["one", "two"]) {
      const response = await kernel.capture({ requestId, component: "external", operation: "read", input: { trace_id: "joined" }, handler: () => ({ ok: true }) });
      assert.equal(response.ok, true);
    }
    assert.equal(store.list("trace_event", 20, item => item.trace_id === "joined").length, 4);
    const original = kernel.trace.append.bind(kernel.trace);
    kernel.trace.append = (() => { throw new Error("telemetry unavailable"); }) as typeof kernel.trace.append;
    const business = await kernel.capture({ requestId: "three", component: "external", operation: "read", input: { trace_id: "joined" }, handler: () => ({ value: 7 }) });
    assert.equal(business.ok, true);
    assert.equal(business.result?.value, 7);
    assert.equal(business.telemetry_error, "Error");
    kernel.trace.append = original;
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("OTLP preserves parent links and timestamps and rejects partial receiver acceptance", async () => {
  const input = { trace_id: "t", created_at: "2026-10-04T00:00:00.000Z" };
  const events = [
    { trace_id: "t", span_id: "parent", sequence: 1, event_kind: "run", created_at: "2026-10-04T00:00:00.000Z" },
    { trace_id: "t", span_id: "child", parent_span_id: "parent", sequence: 2, event_kind: "tool.call", created_at: "2026-10-04T00:00:01.000Z", duration_ms: 4 },
  ];
  const payload = toOtlpTrace(input, events);
  const spans = ((payload.resourceSpans as Record<string, unknown>[])[0]!.scopeSpans as Record<string, unknown>[])[0]!.spans as Record<string, unknown>[];
  assert.equal(spans[1]!.parentSpanId, spans[0]!.spanId);
  assert.equal(BigInt(String(spans[1]!.endTimeUnixNano)) - BigInt(String(spans[1]!.startTimeUnixNano)), 4_000_000n);
  await assert.rejects(() => exportOtlp("https://otel.example/v1/traces", payload, async () => ({ status: 200, body: '{"partialSuccess":{"rejectedSpans":1}}' })), /partial success/);
  await assert.rejects(() => exportOtlp("https://otel.example/v1/traces", payload, async () => ({ status: 200, body: '{"partialSuccess":{"rejectedSpans":-1}}' })), /invalid/);
  assert.equal((await exportOtlp("https://otel.example/v1/traces", payload, async () => ({ status: 200, body: '{"partialSuccess":{"rejectedSpans":0}}' }))).accepted, true);
  assert.throws(() => toOtlpTrace(input, [...events, { trace_id: "other", event_kind: "run" }]), /one trace/);
  assert.throws(() => toOtlpTrace(input, [{ trace_id: "t", event_kind: "run", created_at: "bad" }]), /timestamp/);
  assert.throws(() => toOtlpTrace(input, [{ trace_id: "t", event_kind: "run", duration_ms: -1 }]), /duration_ms/);
  const external = toOtlpTrace({ trace_id: "0123456789abcdef0123456789abcdef" }, [{ trace_id: "0123456789abcdef0123456789abcdef", span_id: "child", parent_span_id: "fedcba9876543210", event_kind: "tool.call", status: "failed" }]);
  const externalSpan = (((external.resourceSpans as Record<string, unknown>[])[0]!.scopeSpans as Record<string, unknown>[])[0]!.spans as Record<string, unknown>[])[0]!;
  assert.equal(externalSpan.parentSpanId, "fedcba9876543210");
  assert.equal((externalSpan.status as Record<string, unknown>).code, 2);
  assert.equal(externalSpan.traceId, "0123456789abcdef0123456789abcdef");
  const grouped = toOtlpTrace({ trace_id: "grouped", created_at: "2026-10-04T00:00:00.000Z" }, [
    { trace_id: "grouped", span_id: "same", event_kind: "run", occurred_at: "2026-10-04T00:00:02.000Z", duration_ms: 1 },
    { trace_id: "grouped", span_id: "same", event_kind: "run", occurred_at: "2026-10-04T00:00:01.000Z", duration_ms: 1 },
  ]);
  const groupedSpan = (((grouped.resourceSpans as Record<string, unknown>[])[0]!.scopeSpans as Record<string, unknown>[])[0]!.spans as Record<string, unknown>[])[0]!;
  assert.equal(groupedSpan.startTimeUnixNano, "1791072001000000000");
  const completed = toOtlpTrace({ trace_id: "done", status: "completed" });
  const completedSpan = (((completed.resourceSpans as Record<string, unknown>[])[0]!.scopeSpans as Record<string, unknown>[])[0]!.spans as Record<string, unknown>[])[0]!;
  assert.equal((completedSpan.status as Record<string, unknown>).code, 1);
  assert.throws(() => toOtlpTrace(null as never), /must be an object/);
  await assert.rejects(() => exportOtlp("bad-url", payload, async () => ({ status: 200, body: "{}" })), /valid HTTP/);
  assert.equal((await exportOtlp("https://otel.example/v1/traces", payload, async () => ({ status: 200, body: '{"partialSuccess":{}}' }))).accepted, true);
});

test("evaluation stage reports remain untrusted without an eligible, bound assessment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-eval-gate-"));
  const store = await new CraftStore(craftPaths(dir)).open();
  try {
    const kernel = new EvaluationContractKernel(store);
    const id = String((kernel.define({ capability_id: "external", capability_version: 1, input_contract: "in", output_contract: "out" }).contract as Record<string, unknown>).id);
    kernel.record({ contract_id: id, stage: "mechanism_passed", evidence: ["claim"] });
    assert.equal(kernel.get(id).routeable, false);
    store.create("verification_plan", "plan", { change_ref: `${id}:mechanism_passed`, requires_real_host: false, candidate_change: true });
    store.create("verification_assessment", "assessment", { verification_id: "plan", verdict: "eligible" });
    const verified = kernel.record({ contract_id: id, stage: "mechanism_passed", evidence: ["assessment"] });
    assert.equal(verified.verified_stage, "mechanism_passed");
    kernel.record({ contract_id: id, stage: "fixture_passed", evidence: ["claim"] });
    assert.equal(kernel.get(id).routeable, false);
    store.create("verification_plan", "late-fixture-plan", { change_ref: `${id}:fixture_passed`, requires_real_host: false, candidate_change: true });
    store.create("verification_assessment", "late-fixture-assessment", { verification_id: "late-fixture-plan", verdict: "eligible" });
    kernel.record({ contract_id: id, stage: "conformance_passed", evidence: ["claim"] });
    assert.throws(() => kernel.record({ contract_id: id, stage: "fixture_passed", evidence: ["claim"] }), /cannot move backwards/);
    const late = kernel.record({ contract_id: id, stage: "fixture_passed", evidence: ["late-fixture-assessment"] });
    assert.equal(late.reported_stage, "conformance_passed");
    assert.equal(late.verified_stage, "fixture_passed");
    assert.equal((late.stage_history as Array<{ stage: string; verification: string }>)[1]?.verification, "trusted");
    assert.equal(kernel.record({ contract_id: id, stage: "conformance_passed", evidence: ["claim"] }).verified_stage, "fixture_passed");
    store.create("verification_plan", "late-conformance-plan", { change_ref: `${id}:conformance_passed`, requires_real_host: false, candidate_change: true });
    store.create("verification_assessment", "late-conformance-assessment", { verification_id: "late-conformance-plan", verdict: "eligible" });
    assert.equal(kernel.record({ contract_id: id, stage: "conformance_passed", evidence: ["late-conformance-assessment"] }).verified_stage, "conformance_passed");
    const trustedId = String((kernel.define({ capability_id: "trusted", capability_version: 1, input_contract: "in", output_contract: "out" }).contract as Record<string, unknown>).id);
    for (const stage of ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified", "business_eligible", "routeable"] as const) {
      store.create("verification_plan", `plan-${stage}`, { change_ref: `${trustedId}:${stage}`, requires_real_host: true, candidate_change: true });
      store.create("verification_assessment", `assessment-${stage}`, { verification_id: `plan-${stage}`, verdict: "eligible" });
      kernel.record({ contract_id: trustedId, stage, evidence: [`assessment-${stage}`] });
    }
    assert.equal(kernel.get(trustedId).routeable, true);
    const negativeId = String((kernel.define({ capability_id: "negative", capability_version: 1, input_contract: "in", output_contract: "out" }).contract as Record<string, unknown>).id);
    store.create("verification_assessment", "missing-plan", { verification_id: "unknown", verdict: "eligible" });
    kernel.record({ contract_id: negativeId, stage: "mechanism_passed", evidence: ["missing-plan"] });
    store.create("verification_plan", "wrong-plan", { change_ref: "other:mechanism_passed", requires_real_host: true, candidate_change: true });
    store.create("verification_assessment", "wrong-assessment", { verification_id: "wrong-plan", verdict: "eligible" });
    kernel.record({ contract_id: negativeId, stage: "mechanism_passed", evidence: ["wrong-assessment"] });
    for (const stage of ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified", "business_eligible", "routeable"] as const) {
      store.create("verification_plan", `negative-plan-${stage}`, { change_ref: `${negativeId}:${stage}`, requires_real_host: stage !== "host_verified", candidate_change: stage !== "routeable" });
      store.create("verification_assessment", `negative-assessment-${stage}`, { verification_id: `negative-plan-${stage}`, verdict: "eligible" });
      kernel.record({ contract_id: negativeId, stage, evidence: [`negative-assessment-${stage}`] });
    }
    assert.equal(kernel.get(negativeId).routeable, false);
    store.create("evaluation_contract", "legacy", { status: "mechanism_passed", stage_history: [] });
    assert.equal(kernel.record({ contract_id: "legacy", stage: "fixture_passed", evidence: ["claim"] }).reported_stage, "fixture_passed");
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("third-party telemetry runs from packages without a Store or capability registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-telemetry-consumer-"));
  try {
    const nodeModules = join(dir, "node_modules");
    for (const name of ["craft-common-store-local", "craft-common-base", "craft-common-log"]) {
      const source = join(root, "common", name); const target = join(nodeModules, name);
      await mkdir(target, { recursive: true });
      await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
      await cp(join(source, "package.json"), join(target, "package.json"));
    }
    const source = `
      import { CraftTelemetry } from 'craft-common-log';
      const events = [];
      const telemetry = new CraftTelemetry({ append: event => events.push(event) });
      const receipt = await telemetry.capture({ capability_id: 'third-party', operation: 'read', trace_id: 'outside' }, () => 7);
      if (receipt.result !== 7 || events.length !== 2 || events[0].capability_id !== 'third-party') throw new Error('telemetry failed');
      console.log('telemetry-only-ok');
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /telemetry-only-ok/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("each capability package loads and registers outside the harness checkout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-isolated-package-"));
  try {
    const nodeModules = join(dir, "node_modules");
    await mkdir(nodeModules, { recursive: true });
    for (const name of ["craft-common-store-local", "craft-common-base", "craft-common-log"]) {
      const source = join(root, "common", name); const target = join(nodeModules, name);
      await mkdir(target, { recursive: true });
      await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
      await cp(join(source, "package.json"), join(target, "package.json"));
    }
    for (const name of ["knowledge", "memory", "experience", "codebase"]) {
      const source = join(root, "capability", `craft-${name}`); const target = join(nodeModules, "@craft", `capability-${name}`);
      await mkdir(target, { recursive: true });
      await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
      await cp(join(source, "package.json"), join(target, "package.json"));
      const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as Record<string, unknown>;
      assert.equal(manifest.peerDependencies, undefined);
      assert.equal((manifest.dependencies as Record<string, unknown>)["craft-agent-harness"], undefined);
    }
    await symlink(realpathSync(join(root, "node_modules", "typescript")), join(nodeModules, "typescript"), "dir");
    const source = `
      import { CraftStore, craftPaths } from 'craft-common-store-local';
      import { CraftTelemetry, StoreTelemetrySink } from 'craft-common-log';
      import { buildCapabilityRegistry, CORE_KERNELS, stableDigest } from 'craft-common-base';
      import { knowledgeCapability } from '@craft/capability-knowledge';
      import { memoryCapability } from '@craft/capability-memory';
      import { experienceCapability } from '@craft/capability-experience';
      import { ExperienceGraphAssets } from '@craft/capability-experience/graph-assets';
      import { codebaseCapability } from '@craft/capability-codebase';
      const store = await new CraftStore(craftPaths(process.env.CRAFT_TEST_DATA_DIR)).open();
      try {
        store.create('scope_alias', 'sdk-project', { scope: { kind: 'project', id: 'project:sdk' }, alias_kind: 'path', alias: process.cwd(), alias_digest: stableDigest(process.cwd()), status: 'active' });
        store.create('external', 'record', { value: 1 });
        for (const capability of [knowledgeCapability, memoryCapability, experienceCapability, codebaseCapability]) {
          buildCapabilityRegistry([capability], { [CORE_KERNELS.store]: store, [CORE_KERNELS.modelProviders]: [], [CORE_KERNELS.telemetry]: new CraftTelemetry(new StoreTelemetrySink(store)) });
        }
        if (store.get('external', 'record').value !== 1) throw new Error('store round trip failed');
        const graphs = new ExperienceGraphAssets(store);
        const template = graphs.inspect({ action: 'template' });
        const draft = graphs.edit({ action: 'save', graph_id: 'sdk-scene', scope: 'project:sdk', configuration: template.configuration });
        const submitted = graphs.edit({ action: 'submit', graph_id: 'sdk-scene', scope: 'project:sdk', expected_draft_digest: draft.draft_digest });
        if (submitted.procedure.content_version !== 1 || submitted.procedure.routeable) throw new Error('isolated graph authoring failed');
        console.log('isolated-capabilities-ok');
      } finally { store.close(); }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: dir, env: { ...process.env, CRAFT_TEST_DATA_DIR: join(dir, "data") }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /isolated-capabilities-ok/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("published tarball contents typecheck and run outside the monorepo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "craft-tarball-consumer-"));
  try {
    const nodeModules = join(dir, "node_modules");
    await mkdir(nodeModules, { recursive: true });
    for (const relative of ["common/craft-common-store-local", "common/craft-common-base", "common/craft-common-log",
      "capability/craft-knowledge", "capability/craft-memory", "capability/craft-experience", "capability/craft-codebase"]) {
      const sourceDir = join(root, relative);
      const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      const npmCommand = process.platform === "win32" ? process.execPath : "npm";
      const npmPrefix = process.platform === "win32" ? [npmCli] : [];
      if (process.platform === "win32") assert.ok(existsSync(npmCli), "Node distribution must include the npm CLI");
      const packed = spawnSync(npmCommand, [...npmPrefix, "pack", `./${relative}`, "--offline", "--ignore-scripts", "--pack-destination", dir, "--json"], {
        cwd: root, env: { ...process.env, NPM_CONFIG_CACHE: join(dir, "npm-cache") }, encoding: "utf8",
      });
      assert.equal(packed.status, 0, packed.stderr);
      const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      const manifest = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8")) as { name: string };
      const target = join(nodeModules, manifest.name);
      await mkdir(target, { recursive: true });
      const extracted = spawnSync("tar", ["-xzf", join(dir, filename), "--strip-components=1", "-C", target], { encoding: "utf8" });
      assert.equal(extracted.status, 0, extracted.stderr);
    }
    await symlink(realpathSync(join(root, "node_modules", "typescript")), join(nodeModules, "typescript"), "dir");
    await symlink(realpathSync(join(root, "node_modules", "@types")), join(nodeModules, "@types"), "dir");
    const source = `
      import { CraftStore, craftPaths } from 'craft-common-store-local';
      import { CraftTelemetry } from 'craft-common-log';
      import { buildCapabilityRegistry, CORE_KERNELS, stableDigest } from 'craft-common-base';
      import { KeywordRetrievalPort } from 'craft-common-base/keyword-retrieval';
      import { temporalMemorySelect } from 'craft-common-base/memory-temporal-policy';
      import { OpenAiCompatibleEmbeddingRetrievalPort } from 'craft-common-base/embedding-retrieval';
      import { knowledgeCapability } from '@craft/capability-knowledge';
      import { memoryCapability } from '@craft/capability-memory';
      import { experienceCapability } from '@craft/capability-experience';
      import { ExperienceGraphAssets } from '@craft/capability-experience/graph-assets';
      import { codebaseCapability } from '@craft/capability-codebase';
      const store = await new CraftStore(craftPaths('./data')).open();
      try {
        store.create('scope_alias', 'sdk-project', { scope: { kind: 'project', id: 'project:sdk' }, alias_kind: 'path', alias: process.cwd(), alias_digest: stableDigest(process.cwd()), status: 'active' });
        const keyword = await new KeywordRetrievalPort().search('alpha', [{ id: 'a', body: 'alpha' }]);
        if (keyword.hits[0]?.id !== 'a') throw new Error('focused keyword export failed');
        if (temporalMemorySelect([], new Date(), false).selected.length) throw new Error('focused temporal export failed');
        if ((await new OpenAiCompatibleEmbeddingRetrievalPort({}).search('alpha', [])).execution.unavailable_reason !== 'embedding_provider_unavailable') throw new Error('focused provider export failed');
        const events = [];
        const telemetry = new CraftTelemetry({ append: event => { events.push(event); } });
        for (const capability of [knowledgeCapability, memoryCapability, experienceCapability, codebaseCapability]) {
          buildCapabilityRegistry([capability], { [CORE_KERNELS.store]: store, [CORE_KERNELS.modelProviders]: [], [CORE_KERNELS.telemetry]: telemetry });
        }
        await telemetry.record({ signal: 'log', capability_id: 'third-party', operation: 'read', trace_id: 'tarball', span_id: 'span', parent_span_id: null, outcome: 'succeeded' });
        if (events.length !== 1) throw new Error('tarball telemetry failed');
        const graphs = new ExperienceGraphAssets(store);
        const template = graphs.inspect({ action: 'template' });
        const draft = graphs.edit({ action: 'save', graph_id: 'tarball-graph', scope: 'project:sdk', configuration: template.configuration });
        graphs.edit({ action: 'submit', graph_id: 'tarball-graph', scope: 'project:sdk', expected_draft_digest: draft.draft_digest });
        console.log('tarball-consumer-ok');
      } finally { store.close(); }
    `;
    await writeFile(join(dir, "consumer.mjs"), source);
    await writeFile(join(dir, "consumer.mts"), "import type { RetrievalPort } from 'craft-common-base/retrieval-contract';\n" + source + "\nconst checkedPort: RetrievalPort = new KeywordRetrievalPort(); void checkedPort;\n");
    const typecheck = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2024", "--types", "node", "consumer.mts"], { cwd: dir, encoding: "utf8" });
    assert.equal(typecheck.status, 0, typecheck.stdout + typecheck.stderr);
    const runtime = spawnSync(process.execPath, ["consumer.mjs"], { cwd: dir, encoding: "utf8" });
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.match(runtime.stdout, /tarball-consumer-ok/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
