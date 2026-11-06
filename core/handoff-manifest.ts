import { randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text, uniqueList } from "./validation.ts";
import { digestJson } from "./digest.ts";


/** Host-neutral handoff manifests preserve context, permissions and outcome references. */
export class HandoffManifestKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  create(args: JsonObject): JsonObject {
    const handoffId = String(args.handoff_id ?? `handoff_manifest_${randomUUID().replaceAll("-", "")}`); const identity = { task_id: text(args.task_id, "task_id"), session_id: args.session_id === undefined ? null : text(args.session_id, "session_id"), context_manifest_id: text(args.context_manifest_id, "context_manifest_id"), host: text(args.host, "host"), model: args.model === undefined ? null : text(args.model, "model"), allowed_effects: uniqueList(args.allowed_effects, "allowed_effects"), artifact_ids: uniqueList(args.artifact_ids, "artifact_ids"), evidence_ids: uniqueList(args.evidence_ids, "evidence_ids"), outcome_id: args.outcome_id === undefined ? null : text(args.outcome_id, "outcome_id") };
    const handoffDigest = digestJson(identity); const existing = this.store.find("handoff_manifest", handoffId); if (existing) { if (existing.handoff_digest !== handoffDigest) throw new Error("Handoff Manifest idempotency conflict"); return { handoff: existing, idempotent: true }; }
    return { handoff: this.store.create("handoff_manifest", handoffId, { ...identity, handoff_digest: handoffDigest, status: "ready" }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { handoff: this.store.get("handoff_manifest", text(args.handoff_id, "handoff_id")) }; }
}
