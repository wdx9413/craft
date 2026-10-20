import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { recordSessionVerificationEvidence } from "../deploy/experience-learning/session-verification-evidence.ts";
import type { ExperienceLearningClient } from "../deploy/experience-learning/worker.ts";

const task: JsonObject = { task_id: "task-1", session_id: "session-1", turn_id: "turn-1", project_scope_id: "project:abc", completed_at: "2026-10-20T00:01:00Z" };
const excerpt: JsonObject = { source_ref: `sha256:${"a".repeat(64)}`, verification_artifacts: [{ runner: "javascript", exit_code: 0,
  command_digest: `sha256:${"b".repeat(64)}`, result_digest: `sha256:${"c".repeat(64)}`, content_stored: false }] };

test("records one deterministic sanitized program Evidence and accepts wrapped or direct responses", async () => {
  for (const wrapped of [false, true]) {
    const calls: Array<{ name: string; args: JsonObject }> = [];
    const client: ExperienceLearningClient = { async call(name, args = {}) {
      calls.push({ name, args });
      return wrapped ? { evidence: { id: args.evidence_id } } : { id: args.evidence_id };
    } };
    const result = await recordSessionVerificationEvidence(client, task, excerpt);
    assert(result);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "craft_evidence_record");
    assert.equal(calls[0]!.args.confidence, "confirmed");
    assert.equal((calls[0]!.args.metadata as JsonObject).content_stored, false);
    assert.equal(JSON.stringify(calls[0]!.args).includes("command_digest"), true);
    assert.equal(JSON.stringify(calls[0]!.args).includes("pnpm test"), false);
    assert.equal(result.id, calls[0]!.args.evidence_id);
  }
});

test("does not write Evidence when task provenance or verification artifacts are incomplete", async () => {
  let calls = 0;
  const client: ExperienceLearningClient = { async call() { calls++; return {}; } };
  assert.equal(await recordSessionVerificationEvidence(client, task, { source_ref: excerpt.source_ref, verification_artifacts: [] }), null);
  for (const key of ["task_id", "session_id", "turn_id", "project_scope_id"]) {
    const incomplete = { ...task }; delete incomplete[key];
    assert.equal(await recordSessionVerificationEvidence(client, incomplete, excerpt), null);
  }
  assert.equal(await recordSessionVerificationEvidence(client, task, { verification_artifacts: excerpt.verification_artifacts }), null);
  assert.equal(await recordSessionVerificationEvidence(client, task, { source_ref: excerpt.source_ref, verification_artifacts: "invalid" }), null);
  assert.equal(calls, 0);
});

test("uses deterministic evidence without inventing a timestamp when the source has none", async () => {
  let args: JsonObject | undefined;
  const client: ExperienceLearningClient = { async call(_name, value = {}) { args = value; return { evidence: null, id: value.evidence_id }; } };
  const withoutTimestamp = { ...task }; delete withoutTimestamp.completed_at;
  const saved = await recordSessionVerificationEvidence(client, withoutTimestamp, excerpt);
  assert(saved);
  assert.equal(args?.observed_at, undefined);
});

test("rejects an Evidence response with a different id", async () => {
  const client: ExperienceLearningClient = { async call() { return { id: "wrong-id" }; } };
  await assert.rejects(recordSessionVerificationEvidence(client, task, excerpt), /did not match/u);
});

test("rejects malformed Evidence responses", async () => {
  for (const value of [7, [], { evidence: [] }]) {
    const client: ExperienceLearningClient = { async call() { return value as JsonObject; } };
    await assert.rejects(recordSessionVerificationEvidence(client, task, excerpt), /must be an object/u);
  }
});
