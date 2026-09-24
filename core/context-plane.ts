import { randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text, uniqueList } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";


const MANIFEST_FIELDS = ["knowledge_refs", "capability_refs", "workflow_refs", "excluded_refs"] as const;

/** Unified, digest-pinned context plane for one Work Session. */
export class ContextPlaneKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  save(args: JsonObject): JsonObject {
    const projectId = text(args.project_id, "project_id");
    const taskId = text(args.task_id, "task_id");
    const manifestId = String(args.manifest_id ?? `context_manifest_${randomUUID().replaceAll("-", "")}`);
    const refs = Object.fromEntries(MANIFEST_FIELDS.map((field) => [field, uniqueList(args[field], field)]));
    const identity = { project_id: projectId, task_id: taskId, knowledge_refs: refs.knowledge_refs, capability_refs: refs.capability_refs,
      workflow_refs: refs.workflow_refs, excluded_refs: refs.excluded_refs, model: args.model === undefined ? null : text(args.model, "model"),
      host: args.host === undefined ? null : text(args.host, "host"), acceptance_ref: args.acceptance_ref === undefined ? null : text(args.acceptance_ref, "acceptance_ref"),
      selection_rationale: args.selection_rationale === undefined ? null : text(args.selection_rationale, "selection_rationale") };
    const identityDigest = digestJson(identity);
    const existing = this.store.find("context_manifest", manifestId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Context Manifest idempotency conflict");
      return { manifest: existing, idempotent: true };
    }
    return { manifest: this.store.create("context_manifest", manifestId, { ...identity, identity_digest: identityDigest, status: "pinned" }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { manifest: this.store.get("context_manifest", text(args.manifest_id, "manifest_id")) }; }

  audit(args: JsonObject): JsonObject {
    const manifest = this.store.get("context_manifest", text(args.manifest_id, "manifest_id"));
    const expected = args.expected_digest === undefined ? String(manifest.identity_digest) : text(args.expected_digest, "expected_digest");
    const drifted = expected !== String(manifest.identity_digest);
    const status = drifted ? "needs_replan" : "ready";
    const saved = drifted && manifest.status !== status
      ? this.store.save("context_manifest", String(manifest.id), { ...payload(manifest), status }) : manifest;
    return { manifest: saved, status, drifted, revalidation_digest: manifest.identity_digest };
  }
}
