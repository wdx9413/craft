import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture(name: string) {
  const root = join(tmpdir(), `craft-spec-${name}-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store); const task = service.taskOpen({ title: name, goal: "Prepare safe drafts" }).task as JsonObject;
  service.budgetOpen({ budget_id: "spec-budget", owner_type: "task", owner_id: task.id, limits: { tokens: 1000 } });
  const event = (id: string, eventKey = "lead.changed") => store.create("trigger_event", id, { status: "delivered", body_digest: `sha256:${id}`,
    dispatch: { task_id: task.id, event_key: eventKey, payload: { title: id }, trust: "untrusted_data", execution_authority: false } });
  return { root, store, service, task, event };
}

test("speculative preparation is budgeted, disposable, evidence-backed, and learns only from human decisions", async () => {
  const f = await fixture("lifecycle"); const mcp = new McpServer(f.service, "full");
  try {
    const policyResult = await mcp.handlers.craft_speculative_policy_save({ policy_id: "lead-draft", task_id: f.task.id,
      name: "Prepare lead brief", event_key: "lead.changed", operation: "draft", budget_id: "spec-budget",
      estimated_resources: { tokens: 100 }, ttl_seconds: 60, max_candidates: 3 });
    const policy = policyResult.policy as JsonObject; const event = f.event("trigger-one");
    const queued = await mcp.handlers.craft_speculative_enqueue({ policy_id: policy.id, policy_version: policy.version,
      trigger_event_id: event.id, now: "2030-01-01T00:00:00.000Z" });
    const candidate = queued.candidate as JsonObject;
    assert.equal(candidate.execution_authority, false); assert.equal(candidate.trust, "untrusted_data");
    assert.equal((queued.trial as JsonObject).subject_type, "speculative_policy");
    assert.equal((await mcp.handlers.craft_speculative_enqueue({ policy_id: policy.id, policy_version: policy.version,
      trigger_event_id: event.id })).idempotent, true);
    assert.equal((await mcp.handlers.craft_speculative_claim({ worker_id: "wrong", operations: ["index"] })).candidate, null);
    const claimed = await mcp.handlers.craft_speculative_claim({ worker_id: "worker", operations: ["draft"],
      now: "2030-01-01T00:00:01.000Z", lease_ttl_seconds: 60 });
    assert.equal((claimed.dispatch as JsonObject).execution_authority, false);
    const leased = claimed.candidate as JsonObject;
    const artifact = f.service.artifactRegister({ artifact_id: "generated", kind: "draft", name: "Draft", uri: "craft://draft/generated" });
    const evidence = f.service.evidenceRecord({ evidence_id: "generated-proof", source_type: "program", claim: "Draft produced" });
    const ready = await mcp.handlers.craft_speculative_submit({ candidate_id: leased.id, lease_id: leased.lease_id,
      worker_id: "worker", verdict: "ready", summary: "Prepared without external writes", artifact_ids: [artifact.id],
      evidence_ids: [evidence.id], actual_resources: { tokens: 40 }, now: "2030-01-01T00:00:02.000Z" });
    assert.equal((ready.candidate as JsonObject).status, "ready"); assert.equal((ready.settlement as JsonObject).status, "settled");
    const edited = f.service.artifactRegister({ artifact_id: "edited", kind: "draft", name: "Edited", uri: "craft://draft/edited" });
    const accepted = await mcp.handlers.craft_speculative_decide({ candidate_id: candidate.id, decision: "accepted", reviewer: "human:owner",
      final_artifact_ids: [edited.id], correction: "Use a shorter opening", now: "2030-01-01T00:00:03.000Z" });
    assert.equal((accepted.preference_signal as JsonObject).changed, true);
    assert.equal((accepted.outcome as JsonObject).verdict, "passed"); assert.equal((accepted.outcome as JsonObject).source, "human_observed");
    assert.deepEqual((f.service.trialGet({ trial_id: candidate.trial_id }).trace as JsonObject[]).map((item) => item.event_type),
      ["speculative.queued", "speculative.leased", "speculative.ready", "speculative.accepted"]);
    assert.equal(f.store.get("preference_signal", `signal_${candidate.id}`).source, "candidate_decision");

    const event2 = f.event("trigger-two"); const q2 = f.service.speculativeEnqueue({ policy_id: policy.id, policy_version: 1,
      trigger_event_id: event2.id, now: "2030-01-01T00:01:00.000Z" }).candidate as JsonObject;
    const l2 = f.service.speculativeClaim({ worker_id: "worker", operations: ["draft"], now: "2030-01-01T00:01:01.000Z" }).candidate as JsonObject;
    f.service.speculativeSubmit({ candidate_id: q2.id, lease_id: l2.lease_id, worker_id: "worker", verdict: "ready", summary: "Second",
      artifact_ids: [artifact.id], evidence_ids: [evidence.id], actual_resources: {} });
    const rejected = f.service.speculativeDecide({ candidate_id: q2.id, decision: "rejected", reviewer: "human:owner" });
    assert.equal((rejected.preference_signal as JsonObject).changed, false); assert.equal((rejected.outcome as JsonObject).failure_type, "human_rejected");

    const event3 = f.event("trigger-three"); f.service.speculativeEnqueue({ policy_id: policy.id, policy_version: 1,
      trigger_event_id: event3.id, now: "2030-01-01T00:02:00.000Z" });
    const expired = await mcp.handlers.craft_speculative_expire({ now: "2030-01-01T00:03:01.000Z", limit: 1 });
    assert.equal(expired.count, 1); assert.equal((expired.settlements as JsonObject[])[0].status, "settled");
    assert.equal((expired.outcomes as JsonObject[])[0].verdict, "cancelled");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("speculative control plane fails closed on unsafe policy, drift, leases, evidence, cost, and capacity", async () => {
  const f = await fixture("errors");
  const base = { policy_id: "policy", task_id: f.task.id, name: "Policy", event_key: "lead.changed", operation: "summarize",
    budget_id: "spec-budget", estimated_resources: { tokens: 10 } };
  try {
    assert.throws(() => f.service.speculativePolicySave({ ...base, operation: "send_email" }), /not read-only/);
    assert.throws(() => f.service.speculativePolicySave({ ...base, estimated_resources: [] }), /object/);
    assert.throws(() => f.service.speculativePolicySave({ ...base, estimated_resources: { tokens: -1 } }), /non-negative/);
    assert.throws(() => f.service.speculativePolicySave({ ...base, ttl_seconds: 1 }), /between/);
    assert.throws(() => f.service.speculativePolicySave({ ...base, max_candidates: 0 }), /between/);
    assert.throws(() => f.service.speculativePolicySave({ ...base, status: "deleted" }), /unsupported/);
    const policy = f.service.speculativePolicySave({ ...base, max_candidates: 1 }).policy as JsonObject;
    assert.throws(() => f.service.speculativePolicySave({ ...base, expected_version: 2 }), /version conflict/);
    const wrong = f.event("wrong", "other.event");
    assert.throws(() => f.service.speculativeEnqueue({ policy_id: policy.id, policy_version: 1, trigger_event_id: wrong.id }), /does not match/);
    const event = f.event("valid"); const candidate = f.service.speculativeEnqueue({ policy_id: policy.id, policy_version: 1,
      trigger_event_id: event.id, now: "2030-01-01T00:00:00.000Z" }).candidate as JsonObject;
    f.store.save("speculative_candidate", candidate.id as string, { ...candidate, status: "ready" });
    assert.throws(() => f.service.speculativeDecide({ candidate_id: candidate.id, decision: "accepted", reviewer: "human" }), /budget must be settled/);
    f.store.save("speculative_candidate", candidate.id as string, { ...candidate, status: "queued" });
    assert.throws(() => f.service.speculativeEnqueue({ policy_id: policy.id, policy_version: 1,
      trigger_event_id: f.event("overflow").id }), /limit reached/);
    assert.throws(() => f.service.speculativeClaim({ worker_id: "w", operations: [] }), /at least 1/);
    assert.throws(() => f.service.speculativeClaim({ worker_id: "w", operations: ["write"] }), /unsupported/);
    assert.throws(() => f.service.speculativeClaim({ worker_id: "w", operations: ["summarize"], now: "bad" }), /ISO/);
    const leased = f.service.speculativeClaim({ worker_id: "w", operations: ["summarize"], now: "2030-01-01T00:00:01.000Z" }).candidate as JsonObject;
    assert.throws(() => f.service.speculativeSubmit({ candidate_id: candidate.id, lease_id: "bad", worker_id: "w", verdict: "ready", summary: "x" }), /lease/);
    assert.throws(() => f.service.speculativeSubmit({ candidate_id: candidate.id, lease_id: leased.lease_id, worker_id: "w", verdict: "ready",
      summary: "x", now: "2030-01-01T00:10:00.000Z" }), /expired/);
    f.store.save("speculative_candidate", candidate.id as string, { ...f.store.get("speculative_candidate", candidate.id as string), lease_expires_at: "2031-01-01T00:00:00.000Z" });
    assert.throws(() => f.service.speculativeSubmit({ candidate_id: candidate.id, lease_id: leased.lease_id, worker_id: "w", verdict: "unknown", summary: "x" }), /verdict/);
    assert.throws(() => f.service.speculativeSubmit({ candidate_id: candidate.id, lease_id: leased.lease_id, worker_id: "w", verdict: "ready", summary: "x" }), /requires Artifact/);
    assert.throws(() => f.service.speculativeSubmit({ candidate_id: candidate.id, lease_id: leased.lease_id, worker_id: "w", verdict: "failed",
      summary: "x", actual_resources: { tokens: 11 } }), /exceeds/);
    const failed = f.service.speculativeSubmit({ candidate_id: candidate.id, lease_id: leased.lease_id, worker_id: "w", verdict: "failed",
      summary: "Could not summarize", actual_resources: { tokens: 2 } });
    assert.equal((failed.candidate as JsonObject).status, "failed"); assert.equal((failed.outcome as JsonObject).failure_type, "speculative_worker_failed");
    assert.throws(() => f.service.speculativeDecide({ candidate_id: candidate.id, decision: "accepted", reviewer: "human" }), /Only a ready/);
    assert.throws(() => f.service.speculativeExpire({ now: "bad" }), /ISO/);

    const closed = f.service.budgetOpen({ budget_id: "closed", owner_type: "task", owner_id: f.task.id, limits: {} });
    f.service.budgetClose({ budget_id: (closed.account as JsonObject).id });
    assert.throws(() => f.service.speculativePolicySave({ ...base, policy_id: "closed-policy", budget_id: "closed" }), /must be active/);
    const paused = f.service.speculativePolicySave({ ...base, expected_version: 1, status: "paused" }).policy as JsonObject;
    assert.equal(paused.version, 2);
    assert.throws(() => f.service.speculativeEnqueue({ policy_id: paused.id, policy_version: 2, trigger_event_id: event.id }), /not active/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("speculative protocol validates exact reservations, idempotency, scalar controls, and human decisions", async () => {
  const f = await fixture("branches");
  const base = { policy_id: "p", task_id: f.task.id, name: "P", event_key: "lead.changed", operation: "index",
    budget_id: "spec-budget", estimated_resources: { tokens: 10 } };
  try {
    assert.throws(() => f.service.speculativePolicySave({ ...base, name: " " }), /name/);
    assert.throws(() => f.service.speculativePolicySave({ ...base, estimated_resources: { tokens: "x" } }), /non-negative/);
    const policy = f.service.speculativePolicySave(base).policy as JsonObject; const event = f.event("e");
    const reserved = f.service.budgetReserve({ budget_id: "spec-budget", reservation_id: "manual", resources: { tokens: 10 } }).reservation as JsonObject;
    f.store.save("budget_reservation", reserved.id as string, { ...reserved, status: "settled" });
    assert.throws(() => f.service.speculative.enqueue({ policy_id: policy.id, policy_version: 1, trigger_event_id: event.id,
      reservation_id: reserved.id }), /does not match policy/);
    f.store.save("budget_reservation", reserved.id as string, { ...reserved, status: "reserved", budget_id: "other" });
    assert.throws(() => f.service.speculative.enqueue({ policy_id: policy.id, policy_version: 1, trigger_event_id: event.id,
      reservation_id: reserved.id }), /does not match policy/);
    f.store.save("budget_reservation", reserved.id as string, { ...reserved, status: "reserved", resources: { tokens: 9 } });
    assert.throws(() => f.service.speculative.enqueue({ policy_id: policy.id, policy_version: 1, trigger_event_id: event.id,
      reservation_id: reserved.id }), /does not match policy/);
    f.store.save("budget_reservation", reserved.id as string, { ...reserved, status: "reserved" });
    const candidate = f.service.speculative.enqueue({ policy_id: policy.id, policy_version: 1, trigger_event_id: event.id,
      reservation_id: reserved.id, now: "2030-01-01T00:00:00.000Z" }).candidate as JsonObject;
    f.store.save("trigger_event", event.id as string, { ...event, body_digest: "sha256:changed" });
    assert.throws(() => f.service.speculative.enqueue({ policy_id: policy.id, policy_version: 1, trigger_event_id: event.id,
      reservation_id: reserved.id }), /idempotency conflict/);
    assert.throws(() => f.service.speculativeClaim({ worker_id: "w", operations: "index" }), /array/);
    assert.throws(() => f.service.speculativeClaim({ worker_id: "w", operations: ["index", "index"] }), /unique/);
    assert.throws(() => f.service.speculativeClaim({ worker_id: "w", operations: ["index"], lease_ttl_seconds: 1 }), /between/);
    const leased = f.service.speculativeClaim({ worker_id: "w", operations: ["index"], now: "2030-01-01T00:00:01.000Z" }).candidate as JsonObject;
    assert.throws(() => f.service.speculativeSubmit({ candidate_id: candidate.id, lease_id: leased.lease_id, worker_id: "w", verdict: "failed",
      summary: " ", artifact_ids: "bad" }), /array/);
    assert.throws(() => f.service.speculativeSubmit({ candidate_id: candidate.id, lease_id: leased.lease_id, worker_id: "w", verdict: "failed",
      summary: "x", evidence_ids: ["x", "x"] }), /unique/);
    const artifact = f.service.artifactRegister({ artifact_id: "a", kind: "draft", name: "A", uri: "craft://a" });
    const evidence = f.service.evidenceRecord({ evidence_id: "evidence", source_type: "program", claim: "done" });
    const ready = f.service.speculativeSubmit({ candidate_id: candidate.id, lease_id: leased.lease_id, worker_id: "w", verdict: "ready",
      summary: "Ready", artifact_ids: [artifact.id], evidence_ids: [evidence.id], actual_resources: {} }).candidate as JsonObject;
    assert.throws(() => f.service.speculativeDecide({ candidate_id: ready.id, decision: "maybe", reviewer: "human" }), /decision/);
    assert.throws(() => f.service.speculativeDecide({ candidate_id: ready.id, decision: "accepted", reviewer: " " }), /reviewer/);
    const decision = f.service.speculativeDecide({ candidate_id: ready.id, decision: "accepted", reviewer: "human", final_artifact_ids: [artifact.id] });
    assert.equal((decision.preference_signal as JsonObject).changed, false);
    const defaults = f.service.speculative.policySave({ ...base, policy_id: "defaults", estimated_resources: undefined });
    assert.deepEqual((defaults.policy as JsonObject).estimated_resources, {});
    const defaultEvent = f.event("default-event");
    const defaultReservation = f.service.budgetReserve({ budget_id: "spec-budget", reservation_id: "default-reservation", resources: {} }).reservation as JsonObject;
    const defaultCandidate = f.service.speculative.enqueue({ policy_id: "defaults", policy_version: 1, trigger_event_id: defaultEvent.id,
      reservation_id: defaultReservation.id }).candidate as JsonObject;
    const defaultLease = f.service.speculative.claim({ worker_id: "default-worker", operations: ["index"] }).candidate as JsonObject;
    const defaultFailed = f.service.speculative.submit({ candidate_id: defaultCandidate.id, lease_id: defaultLease.lease_id,
      worker_id: "default-worker", verdict: "failed", summary: "No useful draft" });
    assert.equal((defaultFailed.candidate as JsonObject).status, "failed");
    const orphanEvent = f.event("orphan-event");
    const orphanReservation = f.service.budgetReserve({ budget_id: "spec-budget", reservation_id: "orphan-reservation", resources: {} }).reservation as JsonObject;
    f.service.speculative.enqueue({ policy_id: "defaults", policy_version: 1, trigger_event_id: orphanEvent.id,
      reservation_id: orphanReservation.id, now: "2020-01-01T00:00:00.000Z" });
    const orphanExpiry = f.service.speculativeExpire({ now: "2020-01-01T01:00:01.000Z" });
    assert.equal(orphanExpiry.count, 1); assert.deepEqual(orphanExpiry.outcomes, []);
    assert.throws(() => f.service.speculativeExpire({ limit: 0 }), /between/);
    assert.equal(f.service.speculativeExpire({}).count, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
