import { randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";

export interface HistoricalReplayCommandService {
  historicalReplayCapture(args: JsonObject): Promise<JsonObject>;
  historicalReplayCleanupPreview(args: JsonObject): JsonObject;
  historicalReplayCleanupApply(args: JsonObject): JsonObject;
}

export type HistoricalReplayOutput = (value: string) => void;

export function historicalReplayContextMembers(args: readonly string[], configuredMembers?: string): string | undefined {
  if (args[0] !== "self-evolution" || args[1] !== "replay") return undefined;
  const members = (configuredMembers ?? "").split(",").map(member => member.trim()).filter(Boolean);
  return [...new Set([...members, "memory", "knowledge", "experience", "notes"])].join(",");
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Explicit CLI controls keep history replay and cleanup outside automatic Hook capture. */
export async function dispatchHistoricalReplayCommand(args: readonly string[], service: HistoricalReplayCommandService,
  write: HistoricalReplayOutput = value => { process.stdout.write(value); }): Promise<void> {
  let result: unknown;
  if (args[2] === "capture") result = await service.historicalReplayCapture({ replay_run_id: option(args, "--run-id") ?? randomUUID() });
  else if (args[2] === "cleanup-preview") {
    const replayRunId = option(args, "--run-id");
    if (!replayRunId) throw new Error("self-evolution replay cleanup-preview requires --run-id");
    result = service.historicalReplayCleanupPreview({ replay_run_id: replayRunId });
  } else if (args[2] === "cleanup-apply") {
    const replayRunId = option(args, "--run-id"), manifestDigest = option(args, "--manifest-digest");
    if (!replayRunId || !manifestDigest) throw new Error("self-evolution replay cleanup-apply requires --run-id and --manifest-digest");
    result = service.historicalReplayCleanupApply({ replay_run_id: replayRunId, expected_manifest_digest: manifestDigest });
  } else throw new Error("self-evolution replay requires capture, cleanup-preview, or cleanup-apply");
  write(`${JSON.stringify(result, null, 2)}\n`);
}
