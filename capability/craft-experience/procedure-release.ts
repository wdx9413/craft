import { realpathSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import { text } from "../../common/craft-common-base/src/validation.ts";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { payload } from "../../common/craft-common-base/src/digest.ts";

/** Publication is independent of the newest candidate. Pointers always pin a qualified record. */
export function preserveProcedureRelease(store: CraftStore, current: JsonObject | null): void {
  if (current?.routeable !== true || current.lifecycle !== "routeable") return;
  const existing = store.find("experience_release", String(current.id));
  if (existing?.record_version === current.version) return;
  store.save("experience_release", String(current.id), { record_version: current.version, definition_digest: current.definition_digest, status: "active" });
}

export function activeProcedure(store: CraftStore, id: string): JsonObject | null {
  const latest = store.get("experience_procedure", id);
  if (latest.routeable === true && latest.lifecycle === "routeable") return latest;
  const release = store.find("experience_release", id);
  if (!release || release.status !== "active") return null;
  const active = store.get("experience_procedure", id, Number(release.record_version));
  // Failure of this same asset revokes it; a different candidate cannot displace it.
  if (latest.definition_digest === active.definition_digest) return null;
  return { ...active, scope_envelope: latest.scope_envelope };
}

export function updateProcedureRelease(store: CraftStore, latest: JsonObject): void {
  if (latest.routeable === true && latest.lifecycle === "routeable") { preserveProcedureRelease(store, latest); return; }
  const release = store.find("experience_release", String(latest.id));
  if (release && release.definition_digest === latest.definition_digest && ["rejected", "rolled_back"].includes(String(latest.lifecycle)) && release.status !== "revoked")
    store.save("experience_release", String(latest.id), { ...payload(release), status: "revoked" });
}

export function selectedProcedure(store: CraftStore, id: string, channel: unknown): JsonObject | null {
  if (channel === undefined || channel === "current") return activeProcedure(store, id);
  if (channel !== "test") throw new Error("Unsupported Procedure release_channel");
  const candidate = store.get("experience_procedure", id);
  return candidate.lifecycle === "candidate" ? candidate : null;
}

/** Writable candidates require a separate, checkpointed workspace owned by the test Work Loop. */
export function assertProcedureTestIsolation(store: CraftStore, args: JsonObject, actualWorkspaceId?: unknown): void {
  const testId = text(args.test_workspace_id, "test_workspace_id"), baselineId = text(args.baseline_workspace_id, "baseline_workspace_id");
  if (testId === baselineId || actualWorkspaceId !== undefined && actualWorkspaceId !== testId) throw new Error("Test workspace isolation mismatch");
  const test = store.get("workspace", testId), baseline = store.get("workspace", baselineId);
  const testRoot = realpathSync(String(test.root_path)), baselineRoot = realpathSync(String(baseline.root_path));
  const separate = (a: string, b: string) => { const delta = relative(a, b); return isAbsolute(delta) || delta === ".." || delta.startsWith(`..${sep}`); };
  if (!separate(testRoot, baselineRoot) || !separate(baselineRoot, testRoot) || !test.latest_checkpoint_id || !baseline.latest_checkpoint_id) throw new Error("Test workspaces must be disjoint and checkpointed");
}
