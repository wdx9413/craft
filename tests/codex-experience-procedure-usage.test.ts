import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexExperienceProcedureUsageCapture } from "../core/interfaces/codex-experience-procedure-usage.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-procedure-usage-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  const scope = { kind: "project", id: "project:usage-test" };
  const traceId = "codex-usage-trace";
  const receiptId = "context-usage-receipt";
  const procedureRef = { member: "experience", id: "procedure-42", version: 7, digest: `sha256:${"a".repeat(64)}` };
  service.traceStart({ trace_id: traceId, task_id: "task-usage", host: "codex", project_scope: scope,
    session_id: "session-usage", turn_id: "turn-usage" });
  store.create("context_resolution_receipt", receiptId, { scope, members: ["experience"],
    contributions: [{ member: "experience", references: [{ id: procedureRef.id, version: procedureRef.version, digest: procedureRef.digest }] }] });
  return {
    root, store, service, scope, traceId, receiptId, procedureRef,
    capture: new CodexExperienceProcedureUsageCapture(service),
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

function usage(f: Awaited<ReturnType<typeof fixture>>, state: string, extras: Record<string, unknown> = {}) {
  return f.capture.record({
    trace_id: f.traceId,
    host: "codex",
    session_id: "session-usage",
    turn_id: "turn-usage",
    project_scope: f.scope,
    context_receipt_id: f.receiptId,
    procedure_ref: f.procedureRef,
    usage_state: state,
    ...extras,
  });
}

test("Procedure usage Trace receipt binds an exact shown version and does not claim task effect", async () => {
  const f = await fixture();
  try {
    const result = usage(f, "presented", { private_content: "private prompt must not persist" });
    assert.equal(result.status, "captured");
    assert.equal(result.usage, false);
    assert.equal(result.effect_evidence, "not_established");
    const trace = f.service.traceGet({ trace_id: f.traceId });
    const event = (trace.events as Record<string, unknown>[])[0]!;
    assert.equal(event.event_kind, "experience.procedure.usage");
    assert.equal(event.status, "presented");
    assert.deepEqual(event.action_contract, {
      kind: "experience_procedure_usage",
      context_receipt_id: f.receiptId,
      procedure_ref: f.procedureRef,
      usage_state: "presented",
      usage: false,
      effect_evidence: "not_established",
      source_event_refs: [],
    });
    assert.equal(JSON.stringify(trace).includes("private prompt"), false);
  } finally { await f.close(); }
});

test("generic Host actions cannot be used to claim a Procedure was followed or changed", async () => {
  const f = await fixture();
  try {
    const action = (traceId: string, eventId: string) => f.service.traceAppend({ trace_id: traceId, event_id: eventId,
      event_kind: "host.tool.completed", actor: "host", source: "codex", trust: "observed",
      operation_id: "codex_tool_edit", status: "succeeded",
      action_contract: { kind: "host_tool_operation", tool_category: "file_edit", action: "edit" },
      input_refs: [eventId], data: {} });
    action(f.traceId, "host-action");
    action(f.traceId, "host-action-2");
    for (const state of ["selected", "followed", "modified", "skipped", "rolled_back"]) {
      assert.deepEqual(usage(f, state, { source_event_refs: ["host-action"] }),
        { status: "rejected", reason_code: "usage_state_unsupported" });
    }
    assert.deepEqual(usage(f, "presented", { source_event_refs: ["host-action"] }),
      { status: "rejected", reason_code: "usage_evidence_unavailable" });
    assert.deepEqual(usage(f, "presented", { source_event_refs: "host-action" }),
      { status: "rejected", reason_code: "usage_evidence_unavailable" });
    assert.equal(f.store.list("trace_event", 100, event => event.event_kind === "experience.procedure.usage").length, 0);
  } finally { await f.close(); }
});

test("procedure usage receipt rejects a stale version, another scope, and unobserved action refs", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(usage(f, "presented", { procedure_ref: { ...f.procedureRef, version: 6 } }),
      { status: "rejected", reason_code: "procedure_reference_not_in_context_receipt" });
    assert.deepEqual(usage(f, "presented", { procedure_ref: { ...f.procedureRef, digest: `sha256:${"b".repeat(64)}` } }),
      { status: "rejected", reason_code: "procedure_reference_not_in_context_receipt" });
    assert.deepEqual(usage(f, "presented", { procedure_ref: { ...f.procedureRef, member: "knowledge" } }),
      { status: "rejected", reason_code: "procedure_reference_not_in_context_receipt" });
    assert.deepEqual(usage(f, "presented", { project_scope: { kind: "project", id: "project:other" } }),
      { status: "rejected", reason_code: "trace_identity_conflict" });
    assert.deepEqual(usage(f, "presented", { source_event_refs: ["missing-event"] }),
      { status: "rejected", reason_code: "usage_evidence_unavailable" });
    assert.deepEqual(usage(f, "presented", { source_event_refs: ["invalid id"] }),
      { status: "rejected", reason_code: "usage_evidence_unavailable" });
    assert.deepEqual(usage(f, "presented", { source_event_refs: ["missing-event", "missing-event"] }),
      { status: "rejected", reason_code: "usage_evidence_unavailable" });
    assert.deepEqual(usage(f, "followed"), { status: "rejected", reason_code: "usage_state_unsupported" });
    assert.deepEqual(usage(f, "rolled_back", { source_event_refs: ["one-event"] }),
      { status: "rejected", reason_code: "usage_state_unsupported" });
    assert.deepEqual(usage(f, "unknown"), { status: "rejected", reason_code: "usage_state_unsupported" });
    assert.deepEqual(usage(f, "presented", { usage_state: null }), { status: "rejected", reason_code: "usage_state_unsupported" });
  } finally { await f.close(); }
});

test("procedure usage rejects missing or mismatched Host identity and source records", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.capture.record({ host: "claude" }), { status: "rejected", reason_code: "unsupported_host" });
    assert.deepEqual(usage(f, "presented", { session_id: undefined }),
      { status: "rejected", reason_code: "host_identity_unavailable" });
    assert.deepEqual(usage(f, "presented", { trace_id: "missing-trace" }),
      { status: "rejected", reason_code: "trace_unavailable" });
    assert.deepEqual(usage(f, "presented", { context_receipt_id: "missing-receipt" }),
      { status: "rejected", reason_code: "context_receipt_unavailable" });
    assert.deepEqual(usage(f, "presented", { project_scope: { kind: "global", id: "global" } }),
      { status: "rejected", reason_code: "host_identity_unavailable" });

    f.service.traceStart({ trace_id: "other-host-trace", task_id: "task-other", host: "codex", project_scope: f.scope,
      session_id: "session-other", turn_id: "turn-usage" });
    assert.deepEqual(usage(f, "presented", { trace_id: "other-host-trace" }),
      { status: "rejected", reason_code: "trace_identity_conflict" });

    f.store.create("context_resolution_receipt", "other-scope-receipt", {
      scope: { kind: "project", id: "project:other" }, asset_refs: [f.procedureRef],
    });
    assert.deepEqual(usage(f, "presented", { context_receipt_id: "other-scope-receipt" }),
      { status: "rejected", reason_code: "context_receipt_scope_conflict" });

    f.service.traceStart({ trace_id: "source-trace", task_id: "task-source", host: "codex", project_scope: f.scope,
      session_id: "session-source", turn_id: "turn-source" });
    f.service.traceAppend({ trace_id: "source-trace", event_id: "foreign-action", event_kind: "host.tool.completed",
      actor: "host", source: "codex", trust: "observed", operation_id: "codex_tool_edit", status: "succeeded",
      action_contract: { kind: "host_tool_operation" }, input_refs: ["foreign-action"], data: {} });
    assert.deepEqual(usage(f, "followed", { source_event_refs: ["foreign-action"] }),
      { status: "rejected", reason_code: "usage_state_unsupported" });

    const badEvent = f.service.traceAppend({ trace_id: f.traceId, event_id: "bad-action", event_kind: "host.tool.completed",
      actor: "host", source: "codex", trust: "observed", operation_id: "other-operation", status: "succeeded",
      action_contract: { kind: "host_tool_operation" }, input_refs: ["bad-action"], data: {} });
    assert.equal((badEvent.event as Record<string, unknown>).id, "bad-action");
    assert.deepEqual(usage(f, "followed", { source_event_refs: ["bad-action"] }),
      { status: "rejected", reason_code: "usage_state_unsupported" });

    f.store.create("context_pack_receipt", "pack-receipt", { scope: f.scope, asset_refs: [f.procedureRef] });
    const packResult = f.capture.record({ trace_id: f.traceId, host: "codex", session_id: "session-usage", turn_id: "turn-usage",
      project_scope: f.scope, context_receipt_id: "pack-receipt", procedure_ref: f.procedureRef, usage_state: "presented" });
    assert.equal(packResult.status, "captured");

    f.store.create("context_resolution_receipt", "empty-asset-receipt", { scope: f.scope, contributions: [
      null,
      { member: "knowledge", references: [{ id: f.procedureRef.id, version: f.procedureRef.version, digest: f.procedureRef.digest }] },
      { member: "experience", references: "malformed" },
      { member: "experience", references: [null] },
    ] });
    assert.deepEqual(usage(f, "presented", { context_receipt_id: "empty-asset-receipt" }),
      { status: "rejected", reason_code: "procedure_reference_not_in_context_receipt" });
  } finally { await f.close(); }
});

test("procedure usage cannot be appended after the task Trace is terminal", async () => {
  const f = await fixture();
  try {
    f.service.traceFinalize({ trace_id: f.traceId, status: "completed", summary: "verified" });
    assert.deepEqual(usage(f, "presented"), { status: "rejected", reason_code: "trace_terminal" });
  } finally { await f.close(); }
});
