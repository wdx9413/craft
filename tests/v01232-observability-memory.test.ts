import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComponentTraceKernel } from "../src/component-trace.ts";
import { MaintenanceKernel } from "../src/maintenance.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { McpServer } from "../src/mcp.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { TraceKernel } from "../src/trace-kernel.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v01232-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: new CraftService(store) };
}

test("MCP component calls produce correlated terminal Traces without storing input", async () => {
  const f = await fixture();
  try {
    const server = new McpServer(f.service, "full");
    const info = await server.handle({ id: "info", method: "tools/call", params: { name: "craft_info", arguments: {} } });
    assert.equal((info?.result as JsonObject).isError, false);
    assert.equal((info?.result as JsonObject).structuredContent as JsonObject &&
      Object.hasOwn((info?.result as JsonObject).structuredContent as JsonObject, "trace_correlation"), false);
    const listed = await server.handle({ id: "source", method: "tools/call", params: { name: "craft_source_list", arguments: { secret_value: "not persisted" } } });
    const listedResult = listed?.result as JsonObject;
    assert.equal(listedResult.isError, false);
    const correlation = (listedResult.structuredContent as JsonObject).trace_correlation as JsonObject;
    assert.equal(correlation.auto_finalized, true);
    const trace = f.service.traceGet({ trace_id: correlation.trace_id });
    assert.equal((trace.trace as JsonObject).status, "completed");
    assert.deepEqual((trace.events as JsonObject[]).map((event) => event.event_kind), ["component.call.started", "component.call.completed", "trace.finalized"]);
    assert.equal(JSON.stringify(trace).includes("not persisted"), false);

    f.store.create("task", "parent-task", { title: "parent", goal: "observe" });
    f.service.traceStart({ trace_id: "parent-trace", task_id: "parent-task" });
    const joined = await server.handle({ id: "joined", method: "tools/call", params: { name: "craft_source_list", arguments: { trace_id: "parent-trace", task_id: "parent-task" } } });
    const joinedCorrelation = ((joined?.result as JsonObject).structuredContent as JsonObject).trace_correlation as JsonObject;
    assert.equal(joinedCorrelation.auto_finalized, false);
    assert.equal((f.service.traceGet({ trace_id: "parent-trace" }).trace as JsonObject).status, "running");
    f.service.traceFinalize({ trace_id: "parent-trace", status: "completed", summary: "parent complete" });

    const correlationAlias = await server.handle({ id: "alias", method: "tools/call", params: { name: "craft_source_list", arguments: { correlation_trace_id: "parent-alias", task_id: "parent-task" } } });
    assert.equal(((correlationAlias?.result as JsonObject).structuredContent as JsonObject).trace_correlation &&
      (((correlationAlias?.result as JsonObject).structuredContent as JsonObject).trace_correlation as JsonObject).trace_id, "parent-alias");

    server.handlers.craft_null_result = () => null as never;
    const nullResult = await server.handle({ id: "null", method: "tools/call", params: { name: "craft_null_result", arguments: {} } });
    assert.equal((nullResult?.result as JsonObject).isError, false);

    server.handlers.craft_undefined_result = () => undefined as never;
    const undefinedResult = await server.handle({ id: "undefined", method: "tools/call", params: { name: "craft_undefined_result", arguments: {} } });
    assert.equal((undefinedResult?.result as JsonObject).isError, true);

    server.tools.push({ name: "craft_missing_handler" } as never);
    const missingHandler = await server.handle({ id: "missing-handler", method: "tools/call", params: { name: "craft_missing_handler", arguments: {} } });
    assert.equal((missingHandler?.result as JsonObject).isError, true);

    const originalInfo = server.handlers.craft_info;
    server.handlers.craft_info = () => { throw "raw introspection failure"; };
    const rawFailure = await server.handle({ id: "raw", method: "tools/call", params: { name: "craft_info", arguments: {} } });
    assert.match(String(((rawFailure?.result as JsonObject).content as JsonObject[])[0].text), /raw introspection failure/);
    server.handlers.craft_info = () => { throw new Error("error introspection failure"); };
    const errorFailure = await server.handle({ id: "error", method: "tools/call", params: { name: "craft_info", arguments: {} } });
    assert.match(String(((errorFailure?.result as JsonObject).content as JsonObject[])[0].text), /error introspection failure/);
    server.handlers.craft_info = originalInfo;

    f.store.create("evidence", "observer-evidence", { confidence: "confirmed" });
    f.service.traceStart({ trace_id: "observer-mcp-trace", task_id: "parent-task", environment_fingerprint: "env" });
    const observed = await server.handle({ id: "observer", method: "tools/call", params: { name: "craft_outcome_observer_observe", arguments: {
      observation_id: "observer-mcp", trace_id: "observer-mcp-trace", host_id: "host", observer_id: "independent-checker",
      observer_kind: "program", environment_fingerprint: "env", verdict: "passed", state_snapshot_ref: "state", evidence_ids: ["observer-evidence"],
    } } });
    assert.equal((observed?.result as JsonObject).isError, false);

    const bad = await server.handle({ id: "bad-policy", method: "tools/call", params: { name: "craft_memory_policy_save", arguments: { mode: "invalid" } } });
    assert.equal((bad?.result as JsonObject).isError, true);
    const failedCorrelation = (bad?.result as JsonObject).trace_correlation as JsonObject;
    assert.equal((f.service.traceGet({ trace_id: failedCorrelation.trace_id }).trace as JsonObject).status, "failed");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("memory capture modes are explicit and Evidence-gated", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    const source = f.service.knowledgeSourceRegister({ source_id: "source", kind: "custom", label: "test", scope_kind: "project", scope_id: "p", locator: "memory://test", content_digest: "sha256:source", trust: "bounded", access: "proposal_only" }).source as JsonObject;
    assert.equal((f.service.memoryPolicyGet().policy as JsonObject).mode, "propose");
    f.service.memoryPolicySave({ mode: "propose" });
    assert.equal(f.service.memoryPolicySave({ mode: "propose", updated_by: "test" }).idempotent, true);
    assert.equal(f.service.memoryPolicySave({ mode: "governed", updated_by: "test" }).idempotent, false);
    f.store.create("memory_policy", "legacy-policy", { mode: "propose", min_confidence: "confirmed", auto_commit: false, identity_digest: "sha256:legacy" });
    assert.equal((f.service.memoryPolicySave({ policy_id: "legacy-policy", mode: "governed", updated_by: "test" }).policy as JsonObject).policy_revision, 2);
    f.service.memoryPolicySave({ mode: "off", updated_by: "test" });
    const disabled = f.service.memoryCandidatePropose({ candidate_id: "disabled", source_id: source.id, kind: "preference", scope_kind: "project", scope_id: "p", content: "do not write" });
    assert.equal(disabled.status, "disabled");
    assert.equal(f.store.find("memory_candidate", "disabled"), null);
    const bounded = f.service.evidenceRecord({ evidence_id: "bounded", source_type: "test", claim: "bounded", confidence: "bounded" });
    f.service.memoryPolicySave({ mode: "governed", min_confidence: "bounded", updated_by: "test" });
    const committed = f.service.memoryCandidatePropose({ candidate_id: "committed", source_id: source.id, kind: "preference", scope_kind: "project", scope_id: "p", topic: "editor", content: "use markdown", evidence_ids: [bounded.id] });
    assert.equal(committed.auto_committed, true);
    assert.equal((committed.memory as JsonObject).status, "active");
    const strict = f.service.evidenceRecord({ evidence_id: "strict-bounded", source_type: "test", claim: "not confirmed", confidence: "bounded" });
    f.service.memoryPolicySave({ mode: "governed", min_confidence: "confirmed", updated_by: "test" });
    const held = f.service.memoryCandidatePropose({ candidate_id: "held", source_id: source.id, kind: "preference", scope_kind: "project", scope_id: "p", topic: "format", content: "use plain text", evidence_ids: [strict.id] });
    assert.equal(held.auto_committed, false);
    assert.equal((held.candidate as JsonObject).status, "candidate");
    assert.throws(() => f.service.memoryPolicySave({ mode: "unknown" }), /unsupported/);
    assert.throws(() => f.service.memoryPolicySave({ mode: "governed", min_confidence: "unverified" }), /confirmed or bounded/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Maintenance expires existing Knowledge and Memory records", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    const source = f.service.knowledgeSourceRegister({ source_id: "source", kind: "custom", label: "test", scope_kind: "project", scope_id: "p", locator: "memory://test", content_digest: "sha256:source", trust: "bounded", access: "proposal_only" }).source as JsonObject;
    const evidence = f.service.evidenceRecord({ evidence_id: "ev", source_type: "test", claim: "checked", confidence: "bounded" });
    const claim = f.service.knowledgeClaimSave({ claim_id: "claim", kind: "fact", content: "temporary", evidence_ids: [evidence.id], valid_until: "2020-01-01T00:00:00.000Z" }).claim as JsonObject;
    f.service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "test", reason: "checked" });
    f.service.memoryCandidatePropose({ candidate_id: "memory", source_id: source.id, kind: "working", scope_kind: "project", scope_id: "p", content: "temporary", valid_until: "2020-01-01T00:00:00.000Z" });
    const tick = new MaintenanceKernel(f.service).tick({ now: "2030-01-01T00:00:00.000Z" });
    assert.equal((tick.knowledge_expiry as JsonObject).count, 1);
    assert.equal((tick.memory_expiry as JsonObject).count, 1);
    assert.equal(f.store.get("knowledge_claim", "claim").status, "expired");
    assert.equal(f.store.get("memory_candidate", "memory").status, "expired");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("trial Outcome automatically closes its canonical Trace", async () => {
  const f = await fixture();
  try {
    f.store.create("task", "task", { title: "task", goal: "trial" });
    f.store.create("workflow", "workflow", { name: "workflow", lifecycle: "draft" });
    const trial = f.service.trialStart({ trial_id: "trial", task_id: "task", subject_type: "workflow", subject_id: "workflow", subject_version: 1 });
    f.service.trialTraceAppend({ trial_id: trial.id, event_type: "started", data: {} });
    f.service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "verified", scores: {}, costs: {}, evidence_ids: [] });
    assert.equal((f.service.traceGet({ trace_id: "trial:trial" }).trace as JsonObject).status, "completed");
    assert.equal((f.service.traceGet({ trace_id: "trial:trial" }).events as JsonObject[]).at(-1)?.event_kind, "trace.finalized");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("component Trace handles terminal reuse and non-Error failures", async () => {
  const f = await fixture();
  try {
    const kernel = new ComponentTraceKernel(new TraceKernel(f.store), "session");
    const first = await kernel.capture({ requestId: "one", component: "test", operation: "ok", input: { a: [1, true] }, handler: () => ({ ok: true }) });
    assert.equal(first.ok, true);
    const reused = await kernel.capture({ requestId: "one", component: "test", operation: "ok", input: { a: [1, true] }, handler: () => ({ ok: true }) });
    assert.equal(reused.ok, true);
    const explicit = await kernel.capture({ requestId: "two", component: "test", operation: "join", input: { trace_id: "join", task_id: "task" }, handler: () => ({ ok: true }) });
    assert.equal(explicit.correlation!.auto_finalized, false);
    const failed = await kernel.capture({ requestId: "three", component: "test", operation: "bad", input: {}, handler: () => { throw "bad"; } });
    assert.equal(failed.ok, false);
    assert.equal((f.store.get("trace", String(failed.correlation!.trace_id))).status, "failed");
    const empty = await kernel.capture({ requestId: "four", component: "test", operation: "empty", input: {}, handler: () => undefined as never });
    assert.equal(empty.ok, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("service exposes the independent outcome observer method", async () => {
  const f = await fixture();
  try {
    f.service.traceStart({ trace_id: "observer-trace", task_id: "observer-task", environment_fingerprint: "env" });
    f.store.create("evidence", "observer-evidence", { confidence: "confirmed" });
    const result = f.service.outcomeObserverObserve({ observation_id: "observer-call", trace_id: "observer-trace", host_id: "host", observer_id: "observer", observer_kind: "program", environment_fingerprint: "env", verdict: "passed", state_snapshot_ref: "state", evidence_ids: ["observer-evidence"] });
    assert.equal((result.observation as JsonObject).id, "observer-call");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.32 Trace Review classifies immutable failures and supports idempotent reads", async () => {
  const f = await fixture();
  try {
    f.store.create("task", "review-task", { title: "review", goal: "diagnose" });
    f.service.traceStart({ trace_id: "review-trace", task_id: "review-task", model_fingerprint: "model:v1", environment_fingerprint: "env:v1", capability_fingerprint: "cap:v1", policy_fingerprint: "policy:v1" });
    f.service.traceAppend({ trace_id: "review-trace", event_kind: "tool.failed", status: "failed", error_class: "policy_denied", summary: "denied", data: {} });
    f.service.traceFinalize({ trace_id: "review-trace", status: "failed", summary: "failed" });
    f.store.create("evidence", "review-evidence", { confidence: "bounded" });
    const first = f.service.traceReview({ trace_id: "review-trace", review_id: "review-1", summary: "diagnose", evidence_ids: ["review-evidence"] });
    assert.equal((first.review as JsonObject).status, "needs_attention");
    assert.equal((first.review as JsonObject).root_cause, "policy");
    assert.equal((f.service.traceReview({ trace_id: "review-trace", review_id: "review-1", summary: "diagnose", evidence_ids: ["review-evidence"] }) as JsonObject).idempotent, true);
    assert.throws(() => f.service.traceReview({ trace_id: "review-trace", review_id: "review-1", summary: "changed" }), /idempotency/);
    assert.equal((f.service.traceReviewGet({ review_id: "review-1" }).trace as JsonObject).id, "review-trace");
    assert.equal((f.service.traceReviewList({ status: "needs_attention" }).reviews as JsonObject[]).length, 1);
    assert.equal((f.service.traceReviewList({}).reviews as JsonObject[]).length, 1);
    assert.throws(() => f.service.traceReviewList({ status: "bad" }), /unsupported/);
    assert.throws(() => f.service.traceReview({ trace_id: "review-trace", summary: "bad", evidence_ids: ["review-evidence", "review-evidence"] }), /unique/);
    assert.throws(() => f.service.traceReview({ trace_id: "" }), /must not be empty/);
    assert.throws(() => f.service.traceReview({ trace_id: 123 as never }), /must not be empty/);
    assert.throws(() => f.service.traceReview({ trace_id: "review-trace", evidence_ids: "bad" as never }), /array/);
    assert.throws(() => f.service.traceReview({ trace_id: "review-trace", evidence_ids: [123] as never }), /must not be empty/);

    f.store.create("task", "review-pass-task", { title: "review", goal: "pass" });
    f.service.traceStart({ trace_id: "review-pass", task_id: "review-pass-task" });
    f.service.traceFinalize({ trace_id: "review-pass", status: "completed", summary: "done" });
    assert.equal((f.service.traceReview({ trace_id: "review-pass", summary: "done" }).review as JsonObject).status, "passed");
    f.store.create("task", "review-running-task", { title: "review", goal: "running" });
    f.service.traceStart({ trace_id: "review-running", task_id: "review-running-task" });
    f.service.traceAppend({ trace_id: "review-running", event_kind: "progress", status: "running", data: {} });
    f.store.save("trace_event", "review-running:1", { ...f.store.get("trace_event", "review-running:1"), error_class: null, event_kind: null });
    f.service.traceAppend({ trace_id: "review-running", event_kind: "progress-2", status: "running", data: {} });
    f.store.save("trace_event", "review-running:2", { ...f.store.get("trace_event", "review-running:2"), error_class: "" });
    assert.equal((f.service.traceReview({ trace_id: "review-running" }).review as JsonObject).status, "inconclusive");
    f.store.create("task", "review-observe-task", { title: "review", goal: "observe" });
    f.service.traceStart({ trace_id: "review-observe", task_id: "review-observe-task" });
    f.service.traceAppend({ trace_id: "review-observe", event_kind: "action.completed", status: "completed", output_refs: [], data: {} });
    f.service.traceAppend({ trace_id: "review-observe", event_kind: "other.completed", status: "completed", output_refs: ["artifact"], data: {} });
    f.service.traceFinalize({ trace_id: "review-observe", status: "completed", summary: "observed" });
    assert.equal((f.service.traceReview({ trace_id: "review-observe" }).review as JsonObject).status, "inconclusive");
    f.store.create("task", "review-unknown-task", { title: "review", goal: "unknown" });
    f.service.traceStart({ trace_id: "review-unknown", task_id: "review-unknown-task" });
    f.service.traceAppend({ trace_id: "review-unknown", event_kind: "tool.failed", status: "failed", error_class: "mystery", data: {} });
    f.service.traceFinalize({ trace_id: "review-unknown", status: "failed", summary: "unknown" });
    assert.equal((f.service.traceReview({ trace_id: "review-unknown" }).review as JsonObject).root_cause, "unknown");
    f.store.create("task", "review-null-task", { title: "review", goal: "null" });
    f.service.traceStart({ trace_id: "review-null", task_id: "review-null-task" });
    f.service.traceAppend({ trace_id: "review-null", event_kind: "tool.failed", status: "failed", error_class: "failed", data: {} });
    f.store.save("trace_event", "review-null:1", { ...f.store.get("trace_event", "review-null:1"), error_class: null });
    f.service.traceFinalize({ trace_id: "review-null", status: "failed", summary: "null" });
    assert.equal((f.service.traceReview({ trace_id: "review-null" }).review as JsonObject).root_cause, "unknown");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.32 memory learning cycle is resumable, content-free, and idempotent", async () => {
  const f = await fixture();
  try {
    f.store.create("task", "cycle-task", { title: "cycle", goal: "learn" });
    f.service.traceStart({ trace_id: "cycle-trace-a", task_id: "cycle-task", model_fingerprint: "model:a", environment_fingerprint: "env:a" });
    f.service.traceFinalize({ trace_id: "cycle-trace-a", status: "completed", summary: "done" });
    f.service.traceStart({ trace_id: "cycle-trace-b", task_id: "cycle-task", model_fingerprint: "model:b", environment_fingerprint: "env:b" });
    f.service.traceFinalize({ trace_id: "cycle-trace-b", status: "failed", summary: "failed" });
    f.service.traceStart({ trace_id: "cycle-trace-c", task_id: "cycle-task" });
    f.service.traceFinalize({ trace_id: "cycle-trace-c", status: "cancelled", summary: "cancelled" });
    f.service.traceStart({ trace_id: "cycle-running", task_id: "cycle-task" });
    const first = f.service.memoryMaintenanceCycle({ cycle_id: "cycle-1", cursor: 0, limit: 1 });
    assert.equal((first.observations as JsonObject[]).length, 1);
    assert.equal((first.cycle as JsonObject).raw_content_stored, false);
    assert.equal(first.exhausted, false);
    const second = f.service.memoryMaintenanceCycle({ cycle_id: "cycle-2", cursor: first.next_cursor, limit: 10 });
    assert.equal((second.observations as JsonObject[]).length, 2);
    assert.equal(second.exhausted, true);
    assert.equal((f.service.memoryMaintenanceCycle({ cycle_id: "cycle-2", cursor: first.next_cursor, limit: 10 }) as JsonObject).idempotent, true);
    assert.throws(() => f.service.memoryMaintenanceCycle({ cycle_id: "cycle-2", cursor: first.next_cursor, limit: 1 }), /idempotency/);
    const generated = f.service.memoryMaintenanceCycle({ cursor: 99, limit: 1 });
    assert.equal((generated.cycle as JsonObject).raw_content_stored, false);
    assert.throws(() => f.service.memoryMaintenanceCycle({ cursor: -1 }), /non-negative/);
    assert.throws(() => f.service.memoryMaintenanceCycle({ limit: 0 }), /between 1 and 500/);
    const full = new McpServer(f.service, "full");
    const call = await full.handlers.craft_memory_maintenance_cycle({ cycle_id: "cycle-3", cursor: 0, limit: 1 });
    assert.equal((call.cycle as JsonObject).id, "cycle-3");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.32 Memory Maintenance is proposal-only and records usage signals", async () => {
  const f = await fixture();
  try {
    const one = f.service.memoryConsolidationRemember({ memory_id: "episode-1", scope: "project:p", source: "test", content: "same method" }).memory as JsonObject;
    f.service.memoryConsolidationRemember({ memory_id: "episode-2", scope: "project:p", source: "test", content: "same method" });
    const signal = f.service.memoryMaintenanceSignal({ memory_id: one.id, kind: "adopted", value: 2, signal_id: "signal-1" });
    assert.equal((signal.signal as JsonObject).value, 2);
    assert.equal((f.service.memoryMaintenanceSignal({ memory_id: one.id, kind: "adopted", value: 2, signal_id: "signal-1" }) as JsonObject).idempotent, true);
    assert.equal((f.service.memoryMaintenanceSignal({ memory_id: one.id }).signal as JsonObject).value, 1);
    assert.throws(() => f.service.memoryMaintenanceSignal({ memory_id: one.id, kind: "adopted", value: 3, signal_id: "signal-1" }), /conflict/);
    assert.throws(() => f.service.memoryMaintenanceSignal({ memory_id: one.id, kind: "adopted", value: -1 }), /non-negative/);
    const light = f.service.memoryMaintenanceRun({ maintenance_id: "maintenance-light", stage: "light", now: "2030-01-01T00:00:00.000Z" });
    assert.equal((light.run as JsonObject).status, "completed");
    assert.ok((light.findings as JsonObject[]).some((item) => item.kind === "duplicate"));
    assert.equal((f.service.memoryMaintenanceRun({ maintenance_id: "maintenance-light", stage: "light", now: "2030-01-01T00:00:00.000Z" }) as JsonObject).idempotent, true);
    assert.throws(() => f.service.memoryMaintenanceRun({ stage: "bad" }), /unsupported/);
    assert.throws(() => f.service.memoryMaintenanceRun({ stage: "light", now: "bad" }), /ISO/);
    assert.throws(() => f.service.memoryMaintenanceRun({ stage: 0 as never }), /must not be empty/);
    const defaultRun = f.service.memoryMaintenanceRun({});
    assert.equal((defaultRun.run as JsonObject).status, "completed");
    assert.equal((f.service.memoryMaintenanceGet({ maintenance_id: "maintenance-light" }).candidate), null);
    const semantic = f.service.memoryConsolidationConsolidate({ memory_ids: [one.id], semantic_id: "semantic-1", content: "same method" }).memory as JsonObject;
    const deep = f.service.memoryMaintenanceRun({ maintenance_id: "maintenance-deep", stage: "deep" });
    assert.ok((deep.findings as JsonObject[]).some((item) => item.kind === "duplicate"));
    assert.equal((deep.candidate as JsonObject).publication_allowed, false);
    f.store.create("semantic_memory", "orphan", { status: "active", memory_ids: ["missing"], content_digest: "orphan" });
    f.store.create("semantic_memory", "orphan-undefined", { status: "active", content_digest: "orphan-undefined" });
    const reviewed = f.service.memoryMaintenanceRun({ maintenance_id: "maintenance-review", stage: "review" });
    assert.ok((reviewed.findings as JsonObject[]).some((item) => item.kind === "orphaned_semantic"));
    f.store.create("episodic_memory", "missing-ref", { scope: "project:p", source: "test", content_digest: "missing-ref" });
    f.store.create("episodic_memory", "sensitive-source", { scope: "project:p", source: "api_key: leaked", content_digest: "sensitive" });
    f.store.create("episodic_memory", "no-source", { scope: "project:p", content_digest: "no-source" });
    const deepWithCandidate = f.service.memoryMaintenanceRun({ maintenance_id: "maintenance-deep-2", stage: "deep" });
    assert.equal((deepWithCandidate.candidate as JsonObject).publication_allowed, false);
    assert.equal((f.service.memoryMaintenanceGet({ maintenance_id: "maintenance-deep-2" }).candidate as JsonObject).id, "maintenance-deep-2:candidate");
    assert.throws(() => f.service.memoryMaintenanceRun({ maintenance_id: "maintenance-deep-2", stage: "deep", now: "2031-01-01T00:00:00.000Z" }), /conflict/);
    assert.equal(semantic.id, "semantic-1");
    assert.equal((f.service.memoryConsolidationSearch({ query: "same", scope: "project:p" }).results as JsonObject[]).length >= 1, true);
    f.store.create("semantic_memory", "plain-content", { status: "active", scope: "project:p", content: "plain text" });
    f.store.create("semantic_memory", "bad-ref", { status: "active", scope: "project:p", content_ref: { locator: "missing" } });
    f.store.create("semantic_memory", "array-ref", { status: "active", scope: "project:p", content_ref: [] });
    assert.equal((f.service.memoryConsolidationSearch({ query: "plain", scope: "project:p" }).results as JsonObject[]).length, 1);
    assert.equal((f.service.memoryConsolidationSearch({ query: "same", scope: { kind: "project", id: "p" } }).results as JsonObject[]).length >= 1, true);
    const emptyObjectScope = f.service.memoryConsolidationSearch({ query: "plain", scope: {} });
    assert.equal(emptyObjectScope.skipped, true);
    const skipped = f.service.memoryConsolidationSearch({ query: "plain", scope: " " });
    assert.equal(skipped.skipped, true);
    assert.deepEqual(skipped.results, []);
    const nullScope = f.service.memoryConsolidationSearch({ query: "plain", scope: null });
    assert.equal(nullScope.skipped, true);
    assert.throws(() => f.service.memoryConsolidationSearch({ query: "plain", scope: 42 }), /scope must be a string or scope object/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.32 new review and maintenance MCP tools are exposed on the core surface", async () => {
  const f = await fixture();
  try {
    const server = new McpServer(f.service, "core");
    const listed = await server.handle({ id: "tools", method: "tools/list", params: {} });
    const names = ((listed?.result as JsonObject).tools as JsonObject[]).map((item) => item.name);
    assert.ok(names.includes("craft_trace_review"));
    assert.ok(names.includes("craft_memory_maintenance_run"));
    assert.ok(names.includes("craft_memory_maintenance_get"));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.32 review and maintenance MCP handlers execute through the full surface", async () => {
  const f = await fixture();
  try {
    f.store.create("task", "mcp-review-task", { title: "review", goal: "mcp" });
    f.service.traceStart({ trace_id: "mcp-review-trace", task_id: "mcp-review-task" });
    f.service.traceFinalize({ trace_id: "mcp-review-trace", status: "completed", summary: "done" });
    const server = new McpServer(f.service, "full");
    const call = async (name: string, arguments_: JsonObject) => {
      const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as JsonObject).isError, false, name);
      return (response?.result as JsonObject).structuredContent as JsonObject;
    };
    await call("craft_trace_review", { trace_id: "mcp-review-trace", review_id: "mcp-review", summary: "done" });
    await call("craft_trace_review_get", { review_id: "mcp-review" });
    await call("craft_trace_review_list", {});
    f.service.memoryConsolidationRemember({ memory_id: "mcp-episode", scope: "task:mcp", source: "test", content: "mcp memory" });
    const skippedSearch = await server.handle({ id: "memory-search", method: "tools/call", params: { name: "craft_memory_search", arguments: { query: "mcp", scope: {} } } });
    assert.equal((skippedSearch?.result as JsonObject).isError, false);
    assert.equal(((skippedSearch?.result as JsonObject).structuredContent as JsonObject).skipped, true);
    await call("craft_memory_maintenance_signal", { memory_id: "mcp-episode", signal_id: "mcp-signal", kind: "recalled" });
    await call("craft_memory_maintenance_run", { maintenance_id: "mcp-maintenance", stage: "light" });
    await call("craft_memory_maintenance_get", { maintenance_id: "mcp-maintenance" });
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.34 maintenance keeps legacy fallback observable and reports expired governed entries", async () => {
  const f = await fixture();
  try {
    f.store.create("episodic_memory", "legacy-memory", { scope: "project:p", source: "legacy", content_digest: "legacy" });
    assert.equal((f.service.memoryMaintenanceSignal({ memory_id: "legacy-memory", kind: "recalled" }).signal as JsonObject).memory_kind, "episodic_memory");
    assert.throws(() => f.service.memoryMaintenanceSignal({ memory_id: "missing" }), /Unknown Memory/);
    const legacyRun = f.service.memoryMaintenanceRun({ maintenance_id: "legacy-fallback", stage: "review" });
    assert.equal((legacyRun.run as JsonObject).memory_kind, "episodic_memory");
    assert.ok((legacyRun.findings as JsonObject[]).some((item) => item.kind === "missing_content_ref"));
    f.store.create("memory_ledger", "expired-ledger", { scope: { kind: "project", id: "p" }, source_id: "source", content_digest: "expired", content_ref: { path: "unused" }, status: "active", valid_until: "2020-01-01T00:00:00.000Z" });
    f.store.create("memory_ledger", "scope-less-ledger", { source_id: "source", content_digest: "scope-less", content_ref: { path: "unused" }, status: "active", valid_until: null });
    f.store.create("memory_ledger", "digest-less-ledger", { scope: { kind: "project", id: "p" }, source_id: "source", content_ref: { path: "unused" }, status: "active", valid_until: null });
    assert.equal((f.service.memoryMaintenanceSignal({ memory_id: "expired-ledger", kind: "adopted" }).signal as JsonObject).memory_kind, "memory_ledger");
    const governedRun = f.service.memoryMaintenanceRun({ maintenance_id: "expired-governed", stage: "light", now: "2030-01-01T00:00:00.000Z" });
    assert.equal((governedRun.run as JsonObject).memory_kind, "memory_ledger");
    assert.ok((governedRun.findings as JsonObject[]).some((item) => item.kind === "expired_active"));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
