import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { ensureProjectStorageDirectory, type CraftPaths } from "../../common/craft-common-store-local/src/paths.ts";

const GRAPH_RECORD_ID = /^codebase_(?:shard|edge_route)_[A-Za-z0-9_-]{1,128}$/u;

function safeDirectory(rootPath: string, workspaceId: string, paths: CraftPaths): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(workspaceId)) throw new Error("Invalid Codebase workspace id");
  let current = ensureProjectStorageDirectory(paths, rootPath);
  for (const part of ["codebase", "indexes", workspaceId, "graph_records"]) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project Codebase graph path is unsafe");
  }
  return current;
}

/** Immutable, content-addressed graph records for a project Codebase index. */
export class ProjectGraphStore {
  readonly directory: string;

  constructor(projectRoot: string, workspaceId: string, paths: CraftPaths) {
    this.directory = safeDirectory(projectRoot, workspaceId, paths);
  }

  put(id: string, record: JsonObject): void {
    if (!GRAPH_RECORD_ID.test(id) || record.id !== id) throw new Error("Invalid Codebase graph record");
    const path = this.path(id);
    if (existsSync(path)) {
      if (stableDigest(this.read(id)) !== stableDigest(record)) throw new Error("Project Codebase graph record integrity failure");
      return;
    }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try { linkSync(temporary, path); }
    finally { unlinkSync(temporary); }
  }

  read(id: string): JsonObject {
    const path = this.path(id);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Project Codebase graph record is unsafe");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as JsonObject).id !== id)
      throw new Error("Project Codebase graph record is invalid");
    return value as JsonObject;
  }

  recordsDigest(ids: readonly string[]): string {
    const records = [...new Set(ids)].sort().map(id => {
      this.read(id);
      return [id, createHash("sha256").update(readFileSync(this.path(id))).digest("hex")];
    });
    return stableDigest(records);
  }

  recordsFingerprint(ids: readonly string[]): string {
    const records = [...new Set(ids)].sort().map(id => {
      const stat = lstatSync(this.path(id));
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Project Codebase graph record is unsafe");
      return [id, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
    });
    return stableDigest(records);
  }

  private path(id: string): string {
    if (!GRAPH_RECORD_ID.test(id)) throw new Error("Invalid Codebase graph record id");
    return join(this.directory, `${id}.json`);
  }
}
