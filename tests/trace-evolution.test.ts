import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import test from "node:test";
import { McpServer, CORE_TOOLS } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { TRACE_SCHEMA_VERSION, TraceKernel } from "../src/trace-kernel.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-evolution-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  store.create("task", "task", { title: "Trace task", goal: "verify" });
  return { root, store, service: new CraftService(store) };
}

test("Trace Kernel provides canonical append, observation, feedback and terminal closure", async () => {
  const f = await fixture();
  try {
    const start = f.service.traceStart({ trace_id: "trace", task_id: "task", trial_id: "trial", model_fingerprint: "model:v1", environment_fingerprint: "env:v1", capability_fingerprint: "cap:v1", policy_fingerprint: "policy:v1", metadata: { source: "test" } });
    assert.equal((start.trace as JsonObject).schema, TRACE_SCHEMA_VERSION);
    assert.equal(f.service.traceStart({ trace_id: "trace", task_id: "task", trial_id: "trial", model_fingerprint: "model:v1", environment_fingerprint: "env:v1", capability_fingerprint: "cap:v1", policy_fingerprint: "policy:v1", metadata: { source: "test" } }).idempotent, true);
    assert.throws(() => f.service.traceStart({ trace_id: "trace", task_id: "other" }), /idempotency conflict/);
    const eventInput = { trace_id: "trace", event_id: "event-1", event_kind: "action.started", actor: "model", source: "codex", trust: "untrusted", data: { action: "inspect" }, action_contract: { effect: "read_only" }, state_before: { digest: "before" }, state_after: { digest: "after" }, input_refs: ["input-1"], output_refs: ["output-1"], capability_revision: "cap:v1", policy_revision: "policy:v1", model_fingerprint: "model:v1", environment_fingerprint: "env:v1", workspace_before: "snap-before", workspace_after: "snap-after", usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: 0.01, duration_ms: 20, summary: "inspect" };
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
    const details = f.service.traceGet({ trace_id: "trace" }); assert.equal((details.events as JsonObject[]).length, 4); assert.equal((details.feedback as JsonObject[]).length, 1);
    assert.equal((f.service.traceQuery({ trace_id: "trace", event_kind: "state.observed" }).events as JsonObject[]).length, 1);
    assert.equal((f.service.traceQuery({ task_id: "task", limit: 1 }).events as JsonObject[]).length, 1);
    assert.equal((f.service.traceReplayBundle({ trace_id: "trace" }).replayable), false);
    assert.equal((f.service.traceCaseCompile({ trace_id: "trace", case_id: "case", summary: "sanitized trace case" }).case as JsonObject).sanitized, true);
    assert.equal(f.service.traceCaseCompile({ trace_id: "trace", case_id: "case", summary: "sanitized trace case" }).idempotent, true);
    assert.throws(() => f.service.traceCaseCompile({ trace_id: "trace", case_id: "held", partition: "held_out", summary: "held" }), /approved_by/);
    assert.throws(() => f.service.traceCaseCompile({ trace_id: "trace", case_id: "bad", partition: "unknown", summary: "bad" }), /unsupported/);
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
    assert.equal(VERSION, "0.12.26");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("legacy Trial Trace is projected into the canonical Trace and MCP surfaces expose it", async () => {
  const f = await fixture();
  try {
    f.store.create("trial", "trial", { task_id: "task", subject_type: "workflow", subject_id: "subject", subject_version: 1 });
    const appended = f.service.trialTraceAppend({ trial_id: "trial", event_type: "workflow.started", source: "program_verified", data: { phase: "start" } }); assert.equal(appended.sequence, 1);
    assert.equal((f.service.traceGet({ trace_id: "trial:trial" }).events as JsonObject[]).length, 1);
    f.service.outcomeRecord({ trial_id: "trial", verdict: "passed", summary: "done", scores: {}, costs: {}, evidence_ids: [], source: "program_verified" });
    assert.equal((f.service.traceGet({ trace_id: "trial:trial" }).events as JsonObject[]).length, 2);
    const mcp = new McpServer(f.service, "full");
    for (const [name, args] of [["craft_trace_get", { trace_id: "trial:trial" }], ["craft_trace_query", { trace_id: "trial:trial" }], ["craft_trace_replay_bundle", { trace_id: "trial:trial" }]] as [string, JsonObject][]) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } }); assert.equal((response?.result as JsonObject).isError, false);
    }
    const calls: [string, JsonObject][] = [
      ["craft_trace_start", { trace_id: "mcp-trace", task_id: "task" }],
      ["craft_trace_append", { trace_id: "mcp-trace", event_kind: "action", data: {}, action_contract: { effect: "read_only" } }],
      ["craft_trace_observe", { trace_id: "mcp-trace", state_before: {}, state_after: {}, summary: "observed" }],
      ["craft_trace_feedback", { trace_id: "mcp-trace", signal: "accepted", summary: "accepted" }],
      ["craft_trace_finalize", { trace_id: "mcp-trace", status: "completed", summary: "complete" }],
      ["craft_trace_get", { trace_id: "mcp-trace" }],
      ["craft_trace_query", { trace_id: "mcp-trace" }],
      ["craft_trace_replay_bundle", { trace_id: "mcp-trace" }],
      ["craft_trace_case_compile", { trace_id: "mcp-trace", summary: "case" }],
      ["craft_trace_retention_plan", { policy_id: "mcp-policy", max_days: 10, max_events: 20 }],
      ["craft_trace_retention_sweep", { now: "2030-01-01T00:00:00.000Z", max_days: 7 }],
    ];
    for (const [name, args] of calls) { const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } }); assert.equal((response?.result as JsonObject).isError, false); }
    assert.ok(CORE_TOOLS.some((tool) => tool.name === "craft_trace_get"));
    assert.ok(mcp.tools.some((tool) => tool.name === "craft_trace_case_compile"));
    const kernel = new TraceKernel(f.store); assert.equal((kernel.query({ trace_id: "trial:trial" }).count), 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Trace retention archives terminal records for seven days and preserves active work", async () => {
  const f = await fixture();
  try {
    f.service.traceStart({ trace_id: "old", task_id: "task" });
    f.service.traceAppend({ trace_id: "old", event_kind: "action", data: {}, action_contract: { effect: "read_only" } });
    f.service.traceFeedback({ trace_id: "old", signal: "corrected", summary: "reviewed" });
    f.service.traceFinalize({ trace_id: "old", status: "completed", summary: "done" });
    const old = new Date("2020-01-01T00:00:00.000Z").toISOString();
    const record = f.store.get("trace", "old");
    f.store.save("trace", "old", { ...record, last_event_at: old, updated_at: old });
    f.service.traceStart({ trace_id: "active", task_id: "task" });
    const result = f.service.traceRetentionSweep({ now: "2030-01-01T00:00:00.000Z" });
    assert.equal(result.archived, 1); assert.equal(result.deleted, 1); assert.equal(result.max_days, 7);
    assert.throws(() => f.store.get("trace", "old"), /Unknown trace/);
    assert.equal(f.store.events("trace:old").length, 0);
    assert.equal(f.store.get("trace", "active").status, "running");
    const archiveDir = join(f.store.paths.logsDir, "trace-archive");
    assert.equal(existsSync(archiveDir), true); assert.equal(readdirSync(archiveDir).length, 1);
    assert.equal(f.service.traceRetentionSweep({ now: "2030-01-01T00:00:00.000Z" }).deleted, 0);
    assert.throws(() => f.service.traceRetentionSweep({ now: "invalid" }), /ISO timestamp/);
    assert.throws(() => f.service.traceRetentionSweep({ max_days: 0 }), /positive integer/);
    assert.throws(() => f.service.traceRetentionSweep({ limit: 0 }), /between 1 and 10000/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
