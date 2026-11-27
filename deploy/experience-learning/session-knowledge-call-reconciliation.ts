import type { JsonObject } from "../../core/infrastructure/store.ts";
import type { ExperienceLearningClient } from "./worker.ts";

/** Durable Trace requests guard a task even when volatile state or its input digest changes. */
export async function hasUnresolvedTaskCall(client: ExperienceLearningClient, taskId: string, actor: string,
  resolved: (call: { trace_id: string; input_digest: string }) => Promise<unknown>): Promise<boolean> {
  const result = await client.call("craft_trace_query", { task_id: `knowledge:${taskId}`, event_kind: "model.request", limit: 10_000 });
  if (!Array.isArray(result.events) || result.events.length >= 10_000) throw new Error("Knowledge task call history is unavailable or exceeds its bound");
  for (const raw of result.events) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Knowledge task call history is invalid");
    const event = raw as JsonObject;
    if (event.actor !== actor) continue;
    if (event.operation_id !== taskId || event.source !== "codex-cli-learning-transport" || typeof event.trace_id !== "string"
      || !/^trace[-_][A-Za-z0-9_-]{1,160}$/u.test(event.trace_id) || !Array.isArray(event.input_refs) || event.input_refs.length !== 1
      || typeof event.input_refs[0] !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(event.input_refs[0])) return true;
    if (!await resolved({ trace_id: event.trace_id, input_digest: event.input_refs[0] })) return true;
  }
  return false;
}
