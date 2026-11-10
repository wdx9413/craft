import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { digestJson, payload } from "./digest.ts";
import { text } from "./validation.ts";

export function assertTaskAssignmentOwner(store: CraftStore, taskId: string, actor: unknown): void {
  const assignment = store.find("task_assignment", `task_assignment_${taskId}`);
  if (assignment?.status === "active" && assignment.owner !== actor) throw new Error("Task has an active owner; only that owner may continue or transfer its responsibility");
}

/** Operator coordination only: claiming never starts work or grants execution rights. */
export function updateTaskAssignment(store: CraftStore, args: JsonObject, observe: (runId: string) => JsonObject): JsonObject {
  const requestId = text(args.request_id, "request_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestId)) throw new Error("request_id must be a safe identifier of at most 128 characters");
  const actor = text(args.actor, "actor");
  const action = text(args.action, "action");
  if (!["claim", "release", "transfer"].includes(action)) throw new Error("Assignment action is unsupported");
  const reason = text(args.reason, "reason");
  const runId = text(args.task_run_id, "task_run_id");
  const recipient = action === "transfer" ? text(args.recipient, "recipient") : null;
  if (recipient === actor) throw new Error("Transfer requires a different recipient");
  if (!Number.isSafeInteger(args.assignment_version) || Number(args.assignment_version) < 0) throw new Error("assignment_version must be a non-negative integer");
  const identity = { task_run_id: runId, action, actor, recipient, reason, assignment_version: args.assignment_version, handoff_id: args.handoff_id ?? null, handoff_version: args.handoff_version ?? null };
  const requestDigest = digestJson(identity);
  return store.transaction(() => {
    const receiptId = `task_assignment_action_${requestId}`;
    const replay = store.find("task_assignment_action", receiptId);
    if (replay) {
      if (replay.request_digest !== requestDigest) throw new Error("Task assignment idempotency conflict");
      return { receipt: replay, assignment: store.get("task_assignment", String(replay.assignment_id)), idempotent: true };
    }
    const run = store.get("task_run", runId);
    const launch = store.get("work_launch", String(run.launch_id));
    const taskId = String(launch.task_id);
    const assignmentId = `task_assignment_${taskId}`;
    const previous = store.find("task_assignment", assignmentId);
    if ((previous?.version ?? 0) !== args.assignment_version) throw new Error("Task assignment version changed; refresh before continuing");
    if (action === "claim") {
      if (previous?.status === "active") throw new Error("Task already has an active owner");
    } else if (previous?.status !== "active" || previous.owner !== actor) throw new Error("Only the active owner may release or transfer this task");
    let handoff: JsonObject | null = null;
    if (action !== "release") {
      handoff = store.get("task_run_handoff", text(args.handoff_id, "handoff_id"));
      if (!Number.isSafeInteger(args.handoff_version) || handoff.version !== args.handoff_version || handoff.task_run_id !== runId) throw new Error("Handoff version or Task Run does not match");
      const state = observe(runId);
      const task = store.get("task", taskId);
      if (run.lifecycle === "cancelled" || handoff.task_run_version !== run.version || handoff.state_id !== state.id || handoff.state_version !== state.version || (handoff.task_ref as JsonObject | undefined)?.version !== task.version) throw new Error("Handoff is stale; generate a current snapshot");
      if (digestJson(handoff.assignment_ref ?? null) !== digestJson(previous ? { id: previous.id, version: previous.version, owner: previous.owner } : null)) throw new Error("Handoff assignment is stale; generate a current snapshot");
      if (state.actor !== "human") throw new Error("Host work is still active; pause or wait before assigning responsibility");
    }
    const data = { task_id: taskId, task_run_id: runId, owner: action === "claim" ? actor : action === "transfer" ? recipient : previous!.owner, status: action === "release" ? "released" : "active", actor, reason, handoff_id: handoff?.id ?? previous!.handoff_id, handoff_version: handoff?.version ?? previous!.handoff_version, updated_reason: action };
    const assignment = previous ? store.save("task_assignment", assignmentId, { ...payload(previous), ...data }) : store.create("task_assignment", assignmentId, data);
    const receipt = store.create("task_assignment_action", receiptId, { ...identity, task_id: taskId, assignment_id: assignment.id, assignment_version: assignment.version, request_digest: requestDigest });
    store.appendEvent(`task:${taskId}`, `task.assignment_${action}`, { assignment_id: assignment.id, assignment_version: assignment.version, actor, owner: assignment.owner, handoff_id: assignment.handoff_id });
    return { assignment, receipt, idempotent: false };
  });
}
