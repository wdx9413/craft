import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "./infrastructure/store.ts";

/** A lock record does not by itself prove that its owner is alive. */
export function learningWorkerDiagnostic(runtimeDir: string, component: "knowledge" | "experience", runtimeVersion: string): JsonObject {
  try {
    const path = join(runtimeDir, `learning-worker-${component}.lock.json`), stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) return { status: "unavailable" };
    const value = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    if (!value || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || typeof value.owner_id !== "string" || !value.owner_id) return { status: "unavailable" };
    const version = typeof value.runtime_version === "string" && /^\d+\.\d+\.\d+$/u.test(value.runtime_version) ? value.runtime_version : null;
    return { status: "owner_recorded", owner_pid: value.pid, owner_version: version,
      version_relation: version === null ? "unknown" : version === runtimeVersion ? "same" : "different", liveness: "unverified" };
  } catch (error) { return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_observed" : "unavailable" }; }
}
