import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";

/** Inventory published pointers only. No content, trust label or business scope is changed. */
export function projectDataInventory(store: CraftStore, identity: JsonObject, args: JsonObject): JsonObject {
  if (typeof args.migration_id !== "string" || !args.migration_id) throw new Error("registry migration_id is required");
  const limit = args.limit === undefined ? 50 : args.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error("inventory limit must be 1..100");
  return store.readSnapshot(database => {
    const migration = store.get("project_registry_migration", args.migration_id as string);
    if (migration.state !== "applied" || migration.project_root !== identity.local_path_alias
      || stableDigest(migration.canonical_scope) !== stableDigest(identity.canonical_scope)) throw new Error("inventory requires an applied registry migration for this exact project");
    const binding = stableDigest(migration);
    let after = ["", ""];
    if (args.cursor !== undefined) {
      try {
        if (typeof args.cursor !== "string" || args.cursor.length > 4096) throw new Error("invalid");
        const cursor = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8"));
        if (cursor.binding !== binding || !Array.isArray(cursor.after) || cursor.after.length !== 2 || cursor.after.some((value: unknown) => typeof value !== "string" || value.length > 1024)) throw new Error("invalid");
        after = cursor.after;
      } catch { throw new Error("inventory cursor is invalid or belongs to a changed migration"); }
    }
    const legacy = String(migration.legacy_scope_id);
    const ids = [...new Set([legacy, legacy.startsWith("project:") ? legacy.slice(8) : `project:${legacy}`])];
    const scope = "json_extract(r.payload_json,'$.scope')";
    const textKind = `CASE WHEN json_type(r.payload_json,'$.scope')='text' THEN CASE WHEN instr(${scope},':')>0 THEN substr(${scope},1,instr(${scope},':')-1) ELSE ${scope} END END`;
    const textId = `CASE WHEN json_type(r.payload_json,'$.scope')='text' AND instr(${scope},':')>0 THEN substr(${scope},instr(${scope},':')+1) END`;
    const hasScope = "json_type(r.payload_json,'$.scope') IS NOT NULL AND json_type(r.payload_json,'$.scope')!='null'";
    // Choose one declaration as a pair. A malformed explicit scope must never
    // borrow its missing kind/id from a looser project hint.
    const ownerKind = `CASE WHEN ${hasScope} THEN CASE WHEN json_type(r.payload_json,'$.scope')='object' THEN json_extract(r.payload_json,'$.scope.kind') ELSE ${textKind} END
      WHEN json_extract(r.payload_json,'$.scope_kind') IS NOT NULL THEN json_extract(r.payload_json,'$.scope_kind')
      WHEN json_type(r.payload_json,'$.project_scope_id')='text' OR json_type(r.payload_json,'$.project_id')='text' THEN 'project' END`;
    const ownerId = `CASE WHEN ${hasScope} THEN CASE WHEN json_type(r.payload_json,'$.scope')='object' THEN json_extract(r.payload_json,'$.scope.id') ELSE ${textId} END
      WHEN json_extract(r.payload_json,'$.scope_kind') IS NOT NULL THEN json_extract(r.payload_json,'$.scope_id')
      WHEN json_type(r.payload_json,'$.project_scope_id')='text' THEN json_extract(r.payload_json,'$.project_scope_id') ELSE json_extract(r.payload_json,'$.project_id') END`;
    const rows = database.prepare(`SELECT r.kind,r.id,r.version,length(CAST(r.payload_json AS BLOB)) bytes,
      CASE WHEN length(CAST(r.payload_json AS BLOB))<=1048576 THEN r.payload_json END snapshot
      FROM records r JOIN (SELECT kind,id,MAX(version) version FROM records GROUP BY kind,id) latest
      ON latest.kind=r.kind AND latest.id=r.id AND latest.version=r.version
      WHERE r.kind NOT IN ('scope_alias','project_identity','project_registry_migration')
      AND ${ownerKind}='project' AND ${ownerId} IN (${ids.map(() => "?").join(",")})
      AND (r.kind>? OR (r.kind=? AND r.id>?)) ORDER BY r.kind,r.id LIMIT ?`)
      .iterate(...ids, after[0], after[0], after[1], Number(limit) + 1);
    const records: JsonObject[] = [];
    let more = false;
    // Stream metadata so a full page cannot retain 100 one-MiB JSON bodies.
    for (const raw of rows) {
      if (records.length === limit) { more = true; break; }
      const row = raw as { kind: string; id: string; version: number; bytes: number; snapshot: string | null };
      const payload = row.snapshot === null ? null : JSON.parse(row.snapshot) as JsonObject;
      const domains = ["memory", "knowledge", "experience", "evolution", "context"].filter(domain => payload?.[`_${domain}_partition`] !== undefined);
      const domain = domains.length === 1 ? domains[0] : /^codebase_/.test(row.kind) ? "codebase" : "unclassified";
      records.push({ kind: row.kind, id: row.id, version: Number(row.version), metadata_bytes: Number(row.bytes), domain,
        pointer_digest: payload === null ? null : stableDigest(payload),
        binding: domains.length > 1 ? "ambiguous_partition_pointer" : domains.length ? "published_partition_pointer" : "central_record",
        disposition: payload === null ? "metadata_exceeds_inventory_budget" : domain === "unclassified" ? "requires_typed_recipe" : domain === "codebase" ? "reindex_required" : "requires_business_provenance_review" });
    }
    const last = records.at(-1);
    return { schema: "craft.project-data-inventory.v1", migration_id: migration.id, migration_digest: binding,
      project_root: identity.local_path_alias, legacy_scope_ids: ids, canonical_scope: identity.canonical_scope,
      records, has_more: more, next_cursor: more ? Buffer.from(JSON.stringify({ binding, after: [last!.kind, last!.id] })).toString("base64url") : null,
      page_digest: stableDigest({ binding, records }), snapshot_scope: "page_only", raw_content_stored: false,
      coverage: "published_central_records_only", partition_content_verified: false,
      data_migrated: false, automatic_apply_allowed: false };
  });
}
