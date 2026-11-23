import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCapture } from "@craft/capability-memory/memory-capture";
import { CognitiveWriteCoordinator } from "../core/application/coordinators/cognitive-write.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

test("historical replay Memory coordinator forwards capture and cleanup requests to MemoryCapture", t => {
  const calls: Array<{ operation: string; args: JsonObject }> = [];
  const prototype = MemoryCapture.prototype as unknown as Record<string, unknown>;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, operation, result] of [
    ["captureHistoricalReplayCandidate", "capture", { status: "candidate" }],
    ["historicalReplayCleanupPreview", "preview", { manifest_digest: "preview" }],
    ["historicalReplayCleanupApply", "apply", { status: "cleaned" }],
  ] as const) {
    originals.set(name, Object.getOwnPropertyDescriptor(prototype, name));
    Object.defineProperty(prototype, name, { configurable: true, value(args: JsonObject) { calls.push({ operation, args }); return result; } });
  }
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else delete prototype[name];
    }
  });

  const args = { replay_run_id: "memory-run-0001", expected_manifest_digest: "digest" };
  const coordinator = new CognitiveWriteCoordinator({} as never, { installBuiltins: () => ({}) } as never,
    {} as never, () => ({}), () => ({}), () => ({}));
  assert.deepEqual(coordinator.captureHistoricalReplayCandidate(args), { status: "candidate" });
  assert.deepEqual(coordinator.historicalReplayCleanupPreview(args), { manifest_digest: "preview" });
  assert.deepEqual(coordinator.historicalReplayCleanupApply(args), { status: "cleaned" });
  assert.deepEqual(calls, [
    { operation: "capture", args }, { operation: "preview", args }, { operation: "apply", args },
  ]);
});
