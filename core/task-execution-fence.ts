import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { digestJson } from "./digest.ts";
import { workRetryPolicy } from "./work-retry-policy.ts";

export function executionRootActive(store: CraftStore, launch: JsonObject): boolean {
  const fence = store.find("task_execution_fence", `task_execution_fence_${launch.task_id}`);
  return !fence || fence.active_root_launch_id === workRetryPolicy(store, launch).root_launch_id;
}
export function assertExecutionRootActive(store: CraftStore, launch: JsonObject): void {
  if (!executionRootActive(store, launch)) throw new Error("Execution plan was superseded; continue its approved successor");
}
export function guardNewExecutionRoot(store: CraftStore, taskId: string, launchId: string, args: JsonObject): void {
  const fence = store.find("task_execution_fence", `task_execution_fence_${taskId}`);
  if (!fence) return;
  if (args.retry_of !== undefined) { assertExecutionRootActive(store, store.get("work_launch", String(args.retry_of))); return; }
  const permit = store.find("task_replan_execution_permit", launchId);
  if (!permit || permit.status !== "preparing" || permit.task_id !== taskId || permit.argument_digest !== digestJson(args)) throw new Error("Task requires an evidence-backed replan approval before another root execution");
}
export function registerExecutionFence(store: CraftStore, launch: JsonObject, bounded: boolean): void {
  if (!bounded && launch.retry_of == null) return;
  const id = `task_execution_fence_${launch.task_id}`;
  if (!store.find("task_execution_fence", id)) store.create("task_execution_fence", id, { task_id: launch.task_id, active_root_launch_id: workRetryPolicy(store, launch).root_launch_id, generation: 1 });
}
