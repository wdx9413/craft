import { randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson } from "./digest.ts";

function positive(value: unknown, name: string, fallback: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return result;
}

/** Portable, digest-verified Project Bundle for backup, migration and handoff. */
export class ProjectBundleKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  export(args: JsonObject): JsonObject {
    const projectId = text(args.project_id, "project_id"); const max = positive(args.limit, "limit", 5000, 20_000);
    const kinds = ["project_brain", "project_goal", "project_decision", "project_material", "project_outcome", "project_experience", "task", "work_session", "context_manifest", "trace", "artifact", "evidence"];
    const records = kinds.flatMap((kind) => this.store.list(kind, max, (item) => item.project_id === projectId || item.task_id === projectId || item.workspace_id === projectId));
    const identity = { format: "craft.project-bundle", schema: 1, project_id: projectId, records: records.map((record) => ({ kind: "project_record", ref: `${record.id}@${record.version}`, digest: digestJson(record) })) };
    const bundle = { ...identity, exported_at: args.exported_at === undefined ? new Date().toISOString() : text(args.exported_at, "exported_at") };
    const id = String(args.bundle_id ?? `project_bundle_${randomUUID().replaceAll("-", "")}`);
    const existing = this.store.find("project_bundle", id);
    if (existing) { if (existing.bundle_digest !== digestJson(identity)) throw new Error("Project Bundle idempotency conflict"); return { bundle: existing, idempotent: true }; }
    return { bundle: this.store.create("project_bundle", id, { ...bundle, bundle_digest: digestJson(identity), portable: true }), idempotent: false };
  }

  verify(args: JsonObject): JsonObject {
    const bundle = this.store.get("project_bundle", text(args.bundle_id, "bundle_id"));
    const expected = digestJson({ format: bundle.format, schema: bundle.schema, project_id: bundle.project_id, records: bundle.records });
    return { bundle, valid: expected === bundle.bundle_digest, expected_digest: expected };
  }
}
