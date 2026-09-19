import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";

export class MemoryConsolidationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  remember(args: JsonObject): JsonObject {
    const memoryId = String(args.memory_id ?? `memory_${randomUUID().replaceAll("-", "")}`);
    const scope = text(args.scope ?? "task", "scope");
    const content = text(args.content, "content");
    const source = text(args.source ?? "work", "source");
    const existing = this.store.find("episodic_memory", memoryId);
    const identityDigest = digestJson({ scope, content, source, task_id: args.task_id ?? null });
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Memory idempotency conflict");
      return { memory: existing, idempotent: true };
    }
    return { memory: this.store.create("episodic_memory", memoryId, { scope, content, source, task_id: args.task_id ?? null, identity_digest: identityDigest, consolidated: false, confidence: Number(args.confidence ?? 0.5) }), idempotent: false };
  }

  consolidate(args: JsonObject): JsonObject {
    const memoryIds = Array.isArray(args.memory_ids) ? args.memory_ids.map((item) => text(item, "memory_ids")) : [];
    if (!memoryIds.length) throw new Error("memory_ids must contain at least one id");
    const memories = memoryIds.map((memoryId) => this.store.get("episodic_memory", memoryId));
    const scope = text(args.scope ?? memories[0]!.scope, "scope");
    const content = text(args.content ?? memories.map((memory) => String(memory.content)).join("\n"), "content");
    const semanticId = String(args.semantic_id ?? `semantic_memory_${randomUUID().replaceAll("-", "")}`);
    const identityDigest = digestJson({ scope, content, memory_ids: memoryIds });
    const existing = this.store.find("semantic_memory", semanticId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Semantic memory idempotency conflict");
      return { memory: existing, idempotent: true };
    }
    for (const memory of memories) this.store.save("episodic_memory", String(memory.id), { ...payload(memory), consolidated: true, consolidated_into: semanticId });
    return { memory: this.store.create("semantic_memory", semanticId, { scope, content, memory_ids: memoryIds, identity_digest: identityDigest, confidence: Number(args.confidence ?? 0.8), status: "active" }), idempotent: false };
  }

  resolve(args: JsonObject): JsonObject {
    const semantic = this.store.get("semantic_memory", text(args.semantic_id, "semantic_id"));
    const status = text(args.status, "status");
    if (!(new Set(["active", "superseded", "rejected"]).has(status))) throw new Error("Unsupported semantic memory status");
    return { memory: this.store.save("semantic_memory", String(semantic.id), { ...payload(semantic), status, resolution: text(args.resolution ?? status, "resolution") }), idempotent: false };
  }

  search(args: JsonObject): JsonObject {
    const query = text(args.query, "query").toLowerCase();
    const scope = args.scope === undefined ? null : text(args.scope, "scope");
    const memories = this.store.list("semantic_memory", 10_000, (item) => item.status === "active" && (scope === null || item.scope === scope));
    const results = memories.filter((item) => String(item.content).toLowerCase().includes(query));
    return { query, results };
  }
}
