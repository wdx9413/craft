import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { checkedExperiencePath, experienceGraphDirectory, ProcedureDefinitionStore, procedureDefinitionRef } from "./procedure-definition.ts";

import { activeProcedure, updateProcedureRelease } from "./procedure-release.ts";

/** Recoverable two-field view of the ledger. Hand editing never activates a version. */
export function syncGraphVersionManifest(store: CraftStore, id: string): JsonObject {
  try {
    return store.transaction(() => {
      const record = store.find("experience_procedure", id), ref = record?.definition_ref;
      const version = procedureDefinitionRef(ref) ? new ProcedureDefinitionStore(store.paths).read(ref).procedure_version : null;
      if (record) updateProcedureRelease(store, record);
      const active = record ? activeProcedure(store, id) : null;
      const currentVersion = active && procedureDefinitionRef(active.definition_ref) ? new ProcedureDefinitionStore(store.paths).read(active.definition_ref).procedure_version : null;
      const versions = { current_version: currentVersion, test_version: version === currentVersion ? null : version };
      const path = checkedExperiencePath(store.paths, join(experienceGraphDirectory(store.paths, id), "graph.yml"), true);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `current_version: ${versions.current_version}\ntest_version: ${versions.test_version}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
      return { ...versions, manifest_path: path, manifest_status: "ready" };
    });
  } catch (error) {
    // The committed asset stays authoritative when a derived file cannot be refreshed.
    return { manifest_status: "unavailable", manifest_error_type: error instanceof Error ? error.name : "unknown" };
  }
}
