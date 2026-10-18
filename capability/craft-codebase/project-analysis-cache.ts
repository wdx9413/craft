import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

const CACHE_KINDS = new Set(["codebase_file_analysis", "codebase_semantic_file_analysis", "codebase_python_file_analysis", "codebase_java_file_analysis", "codebase_lsp_file_analysis"]);
const CACHE_ID = /^codebase_(?:file|[a-z_]+_file)_[A-Za-z0-9_-]{1,128}$/u;
const CACHE_FORMAT = "craft-project-codebase-analysis-cache-v1";

function ensureDirectory(path: string): string {
  const resolved = resolve(path);
  const rootStat = lstatSync(resolved);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Project Codebase cache root is unsafe");
  let current = resolved;
  for (const part of [".craft_data", "codebase", "indexes"]) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project Codebase cache path is unsafe");
  }
  return current;
}

/** Mutable digest-checked per-file analysis caches for one repository workspace. */
export class ProjectAnalysisCache {
  readonly directory: string;
  readonly workspaceId: string;

  constructor(projectRoot: string, workspaceId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(workspaceId)) throw new Error("Invalid Codebase workspace id");
    this.workspaceId = workspaceId;
    const root = ensureDirectory(projectRoot);
    let current = join(root, workspaceId);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    let stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project Codebase cache path is unsafe");
    current = join(current, "analysis_cache");
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project Codebase cache path is unsafe");
    this.directory = current;
  }

  find(kind: string, id: string): JsonObject | null {
    const path = this.path(kind, id);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Project Codebase cache record is unsafe");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Project Codebase cache record is invalid");
    const record = value as JsonObject;
    if (record.format !== CACHE_FORMAT || record.kind !== kind || record.workspace_id !== this.workspaceId || record.id !== id
      || !Number.isSafeInteger(record.version) || Number(record.version) < 1 || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)
      || record.payload_digest !== stableDigest(record.payload)) throw new Error("Project Codebase cache integrity failure");
    return { ...(record.payload as JsonObject), id, version: record.version, workspace_id: this.workspaceId };
  }

  list(kind: string, limit: number): JsonObject[] {
    this.assertKind(kind);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Project Codebase cache limit must be between 1 and 10000");
    const prefix = `${kind}--`;
    const names = readdirSync(this.directory).filter(name => name.startsWith(prefix) && name.endsWith(".json")).sort();
    if (names.length > limit) throw new Error("Project Codebase cache exceeds requested limit");
    return names.map(name => {
      const id = name.slice(prefix.length, -5);
      return this.find(kind, id)!;
    });
  }

  save(kind: string, id: string, payload: JsonObject): JsonObject {
    const path = this.path(kind, id);
    if (payload.workspace_id !== undefined && payload.workspace_id !== this.workspaceId) throw new Error("Project Codebase cache workspace mismatch");
    const previous = this.find(kind, id);
    const next = { format: CACHE_FORMAT, kind, workspace_id: this.workspaceId, id, version: Number(previous?.version ?? 0) + 1,
      payload: { ...payload, workspace_id: this.workspaceId }, payload_digest: stableDigest({ ...payload, workspace_id: this.workspaceId }) };
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(next)}\n`, "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
    chmodSync(path, 0o600);
    return { ...next.payload, id, version: next.version };
  }

  remove(kind: string, id: string): boolean {
    const path = this.path(kind, id);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Project Codebase cache record is unsafe");
    unlinkSync(path);
    return true;
  }

  private path(kind: string, id: string): string {
    this.assertKind(kind);
    if (!CACHE_ID.test(id)) throw new Error("Invalid Codebase analysis cache id");
    return join(this.directory, `${kind}--${id}.json`);
  }

  private assertKind(kind: string): void {
    if (!CACHE_KINDS.has(kind)) throw new Error("Unsupported Project Codebase cache kind");
  }
}
