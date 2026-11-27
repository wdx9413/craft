import assert from "node:assert/strict";
import test from "node:test";
import { hasUnresolvedTaskCall } from "../deploy/experience-learning/session-knowledge-call-reconciliation.ts";
import type { ExperienceLearningClient } from "../deploy/experience-learning/worker.ts";

const actor = "knowledge-session-candidate-worker", digest = `sha256:${"a".repeat(64)}`;
const request = { trace_id: "trace_existing", operation_id: "task", actor, source: "codex-cli-learning-transport", input_refs: [digest] };
function client(events: unknown): ExperienceLearningClient { return { async call() { return { events }; } }; }

test("task call recovery fails closed for malformed or unbounded history", async () => {
  await assert.rejects(hasUnresolvedTaskCall(client(null), "task", actor, async () => null), /history is unavailable/u);
  await assert.rejects(hasUnresolvedTaskCall(client(Array(10_000).fill(request)), "task", actor, async () => null), /exceeds its bound/u);
  await assert.rejects(hasUnresolvedTaskCall(client([null]), "task", actor, async () => null), /history is invalid/u);
  for (const invalid of [{ ...request, trace_id: "bad" }, { ...request, operation_id: "other" }, { ...request, source: "other" },
    { ...request, input_refs: [] }, { ...request, input_refs: ["bad"] }])
    assert.equal(await hasUnresolvedTaskCall(client([invalid]), "task", actor, async () => true), true);
});

test("task call recovery ignores other workers and blocks until every own request is resolved", async () => {
  assert.equal(await hasUnresolvedTaskCall(client([{ ...request, actor: "other" }]), "task", actor, async () => null), false);
  assert.equal(await hasUnresolvedTaskCall(client([request]), "task", actor, async () => null), true);
  const seen: string[] = [];
  assert.equal(await hasUnresolvedTaskCall(client([request]), "task", actor, async call => { seen.push(call.input_digest); return true; }), false);
  assert.deepEqual(seen, [digest]);
});
