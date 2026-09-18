import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function searchScope(value: unknown): { scope: string | null; skipped: boolean } {
  if (value === undefined) return { scope: null, skipped: false };
  if (value === null) return { scope: null, skipped: true };
  if (typeof value === "string") return value.trim() ? { scope: value.trim(), skipped: false } : { scope: null, skipped: true };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as JsonObject;
    const kind = record.kind ?? record.scope_kind;
    const id = record.id ?? record.scope_id;
    if (typeof kind !== "string" || typeof id !== "string" || !kind.trim() || !id.trim()) return { scope: null, skipped: true };
    return { scope: `${kind.trim()}:${id.trim()}`, skipped: false };
  }
  throw new Error("scope must be a string or scope object");
}
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; if (rest.content_ref !== undefined) delete rest.content; return rest; }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
const SECRET = /(?:api[_-]?key|authorization|cookie|password|passwd|secret|token)\s*[:=]\s*[^\s]{6,}/iu;

export class MemoryConsolidationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  private body(record: JsonObject): string {
    if (typeof record.content === "string") return record.content;
    const ref = record.content_ref;
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) return "";
    try { return this.store.contentStore.readCompatSync(ref as never).body; } catch { return ""; }
  }

  remember(args: JsonObject): JsonObject {
    const memoryId = String(args.memory_id ?? `memory_${randomUUID().replaceAll("-", "")}`);
    const scope = text(args.scope ?? "task", "scope");
    const content = text(args.content, "content");
    const source = text(args.source ?? "work", "source");
    if (SECRET.test(content) || SECRET.test(source)) throw new Error("Memory content and source must not contain credentials or secrets");
    const existing = this.store.find("episodic_memory", memoryId);
    const identityDigest = digest({ scope, content, source, task_id: args.task_id ?? null });
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Memory idempotency conflict");
      return { memory: existing, idempotent: true };
    }
    const contentRef = this.store.contentStore.writeSync({ kind: "memory", record_id: memoryId, version: 1,
      scope, status: "active", sensitivity: "internal", source_id: source, body: content });
    return { memory: this.store.create("episodic_memory", memoryId, { scope, source, task_id: args.task_id ?? null,
      content_ref: contentRef, content_digest: contentRef.digest, identity_digest: identityDigest, consolidated: false,
      confidence: Number(args.confidence ?? 0.5) }), idempotent: false };
  }

  consolidate(args: JsonObject): JsonObject {
    const memoryIds = Array.isArray(args.memory_ids) ? args.memory_ids.map((item) => text(item, "memory_ids")) : [];
    if (!memoryIds.length) throw new Error("memory_ids must contain at least one id");
    const memories = memoryIds.map((memoryId) => this.store.get("episodic_memory", memoryId));
    const scope = text(args.scope ?? memories[0]!.scope, "scope");
    const content = text(args.content ?? memories.map((memory) => this.body(memory)).filter(Boolean).join("\n"), "content");
    if (SECRET.test(content)) throw new Error("Semantic memory content must not contain credentials or secrets");
    const semanticId = String(args.semantic_id ?? `semantic_memory_${randomUUID().replaceAll("-", "")}`);
    const identityDigest = digest({ scope, content, memory_ids: memoryIds });
    const existing = this.store.find("semantic_memory", semanticId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Semantic memory idempotency conflict");
      return { memory: existing, idempotent: true };
    }
    for (const memory of memories) this.store.save("episodic_memory", String(memory.id), { ...payload(memory), consolidated: true, consolidated_into: semanticId });
    const contentRef = this.store.contentStore.writeSync({ kind: "memory", record_id: semanticId, version: 1,
      scope, status: "active", sensitivity: "internal", source_id: "consolidation", body: content });
    return { memory: this.store.create("semantic_memory", semanticId, { scope, memory_ids: memoryIds,
      content_ref: contentRef, content_digest: contentRef.digest, identity_digest: identityDigest,
      confidence: Number(args.confidence ?? 0.8), status: "active" }), idempotent: false };
  }

  resolve(args: JsonObject): JsonObject {
    const semantic = this.store.get("semantic_memory", text(args.semantic_id, "semantic_id"));
    const status = text(args.status, "status");
    if (!(new Set(["active", "superseded", "rejected"]).has(status))) throw new Error("Unsupported semantic memory status");
    return { memory: this.store.save("semantic_memory", String(semantic.id), { ...payload(semantic), status, resolution: text(args.resolution ?? status, "resolution") }), idempotent: false };
  }

  search(args: JsonObject): JsonObject {
    const query = text(args.query, "query").toLowerCase();
    const resolvedScope = searchScope(args.scope);
    if (resolvedScope.skipped) {
      return { query, scope: null, results: [], skipped: true, reason: "scope_unavailable" };
    }
    const scope = resolvedScope.scope;
    const memories = this.store.list("semantic_memory", 10_000, (item) => item.status === "active" && (scope === null || item.scope === scope));
    const results = memories.filter((item) => this.body(item).toLowerCase().includes(query))
      .map((item) => ({ ...item, content: this.body(item) }));
    return { query, results };
  }
}
