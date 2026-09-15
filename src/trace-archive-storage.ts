import type { JsonObject } from "./store.ts";
import { createHash } from "node:crypto";
import { CraftStore } from "./store.ts";
import { LocalTraceArchiveStore, type TraceArchiveBundle, type TraceArchivePointer, type TraceArchiveStore } from "./trace-archive-store.ts";

export type TraceArchiveRuntimeBackend = { backend_id: string; store: TraceArchiveStore };

const BUILTIN_BACKEND_ID = "builtin.local";
const BUILTIN_STORAGE_ID = "local";
const SECRET_ASSIGNMENT = /(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*[^\s]+/iu;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}
function secretFreeReference(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  const result = text(value, name);
  if (SECRET_ASSIGNMENT.test(result)) throw new Error(`${name} must not contain sensitive assignments`);
  return result;
}
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

/**
 * Resolves a persisted storage-plugin choice to one deployment-provided archive
 * adapter. Registration never loads code or credentials; activation fails closed
 * unless the matching runtime backend is already present in this Craft process.
 */
export class TraceArchiveStorageKernel implements TraceArchiveStore {
  readonly store: CraftStore;
  readonly backends = new Map<string, TraceArchiveStore>();

  constructor(store: CraftStore, external: readonly TraceArchiveRuntimeBackend[] = []) {
    this.store = store;
    this.backends.set(BUILTIN_BACKEND_ID, new LocalTraceArchiveStore(store.paths.logsDir));
    for (const backend of external) {
      const backendId = identifier(backend.backend_id, "backend_id");
      if (backendId === BUILTIN_BACKEND_ID || this.backends.has(backendId)) throw new Error("Trace archive backend id is duplicated");
      if (!backend.store || typeof backend.store.write !== "function" || typeof backend.store.read !== "function") throw new Error("Trace archive backend store is invalid");
      this.backends.set(backendId, backend.store);
    }
  }

  register(args: JsonObject): JsonObject {
    const storageId = identifier(args.storage_id, "storage_id");
    if (storageId === BUILTIN_STORAGE_ID) throw new Error("local Trace archive storage is built in");
    const backendId = identifier(args.backend_id, "backend_id");
    if (backendId === BUILTIN_BACKEND_ID) throw new Error("builtin local backend cannot be registered externally");
    const identity = { storage_id: storageId, backend_id: backendId, credential_ref: secretFreeReference(args.credential_ref, "credential_ref"), configuration_ref: secretFreeReference(args.configuration_ref, "configuration_ref") };
    const existing = this.store.find("trace_archive_storage", storageId);
    const identityDigest = digest(identity);
    if (existing) {
      if (existing.identity_digest === identityDigest) return { storage: this.view(existing), idempotent: true };
      if (args.replace !== true) throw new Error("Trace archive storage idempotency conflict");
      const saved = this.store.save("trace_archive_storage", storageId, { ...payload(existing), ...identity, identity_digest: identityDigest, status: "registered" });
      return { storage: this.view(saved), idempotent: false };
    }
    const created = this.store.create("trace_archive_storage", storageId, { ...identity, identity_digest: identityDigest, status: "registered" });
    return { storage: this.view(created), idempotent: false };
  }

  list(args: JsonObject = {}): JsonObject {
    const limit = args.limit === undefined ? 50 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer between 1 and 500");
    const active = this.activeId();
    const stored = this.store.list("trace_archive_storage", limit).map((item) => this.view(item, active));
    const local = this.localView(active);
    return { active_storage_id: active, storages: [local, ...stored] };
  }

  activate(args: JsonObject): JsonObject {
    const storageId = identifier(args.storage_id, "storage_id");
    const storage = this.storage(storageId);
    this.backendFor(storage);
    const active = this.store.find("trace_archive_storage_active", "default");
    const identity = { storage_id: storageId, backend_id: storage.backend_id };
    if (active && active.identity_digest === digest(identity)) return { active: active, idempotent: true };
    const saved = active
      ? this.store.save("trace_archive_storage_active", "default", { ...identity, identity_digest: digest(identity), activated_at: new Date().toISOString() })
      : this.store.create("trace_archive_storage_active", "default", { ...identity, identity_digest: digest(identity), activated_at: new Date().toISOString() });
    return { active: saved, idempotent: false };
  }

  write(bundle: TraceArchiveBundle): TraceArchivePointer {
    const storage = this.storage(this.activeId());
    return { ...this.backendFor(storage).write(bundle), backend_id: String(storage.storage_id) };
  }

  read(pointer: TraceArchivePointer): TraceArchiveBundle {
    const storage = this.storage(pointer.backend_id ?? BUILTIN_STORAGE_ID);
    return this.backendFor(storage).read(pointer);
  }

  private activeId(): string {
    return String(this.store.find("trace_archive_storage_active", "default")?.storage_id ?? BUILTIN_STORAGE_ID);
  }
  private storage(storageId: string): JsonObject {
    if (storageId === BUILTIN_STORAGE_ID) return this.localView(this.activeId());
    const record = this.store.get("trace_archive_storage", storageId);
    return this.view(record);
  }
  private localView(active: string): JsonObject {
    return { storage_id: BUILTIN_STORAGE_ID, backend_id: BUILTIN_BACKEND_ID, status: "built_in", available: true, active: active === BUILTIN_STORAGE_ID, credential_ref: null, configuration_ref: null };
  }
  private view(record: JsonObject, active = this.activeId()): JsonObject {
    return { ...record, available: this.backends.has(String(record.backend_id)), active: String(record.storage_id) === active };
  }
  private backendFor(storage: JsonObject): TraceArchiveStore {
    const backend = this.backends.get(String(storage.backend_id));
    if (!backend) throw new Error("Trace archive storage runtime backend is unavailable");
    return backend;
  }
}
