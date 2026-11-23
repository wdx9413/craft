import assert from "node:assert/strict";
import test from "node:test";
import { dispatchHistoricalReplayCommand, historicalReplayContextMembers, type HistoricalReplayCommandService } from "../core/historical-replay-cli.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

function service(calls: Array<{ operation: string; args: JsonObject }>): HistoricalReplayCommandService {
  return {
    historicalReplayCapture: async args => { calls.push({ operation: "capture", args }); return { status: "completed" }; },
    historicalReplayCleanupPreview: args => { calls.push({ operation: "preview", args }); return { manifest_digest: "digest" }; },
    historicalReplayCleanupApply: args => { calls.push({ operation: "apply", args }); return { status: "cleaned" }; },
  };
}

test("historical replay loads every owner while preserving configured Context members", () => {
  assert.equal(historicalReplayContextMembers(["self-evolution", "replay", "capture"]), "memory,knowledge,experience,notes");
  assert.equal(historicalReplayContextMembers(["self-evolution", "replay"], "eval, memory,notes,memory"), "eval,memory,notes,knowledge,experience");
  assert.equal(historicalReplayContextMembers(["self-evolution", "status"], "memory"), undefined);
});

test("historical replay CLI routes capture, preview, and digest-bound cleanup", async () => {
  const calls: Array<{ operation: string; args: JsonObject }> = [], output: string[] = [];
  const target = service(calls);
  await dispatchHistoricalReplayCommand(["self-evolution", "replay", "capture", "--run-id", "run-explicit"], target, value => output.push(value));
  await dispatchHistoricalReplayCommand(["self-evolution", "replay", "cleanup-preview", "--run-id", "run-explicit"], target, value => output.push(value));
  await dispatchHistoricalReplayCommand(["self-evolution", "replay", "cleanup-apply", "--run-id", "run-explicit", "--manifest-digest", "sha256:abc"], target, value => output.push(value));
  assert.deepEqual(calls.map(call => call.operation), ["capture", "preview", "apply"]);
  assert.equal(calls[0]?.args.replay_run_id, "run-explicit");
  assert.equal(calls[2]?.args.expected_manifest_digest, "sha256:abc");
  assert.equal(JSON.parse(output[1]!).manifest_digest, "digest");
});

test("historical replay CLI generates a run id and rejects incomplete cleanup or unknown actions", async () => {
  const calls: Array<{ operation: string; args: JsonObject }> = [], output: string[] = [];
  await dispatchHistoricalReplayCommand(["self-evolution", "replay", "capture"], service(calls), value => output.push(value));
  assert.match(String(calls[0]?.args.replay_run_id), /^[0-9a-f-]{36}$/u);
  await assert.rejects(dispatchHistoricalReplayCommand(["self-evolution", "replay", "cleanup-preview"], service(calls), () => {}), /requires --run-id/u);
  await assert.rejects(dispatchHistoricalReplayCommand(["self-evolution", "replay", "cleanup-apply", "--run-id", "run-explicit"], service(calls), () => {}), /requires --run-id and --manifest-digest/u);
  await assert.rejects(dispatchHistoricalReplayCommand(["self-evolution", "replay", "unknown"], service(calls), () => {}), /requires capture/u);
});
