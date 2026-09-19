import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import test from "node:test";
import { McpServer, CORE_TOOLS } from "../src/mcp.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { TRACE_SCHEMA_VERSION, TraceKernel } from "../src/trace-kernel.ts";
import { MaintenanceKernel } from "../src/maintenance.ts";

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
    f.service.traceStart({ trace_id: "invalid-final", task_id: "task" });
    assert.throws(() => f.service.traceFinalize({ trace_id: "invalid-final", status: "running", summary: "bad" }), /unsupported/);
    const details = f.service.traceGet({ trace_id: "trace" }); assert.equal((details.events as JsonObject[]).length, 4); assert.equal((details.feedback as JsonObject[]).length, 1);
    assert.equal((f.service.traceQuery({ trace_id: "trace", event_kind: "state.observed" }).events as JsonObject[]).length, 1);
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
    assert.equal(VERSION, "0.12.33");
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
    const kernel = new TraceKernel(f.store); assert.equal((kernel.query({ trace_id: "trial:trial" }).count), 3);
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
    const archived = f.service.traceGet({ trace_id: "old" });
    assert.equal(archived.archived, true); assert.equal((archived.trace as JsonObject).status, "completed"); assert.equal((archived.events as JsonObject[]).length, 3);
    assert.equal((f.service.traceQuery({ trace_id: "old" }).events as JsonObject[]).every((event) => event.archived === true), true);
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
