import { type CraftStore, type JsonObject } from "./infrastructure/store.ts";

export interface CraftNotesMigrationResult { scanned: number; migrated: number; skipped: number; }

/** Idempotently project legacy directory records into Craft Notes without reading any referenced path. */
export function migrateFileDirDescNotes(store: CraftStore): CraftNotesMigrationResult {
  let migrated = 0, skipped = 0;
  const legacy = store.list("file_dir_desc", Number.MAX_SAFE_INTEGER);
  for (const row of legacy) {
    const id = String(row.id);
    if (store.find("craft_note", id)) { skipped++; continue; }
    const deviceId = String(row.device_id ?? "local");
    const path = String(row.path ?? "");
    if (!path) { skipped++; continue; }
    const status = row.status === "revoked" ? "revoked" : row.status === "promoted" ? "legacy_unreviewed" : "candidate";
    const now = new Date().toISOString();
    const payload: JsonObject = {
      id, subject_type: "directory", subject_key: `${deviceId}:${path}`, device_id: deviceId,
      text: String(row.description ?? path), status, version: 1, evidence_refs: Array.isArray(row.evidence_refs) ? row.evidence_refs : [],
      verified_at: status === "legacy_unreviewed" ? String(row.updated_at ?? now) : null,
      created_at: String(row.created_at ?? now), updated_at: now,
      legacy_source: "file_dir_desc", legacy_status: String(row.status ?? "observed"), legacy_use_count: Number(row.use_count ?? 0),
    };
    store.save("craft_note", id, payload);
    migrated++;
  }
  return { scanned: legacy.length, migrated, skipped };
}
