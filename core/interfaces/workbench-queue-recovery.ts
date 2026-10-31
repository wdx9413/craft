import { createHash } from "node:crypto";
import type { CraftStore, JsonObject } from "../infrastructure/store.ts";
import { WorkbenchAgentSessionLinks } from "../application/use-cases/workbench-agent-session-links.ts";

/** Only a dead recorded dispatcher permits recovery of an abandoned claim. */
function dispatcherExited(item: JsonObject): boolean {
  const pid = item.dispatch_owner_pid;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1) return false;
  try { process.kill(Number(pid), 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function nativeAcknowledgement(store: CraftStore, task: string, linkId: string, id: string, link: JsonObject): JsonObject | null {
  const digest = createHash("sha256").update(JSON.stringify([task, linkId, id])).digest("hex");
  const candidates = link.provider === "codex"
    ? [["workbench_agent_session_submission", `agent_send_${digest}`], ["workbench_codex_steer", `codex_steer_${digest}`]]
    : [["workbench_claude_submission", `claude_submit_${digest}`]];
  for (const [kind, markerId] of candidates) {
    const marker = store.find(kind, markerId);
    if (marker?.status === "accepted" && marker.task_id === task && marker.link_id === linkId
      && marker.submission_id === id && marker.native_session_id === link.native_session_id) return { kind, id: markerId, version: marker.version };
  }
  return null;
}

/** Recovery never resends input or changes the native session's turn state. */
export async function reconcileQueueItem(store: CraftStore, task: string, linkId: string, id: string, expectedVersion: unknown, action: unknown): Promise<JsonObject> {
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) throw new Error("expected_version must be a positive integer");
  if (action !== "inspect" && action !== "discard") throw new Error("queue recovery action must be inspect or discard");
  const links = new WorkbenchAgentSessionLinks(store);
  const evaluate = (commit: boolean): JsonObject | null => {
    const link = links.get(task, linkId);
    const item = store.find("workbench_message_queue", id);
    const prior = store.find("workbench_message_queue_receipt", id);
    const status = { session_state: link.turn_state, last_turn_status: link.last_turn_status ?? null };
    if (prior) {
      if (prior.task_id !== task || prior.link_id !== linkId || prior.operation_id !== id || !["sent", "dismissed"].includes(String(prior.state)) || item) throw new Error("queue recovery receipt conflicts with the pending item");
      const outcome = prior.state === "dismissed" ? "discarded" : nativeAcknowledgement(store, task, linkId, id, link) ? "accepted" : "dispatched";
      return { resolved: true, outcome, receipt: prior, idempotent: true, ...status };
    }
    if (!item || item.task_id !== task || item.link_id !== linkId || item.operation_id !== id) throw new Error("queue recovery item does not belong to this session");
    if (item.version !== expectedVersion) throw new Error("queue item changed; refresh before recovery");
    if (item.state !== "dispatching" && item.state !== "unknown") throw new Error("only an uncertain queue item can be reconciled");
    const proof = nativeAcknowledgement(store, task, linkId, id, link);
    const canDiscard = link.turn_state === "idle" && (item.state === "unknown" || dispatcherExited(item));
    if (!proof && action === "inspect") return { resolved: false, outcome: "unknown", manual_discard_allowed: canDiscard, item_id: id, version: item.version, ...status };
    if (!proof && !canDiscard) throw new Error("session or dispatcher is still unsettled; inspect the native session before discarding");
    if (!commit) return null;
    const receipt = store.create("workbench_message_queue_receipt", id, {
      task_id: task, link_id: linkId, operation_id: item.operation_id, sequence: item.sequence,
      state: proof ? "sent" : "dismissed", resolution: proof ? "native_acknowledged" : "user_discarded_unknown",
      resolved_queue_version: item.version, ...(proof ? { native_ack_ref: proof } : {}),
    });
    store.remove("workbench_message_queue", id);
    return { resolved: true, outcome: proof ? "accepted" : "discarded", receipt, idempotent: false, ...status };
  };
  const preview = store.readSnapshot(() => evaluate(false));
  if (preview) return preview;
  return store.transactionWithRetry(() => evaluate(true)!);
}
