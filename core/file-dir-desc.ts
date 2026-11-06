/**
 * `craft-file-dir-desc`: a self-evolving registry that maps a directory to a
 * human-readable semantic description and back. People navigate machines by
 * meaning ("where the billing service lives") not by absolute paths, so the
 * registry lets an agent resolve a description to a path and a path to its
 * meaning.
 *
 * Self-evolution rule (from NEEDREAD.md): a directory is only persisted once it
 * has actually been used, and it is only "promoted" to a stable, recallable
 * entry once it has been used often enough. A freshly observed path stays in a
 * low-trust `observed` state until it crosses the use-count threshold, which
 * keeps noise (one-off temp folders, OS defaults) out of the formal index.
 */
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { type CraftStore, type JsonObject } from "./infrastructure/store.ts";

/** Below this count a directory is only "observed"; at/above it becomes "promoted". */
export const PROMOTION_USE_THRESHOLD = 3;

export interface FileDirDescRecord {
  id: string;
  path: string;
  description: string;
  hostKind: "local" | "cloud";
  useCount: number;
  status: "observed" | "promoted" | "revoked";
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** Set when an entry was withdrawn: who, why and when. */
  revokedBy?: string | null;
  revokedReason?: string | null;
}

function normalizePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("path must be a non-empty string");
  // Reject relative paths before resolving: resolve() would silently anchor a
  // relative path to the process cwd and wrongly accept it.
  if (!isAbsolute(value.trim())) throw new Error("path must be an absolute path");
  return resolve(value.trim());
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("description must be a non-empty string");
  const trimmed = value.trim().replace(/\s+/gu, " ");
  if (trimmed.length > 500) throw new Error("description must be 500 characters or fewer");
  return trimmed;
}

function normalizeHostKind(value: unknown): "local" | "cloud" {
  if (value === undefined || value === null || value === "local") return "local";
  if (value === "cloud") return "cloud";
  throw new Error("host_kind must be local or cloud");
}

function toRecord(payload: JsonObject): FileDirDescRecord {
  return {
    id: String(payload.id),
    path: String(payload.path),
    description: String(payload.description),
    hostKind: payload.host_kind === "cloud" ? "cloud" : "local",
    useCount: Number(payload.use_count ?? 0),
    status: payload.status === "promoted" ? "promoted" : payload.status === "revoked" ? "revoked" : "observed",
    createdAt: String(payload.created_at),
    updatedAt: String(payload.updated_at),
    lastUsedAt: payload.last_used_at === null || payload.last_used_at === undefined ? null : String(payload.last_used_at),
    revokedBy: payload.revoked_by === undefined || payload.revoked_by === null ? null : String(payload.revoked_by),
    revokedReason: payload.revoked_reason === undefined || payload.revoked_reason === null ? null : String(payload.revoked_reason),
  };
}

function termMatch(haystack: string, needle: string): boolean {
  // A description resolves to a path when every whitespace-separated term in the
  // query appears in the stored description. Empty queries match nothing.
  const terms = needle.toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return false;
  const lower = haystack.toLowerCase();
  return terms.every((term) => lower.includes(term));
}

export class FileDirDescRegistry {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Record (or reinforce) a directory↔description link. The first touch only
   * "observes" the path; repeat uses bump the count and promote it once it
   * crosses the threshold. An explicit `promote: true` forces promotion.
   *
   * This is the human-facing entry point: it is the one place where a
   * description may be corrected. Automatic reinforcement must go through
   * `observe`, which never rewrites the description.
   */
  record(args: JsonObject): JsonObject {
    const path = normalizePath(args.path);
    const description = normalizeDescription(args.description);
    const hostKind = normalizeHostKind(args.host_kind);
    const forcePromote = args.promote === true;
    const now = new Date().toISOString();
    // A predicate scan is not LIMIT-bound in the store, so use an effectively
    // unbounded cap: 1_000 would silently create duplicate entries per path.
    const existing = this.store.list("file_dir_desc", Number.MAX_SAFE_INTEGER, (item) => item.path === path)[0];
    if (existing) {
      const useCount = Number(existing.use_count ?? 0) + 1;
      // A withdrawn entry stays withdrawn: only an explicit promote revives it.
      const withdrawn = existing.status === "revoked";
      const promoted = !withdrawn && (forcePromote || useCount >= PROMOTION_USE_THRESHOLD);
      const payload = { ...existing, description, host_kind: hostKind, use_count: useCount,
        status: withdrawn ? "revoked" : promoted ? "promoted" : "observed", updated_at: now, last_used_at: now };
      this.store.save("file_dir_desc", String(existing.id), payload);
      return toRecord(payload) as unknown as JsonObject;
    }
    const id = String(args.id ?? `fdd_${randomUUID()}`);
    const useCount = 1;
    const promoted = forcePromote || useCount >= PROMOTION_USE_THRESHOLD;
    const payload = { id, path, description, host_kind: hostKind, use_count: useCount,
      status: promoted ? "promoted" : "observed", created_at: now, updated_at: now, last_used_at: now };
    this.store.save("file_dir_desc", id, payload);
    return toRecord(payload) as unknown as JsonObject;
  }

  /**
   * Automatic reinforcement from real use (NEEDREAD 13.2: "使用过才会存，用的多
   * 才会推到正式"). Unlike `record` this never rewrites the description - a later
   * task title is not the meaning of a directory - and it refuses to inflate an
   * entry that was withdrawn.
   */
  observe(args: JsonObject): JsonObject {
    const path = normalizePath(args.path);
    const hostKind = normalizeHostKind(args.host_kind);
    const now = new Date().toISOString();
    const existing = this.store.list("file_dir_desc", Number.MAX_SAFE_INTEGER, (item) => item.path === path)[0];
    if (existing) {
      const useCount = Number(existing.use_count ?? 0) + 1;
      const withdrawn = existing.status === "revoked";
      const promoted = !withdrawn && useCount >= PROMOTION_USE_THRESHOLD;
      const payload = { ...existing, host_kind: hostKind, use_count: useCount,
        status: withdrawn ? "revoked" : promoted ? "promoted" : "observed", updated_at: now, last_used_at: now };
      this.store.save("file_dir_desc", String(existing.id), payload);
      return toRecord(payload) as unknown as JsonObject;
    }
    // Seeding needs a description; callers without one are recorded with the
    // directory's own name so the entry is still findable and reviewable.
    const description = args.description === undefined || args.description === null
      ? (path.split(/[\\/]/u).filter(Boolean).pop() ?? path)
      : normalizeDescription(args.description);
    const id = String(args.id ?? `fdd_${randomUUID()}`);
    const payload = { id, path, description, host_kind: hostKind, use_count: 1, status: "observed",
      created_at: now, updated_at: now, last_used_at: now };
    this.store.save("file_dir_desc", id, payload);
    return toRecord(payload) as unknown as JsonObject;
  }

  /**
   * Relocate a directory after it moved (rename, clone, drive change). Identity
   * and accumulated use survive; the previous path is kept for audit. A conflict
   * with an existing entry for the new path is refused rather than merged away.
   */
  relocate(args: JsonObject): JsonObject {
    const id = text(args.id, "id");
    const toPath = normalizePath(args.path);
    const existing = this.store.find("file_dir_desc", id);
    if (!existing) throw new Error(`Unknown file_dir_desc: ${id}`);
    const conflict = this.store.list("file_dir_desc", Number.MAX_SAFE_INTEGER,
      (item) => item.path === toPath && String(item.id) !== id)[0];
    if (conflict) throw new Error(`another entry already describes ${toPath}; withdraw it first`);
    const now = new Date().toISOString();
    const payload = { ...existing, path: toPath, relocated_from: String(existing.path), relocated_at: now, updated_at: now };
    this.store.save("file_dir_desc", id, payload);
    return toRecord(payload) as unknown as JsonObject;
  }

  /**
   * Withdraw an entry. Revocation is attributed and keeps the record: a
   * withdrawn directory must stop being recallable without losing the audit
   * trail that would let it be corrected or revived deliberately.
   */
  revoke(args: JsonObject): JsonObject {
    const id = text(args.id, "id");
    const actor = boundedActor(args.revoked_by, "revoked_by");
    const reason = text(args.reason, "reason");
    const existing = this.store.find("file_dir_desc", id);
    if (!existing) throw new Error(`Unknown file_dir_desc: ${id}`);
    const now = new Date().toISOString();
    const payload = { ...existing, status: "revoked", revoked_by: actor, revoked_reason: reason,
      revoked_at: now, updated_at: now };
    this.store.save("file_dir_desc", id, payload);
    return toRecord(payload) as unknown as JsonObject;
  }

  /** Promote an observed entry regardless of use count (explicit user action). */
  promote(args: JsonObject): JsonObject {
    const id = text(args.id, "id");
    const existing = this.store.find("file_dir_desc", id);
    if (!existing) throw new Error(`Unknown file_dir_desc: ${id}`);
    const now = new Date().toISOString();
    const payload = { ...existing, status: "promoted", updated_at: now,
      revoked_by: null, revoked_reason: null };
    this.store.save("file_dir_desc", id, payload);
    return toRecord(payload) as unknown as JsonObject;
  }

  /**
   * Bidirectional resolve. With `description`, return ranked matching paths
   * (only promoted entries are recallable; observed ones are too noisy). With
   * `path`, return the description(s) for that path.
   */
  resolve(args: JsonObject): JsonObject {
    if (args.description !== undefined && args.description !== null) {
      const description = normalizeDescription(args.description);
      const limit = finiteLimit(args.limit);
      const matches = this.store
        .list("file_dir_desc", 1_000, (item) => item.status === "promoted" && termMatch(String(item.description), description))
        .map(toRecord)
        .sort((a, b) => b.useCount - a.useCount);
      return { kind: "by_description", query: description, results: matches.slice(0, limit) };
    }
    if (args.path !== undefined && args.path !== null) {
      const path = normalizePath(args.path);
      const entries = this.store.list("file_dir_desc", 1_000, (item) => item.path === path).map(toRecord);
      return { kind: "by_path", path, results: entries };
    }
    throw new Error("resolve requires description or path");
  }

  list(args: JsonObject = {}): JsonObject {
    const status = args.status === "observed" || args.status === "promoted" || args.status === "revoked" ? args.status : null;
    const hostKind = args.host_kind === "cloud" ? "cloud" : args.host_kind === "local" ? "local" : null;
    const limit = finiteLimit(args.limit);
    const items = this.store
      // The predicate scan ignores SQL LIMIT, so this bound only guards the
      // in-memory sort; a small cap here would hide entries from `record`.
      .list("file_dir_desc", Number.MAX_SAFE_INTEGER, (item) => (status === null || item.status === status)
        && (hostKind === null || (hostKind === "cloud" ? item.host_kind === "cloud" : item.host_kind !== "cloud")))
      .map(toRecord)
      .sort((a, b) => b.useCount - a.useCount || (a.updatedAt < b.updatedAt ? 1 : -1));
    return { items: items.slice(0, limit) };
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

// Same contract as the Mod registry: an attributed action names its operator,
// on one line, bounded. Kept local so this kernel does not depend on Mod types.
function boundedActor(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must name the operator`);
  const trimmed = value.trim();
  if (trimmed.length > 120 || /[\r\n\0]/u.test(trimmed)) throw new Error(`${name} must be a single line, 120 chars or fewer`);
  return trimmed;
}

function finiteLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) throw new Error("limit must be an integer between 1 and 1000");
  return parsed;
}
