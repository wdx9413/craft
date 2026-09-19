import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostSessionEventKernel } from "../src/host-session-events.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { TraceKernel } from "../src/trace-kernel.ts";

/**
 * Gap 5: can the harness be replaced without losing the session?
 *
 * Anthropic's Managed Agents post (2026-04-08) virtualises an agent into three
 * interchangeable parts — session (an append-only log), harness (the loop) and
 * sandbox (execution) — precisely so that "the implementation of each can be
 * swapped without disturbing the others". It warns that coupling them means
 * adopting a pet, and that a harness's assumptions go stale as models improve.
 *
 * Craft claims the same separation. The claim is only worth anything if a
 * *fresh* runtime instance, built over nothing but the persisted store, can pick
 * up a session an earlier instance started. That is what these tests
 * demonstrate: no in-memory object is ever passed between the "harnesses", so
 * the store is the only channel available to them.
 */

/** Builds a store + kernels the way a newly started process would. */
async function bootHarness(dir: string, open: Array<{ close(): void }>) {
  const store = await new CraftStore(craftPaths(dir)).open();
  open.push(store);
  const trace = new TraceKernel(store);
  return { store, trace, sessions: new HostSessionEventKernel(store, trace) };
}

/** The minimum a session needs, expressed the way the kernel expects it. */
function startedPayload(hostId: string, traceId: string): JsonObject {
  return {
    host_id: hostId,
    trace_id: traceId,
    goal: "prove the session outlives the harness",
    workspace: "C:/work/example",
    started_at: new Date().toISOString(),
    status: "running",
    next_sequence: 0,
  };
}

/** Starts a trace the way a harness would when it picks up a task. */
function startTrace(harness: { trace: TraceKernel }, actor: string): JsonObject {
  return harness.trace.start({
    task_id: "task-swap", actor, source: "runtime", trust: "observed", goal: "session continuity",
  }).trace as JsonObject;
}

/**
 * Creates a temp root and guarantees that every store opened under it is closed
 * *before* the directory is removed. Windows refuses to unlink an open SQLite
 * file, so cleanup order is part of the fixture rather than an afterthought.
 */
async function workspace(t: { after(fn: () => unknown): void }, prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const open: Array<{ close(): void }> = [];
  t.after(async () => {
    for (const store of open) { try { store.close(); } catch { /* already closed */ } }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, open };
}

test("v0.12.34 a fresh harness resumes a session started by an earlier one", async (t) => {
  const { dir, open } = await workspace(t, "craft-harness-swap-");

  // --- harness #1: starts a session and appends two events, then goes away ---
  const first = await bootHarness(dir, open);
  const trace = startTrace(first, "harness-1");
  const session = first.store.create("host_session", "session-swap-1", startedPayload("host-1", String(trace.id)));

  first.sessions.append({
    session_id: String(session.id), kind: "session.started", event_id: "e1",
    summary_digest: "sha256:start",
  });
  first.sessions.append({
    session_id: String(session.id), kind: "host.dispatched", event_id: "e2",
    action_contract_ref: "contract:1", summary_digest: "sha256:dispatch",
  });
  const beforeSwap = first.sessions.get({ session_id: "session-swap-1" });
  assert.equal((beforeSwap.events as JsonObject[]).length, 2);
  // Close the first harness's handle: the data must outlive this object.
  first.store.close();

  // --- harness #2: a brand-new instance over the same store, nothing shared ---
  const second = await bootHarness(dir, open);

  // The session is visible without either harness holding state in memory.
  const recovered = second.sessions.get({ session_id: "session-swap-1" });
  const recoveredSession = recovered.session as JsonObject;
  assert.equal(recoveredSession.status, "running");
  assert.equal(recoveredSession.host_id, "host-1");
  assert.equal(recoveredSession.goal, "prove the session outlives the harness");

  // The append-only log survived intact, in order.
  const events = recovered.events as JsonObject[];
  assert.deepEqual(events.map((event) => event.kind), ["session.started", "host.dispatched"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  // Sequence contiguity is what makes replay trustworthy after a swap.
  assert.equal(Number(recoveredSession.next_sequence), 2);

  // The new harness can continue the same log, which proves the session is not
  // owned by the instance that created it.
  const appended = second.sessions.append({
    session_id: "session-swap-1", kind: "host.receipt", event_id: "e3",
    summary_digest: "sha256:receipt",
  });
  assert.equal(Number((appended.event as JsonObject).sequence), 3);

  const afterResume = second.sessions.get({ session_id: "session-swap-1" });
  assert.deepEqual((afterResume.events as JsonObject[]).map((event) => event.sequence), [1, 2, 3]);
});

test("v0.12.34 a paused session is resumed from the log alone, across harnesses", async (t) => {
  const { dir, open } = await workspace(t, "craft-harness-resume-");

  const first = await bootHarness(dir, open);
  const trace = startTrace(first, "harness-1");
  first.store.create("host_session", "session-swap-2", startedPayload("host-2", String(trace.id)));
  first.sessions.append({ session_id: "session-swap-2", kind: "session.started", event_id: "p1", summary_digest: "sha256:start" });
  first.sessions.append({ session_id: "session-swap-2", kind: "session.paused", event_id: "p2", summary_digest: "sha256:pause" });
  assert.equal(String((first.sessions.get({ session_id: "session-swap-2" }).session as JsonObject).status), "paused");
  first.store.close();

  // A different harness wakes the paused session. The pause state, not any
  // in-memory flag, is what the resume check reads.
  const second = await bootHarness(dir, open);

  const resumed = second.sessions.resume({ session_id: "session-swap-2", reason_digest: "sha256:operator-approved" });
  assert.equal(String((resumed.session as JsonObject).status), "running");
  assert.equal(String((resumed.event as JsonObject).kind), "session.resumed");

  const history = second.sessions.get({ session_id: "session-swap-2" });
  assert.deepEqual((history.events as JsonObject[]).map((event) => event.kind), ["session.started", "session.paused", "session.resumed"]);

  // A resume demands a digest: waking a session is an auditable act, and a
  // harness swap must not become a way to skip that record. This is asserted on
  // a freshly paused session, since the first one is now running.
  second.store.create("host_session", "session-swap-2b", startedPayload("host-2", String(trace.id)));
  second.sessions.append({ session_id: "session-swap-2b", kind: "session.started", event_id: "q1", summary_digest: "sha256:start" });
  second.sessions.append({ session_id: "session-swap-2b", kind: "session.paused", event_id: "q2", summary_digest: "sha256:pause" });
  assert.throws(() => second.sessions.resume({ session_id: "session-swap-2b", reason_digest: "not-a-digest" }), /reason digest/u);
  // The rejected resume left the session paused rather than half-woken.
  assert.equal(String((second.sessions.get({ session_id: "session-swap-2b" }).session as JsonObject).status), "paused");
  // Resuming an already-running session is refused, which is what stops a
  // second harness from wandering into a session another one is driving.
  assert.throws(() => second.sessions.resume({ session_id: "session-swap-2", reason_digest: "sha256:again" }), /not paused/u);
});

test("v0.12.34 replaying a session does not depend on the harness that wrote it", async (t) => {
  const { dir, open } = await workspace(t, "craft-harness-replay-");

  const first = await bootHarness(dir, open);
  const trace = startTrace(first, "harness-a");
  first.store.create("host_session", "session-swap-3", startedPayload("host-a", String(trace.id)));
  first.sessions.append({ session_id: "session-swap-3", kind: "session.started", event_id: "r1", summary_digest: "sha256:a" });
  first.sessions.append({ session_id: "session-swap-3", kind: "host.dispatched", event_id: "r2", summary_digest: "sha256:b" });
  const snapshot = first.sessions.get({ session_id: "session-swap-3" });
  first.store.close();

  // A third harness, never involved before, must observe identical history.
  const third = await bootHarness(dir, open);
  const replayed = third.sessions.get({ session_id: "session-swap-3" });

  assert.deepEqual(
    (replayed.events as JsonObject[]).map((event) => ({ kind: event.kind, digest: event.event_digest, sequence: event.sequence })),
    (snapshot.events as JsonObject[]).map((event) => ({ kind: event.kind, digest: event.event_digest, sequence: event.sequence })));
  // The trace is the independent witness: it is written to a separate record
  // type, so agreement between the two is evidence rather than tautology.
  assert.equal(
    ((replayed.trace as JsonObject).events as JsonObject[]).length,
    ((snapshot.trace as JsonObject).events as JsonObject[]).length);

  // Re-appending a known event id is idempotent across harness boundaries, so a
  // swapped harness cannot double-record the same action.
  const replayedAppend = third.sessions.append({
    session_id: "session-swap-3", kind: "host.dispatched", event_id: "r2", summary_digest: "sha256:b",
  });
  assert.equal(replayedAppend.idempotent, true);
  assert.equal((third.sessions.get({ session_id: "session-swap-3" }).events as JsonObject[]).length, 2);
});
