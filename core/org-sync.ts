import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson } from "./digest.ts";

function array(value: unknown, name: string): string[] { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); return value.map((item) => text(item, name)); }
export class OrgSyncKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  prepare(args: JsonObject): JsonObject { const workspaceId = text(args.workspace_id, "workspace_id"); const memberIds = array(args.member_ids ?? [], "member_ids"); const recordRefs = array(args.record_refs ?? [], "record_refs"); const manifest = { workspace_id: workspaceId, member_ids: memberIds, record_refs: recordRefs, encryption: "adapter_managed", deletion_tombstones: true }; const manifestDigest = digestJson(manifest); const syncId = String(args.sync_id ?? `org_sync_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("org_sync_manifest", syncId); if (existing) { if (existing.manifest_digest !== manifestDigest) throw new Error("Organization sync manifest conflict"); return { manifest: existing, idempotent: true }; } return { manifest: this.store.create("org_sync_manifest", syncId, { ...manifest, manifest_digest: manifestDigest, status: "prepared" }), idempotent: false }; }
  apply(args: JsonObject): JsonObject { const manifest = this.store.get("org_sync_manifest", text(args.sync_id, "sync_id")); const baseDigest = text(args.base_digest, "base_digest"); const currentDigest = args.current_digest === undefined ? manifest.manifest_digest : text(args.current_digest, "current_digest"); if (currentDigest !== baseDigest) return { status: "conflict", conflict: { expected: baseDigest, actual: currentDigest }, idempotent: false }; const applied = this.store.save("org_sync_manifest", String(manifest.id), { ...manifest, status: "applied", applied_at: new Date().toISOString(), tombstone_digest: digestJson(args.tombstones ?? []) }); return { status: "applied", manifest: applied, idempotent: false }; }
}
