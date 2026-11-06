import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/application/craft-service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-review-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: new CraftService(store) };
}

test("review round counts up and suspend session blocks running routes", async () => {
  const { store, service } = await fixture();
  try {
    const sessionId = "session-review-1";
    store.save("pilot_session", sessionId, { id: sessionId, title: "s", status: "active", created_at: new Date().toISOString() });
    store.save("pilot_route", "route-1", { id: "route-1", session_id: sessionId, task_id: "task-1",
      queue_state: "running", status: "running", executor_template: "craft", created_at: new Date().toISOString() });
    store.save("pilot_route", "route-2", { id: "route-2", session_id: sessionId, task_id: "task-2",
      queue_state: "queued", status: "queued", executor_template: "craft", created_at: new Date().toISOString() });
    // Round counting: only new (non-duplicate) reviews bump the round.
    assert.equal(service.pilotReviewRound({ session_id: sessionId }).round, 0);
    // First three reviews land in the normal band.
    assert.equal(service.reviewRound(sessionId), 1);
    assert.equal(service.reviewRound(sessionId), 2);
    assert.equal(service.reviewRound(sessionId), 3);
    // Beyond three rounds -> suspend all running/queued routes to blocked queue.
    const suspended = service.pilotSuspendSession({ session_id: sessionId });
    assert.equal(suspended.suspended, 2);
    const r1 = store.get("pilot_route", "route-1");
    const r2 = store.get("pilot_route", "route-2");
    assert.equal(r1.queue_state, "blocked");
    assert.equal(r1.status, "blocked");
    assert.equal(r2.queue_state, "blocked");
    assert.equal(r2.status, "blocked");
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("review round exposes current count over HTTP shape", async () => {
  const { store, service } = await fixture();
  try {
    const sessionId = "session-review-2";
    store.save("pilot_session", sessionId, { id: sessionId, title: "s", status: "active", created_at: new Date().toISOString() });
    service.reviewRound(sessionId);
    service.reviewRound(sessionId);
    const round = service.pilotReviewRound({ session_id: sessionId });
    assert.equal(round.round, 2);
    assert.equal(round.session_id, sessionId);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("pilotReview hard-breaks after three review rounds and suspends the session", async () => {
  const { store, service } = await fixture();
  try {
    const sessionId = "session-breaker";
    store.save("pilot_session", sessionId, { id: sessionId, title: "s", status: "active", created_at: new Date().toISOString() });
    store.save("pilot_route", "route-1", { id: "route-1", session_id: sessionId, task_id: "task-1",
      queue_state: "running", status: "running", executor_template: "craft", created_at: new Date().toISOString() });
    store.save("task", "task-1", { id: "task-1", title: "t", goal: "g", status: "running", created_at: new Date().toISOString() });
    // Four distinct reviews: distinct turn ids produce distinct review ids.
    for (let i = 1; i <= 4; i++) {
      const turnId = "turn-" + i;
      store.save("pilot_turn", turnId, { id: turnId, session_id: sessionId, task_ids: ["task-1"], created_at: new Date().toISOString() });
      const result = service.pilotReview({ session_id: sessionId, turn_id: turnId }) as Record<string, unknown>;
      if (i <= 3) {
        assert.equal(result.review_round, i);
        assert.equal(result.suspended, false);
      } else {
        assert.equal(result.review_round, 4);
        assert.equal(result.suspended, true);
        assert.equal(result.verdict, "suspended");
      }
    }
    const route = store.get("pilot_route", "route-1");
    assert.equal(route.queue_state, "blocked");
    assert.equal(route.status, "blocked");
    // Idempotent re-read of the last review does not advance the round.
    const again = service.pilotReview({ session_id: sessionId, turn_id: "turn-4" }) as Record<string, unknown>;
    assert.equal(again.idempotent, true);
    assert.equal(again.review_round, 4);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("blocked queue lists suspended routes and a human can resume them", async () => {
  const { store, service } = await fixture();
  try {
    const sessionId = "session-blocked";
    store.save("pilot_session", sessionId, { id: sessionId, title: "s", status: "active", created_at: new Date().toISOString() });
    store.save("pilot_route", "route-1", { id: "route-1", session_id: sessionId, task_id: "task-1",
      queue_state: "running", status: "running", executor_template: "craft", created_at: new Date().toISOString() });
    service.pilotSuspendSession({ session_id: sessionId });
    const queue = service.pilotBlockedQueue() as unknown as { items: Array<{ session_id: string; suspended_reason: string | null }> };
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].session_id, sessionId);
    assert.match(String(queue.items[0].suspended_reason), /3 轮/);
    const resumed = service.pilotResumeSession({ session_id: sessionId }) as unknown as { resumed: number };
    assert.equal(resumed.resumed, 1);
    assert.equal(store.get("pilot_route", "route-1").queue_state, "queued");
    assert.equal((service.pilotBlockedQueue() as unknown as { items: unknown[] }).items.length, 0);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});
