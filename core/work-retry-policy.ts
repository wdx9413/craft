import { CraftStore, type JsonObject } from "./infrastructure/store.ts";

/** Count committed attempts from persisted ancestry, never a caller-supplied counter. */
export function workRetryPolicy(store: CraftStore, launch: JsonObject): JsonObject {
  const visited = new Set<string>();
  let current = launch;
  let retries = 0;
  while (true) {
    const id = String(current.id);
    if (visited.has(id) || visited.size >= 1000) throw new Error("Work retry ancestry is cyclic or exceeds its safety bound");
    visited.add(id);
    if (current.task_id !== launch.task_id) throw new Error("Work retry ancestry crosses task ownership");
    if (current.retry_of == null) return { root_launch_id: current.id, retries_used: retries, max_retries: 3, exhausted: retries >= 3 };
    current = store.get("work_launch", String(current.retry_of));
    retries++;
  }
}
