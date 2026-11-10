import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { digestJson } from "./digest.ts";

export function resolveWorkbenchApprovalPrompt(store: Pick<CraftStore, "get">, launch: JsonObject, expectedDispatchKind: string): string {
  const task = store.get("task", String(launch.task_id));
  const goal = typeof task.goal === "string" ? task.goal : "";
  if (!goal || digestJson(goal) !== launch.prompt_digest) throw new Error("Task goal no longer matches the prepared instruction; prepare a new Work Launch");
  if (expectedDispatchKind !== launch.dispatch_kind) throw new Error("Work Launch dispatch identity changed; prepare a new Work Launch");
  const dispatch = store.get(expectedDispatchKind, String(launch.dispatch_id));
  if (String(dispatch.id) !== String(launch.dispatch_id) || dispatch.task_id !== task.id || dispatch.task_version !== task.version ||
      dispatch.workspace !== launch.workspace || dispatch.sandbox !== launch.sandbox || dispatch.prompt_digest !== launch.prompt_digest) {
    throw new Error("Work Launch dispatch identity changed; prepare a new Work Launch");
  }
  return goal;
}
