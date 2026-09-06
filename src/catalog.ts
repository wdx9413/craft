import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { CraftStore, type JsonObject } from "./store.ts";

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

export interface SkillDocument {
  name: string;
  description: string;
  version: string;
  body: string;
  metadata: JsonObject;
}

export function pathKey(path: string, platform = process.platform): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

export function parseSkill(text: string, fallback: string): SkillDocument {
  let metadata: JsonObject = {};
  let body = text;
  if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (match) {
      const parsed = parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
      body = text.slice(match[0].length);
    }
  }
  return {
    name: String(metadata.name || fallback),
    description: String(metadata.description || ""),
    version: String(metadata.version || "unversioned"),
    body,
    metadata,
  };
}

export async function skillFiles(root: string, onError?: (path: string, error: unknown) => void): Promise<string[]> {
  const found: string[] = [];
  const visited = new Set<string>();
  async function walk(directory: string): Promise<void> {
    const actual = await realpath(directory);
    const key = pathKey(actual);
    if (visited.has(key)) return;
    visited.add(key);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      try {
        const info = await stat(path);
        if (info.isDirectory()) {
          await walk(path);
        } else if (info.isFile() && entry.name.toLowerCase() === "skill.md") {
          found.push(path);
        }
      } catch (error) { onError?.(path, error); }
    }
  }
  await walk(root);
  return found.sort();
}

export class Catalog {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  async addSource(path: string, label?: string, scan = true): Promise<JsonObject> {
    const requested_path = resolve(path);
    const root = await realpath(requested_path);
    if (!(await stat(root)).isDirectory()) throw new Error("Capability source must be a directory.");
    const duplicate = this.store.list("source", Number.MAX_SAFE_INTEGER)
      .find((item) => pathKey(String(item.real_path)) === pathKey(root));
    if (duplicate) throw new Error(`Capability source already exists: ${duplicate.id}`);
    const id = stableId("source", root);
    this.store.save("source", id, { label: label || basename(root), requested_path,
      real_path: root, enabled: true, scanned_at: null });
    return scan ? this.scanSource(id) : this.getSource(id);
  }

  listSources(): JsonObject[] { return this.store.list("source", Number.MAX_SAFE_INTEGER); }

  getSource(id: string): JsonObject { return this.store.get("source", id); }

  updateSource(id: string, enabled?: boolean, label?: string): JsonObject {
    const current = this.getSource(id);
    return this.store.save("source", id, { ...current,
      enabled: enabled ?? current.enabled, label: label ?? current.label });
  }

  removeSource(id: string): JsonObject {
    this.getSource(id);
    for (const capability of this.store.list("capability", Number.MAX_SAFE_INTEGER)) {
      if (capability.source_id === id) this.store.remove("capability", String(capability.id));
    }
    this.store.remove("source", id);
    return { id, removed: true };
  }

  async scanSource(id: string): Promise<JsonObject> {
    const source = this.getSource(id);
    if (!source.enabled) throw new Error(`Capability source is disabled: ${id}`);
    const issues: JsonObject[] = [];
    const files = await skillFiles(String(source.real_path), (path, error) => issues.push({
      path, error: String(error),
    }));
    const live = new Set<string>();
    let added = 0; let updated = 0; let unchanged = 0;
    for (const path of files) {
      const relative_path = relative(String(source.real_path), path).replaceAll("\\", "/");
      const assetId = stableId("cap", `${id}:${relative_path}`);
      live.add(assetId);
      const fileStat = await stat(path);
      let previous: JsonObject | undefined;
      try { previous = this.store.get("capability", assetId); } catch { previous = undefined; }
      if (previous?.size === fileStat.size && previous?.mtime_ms === fileStat.mtimeMs) {
        unchanged += 1; continue;
      }
      const text = await readFile(path, "utf8");
      const digest = createHash("sha256").update(text).digest("hex");
      if (previous?.digest === digest) {
        this.store.save("capability", assetId, { ...previous, size: fileStat.size, mtime_ms: fileStat.mtimeMs });
        unchanged += 1; continue;
      }
      const skill = parseSkill(text, basename(resolve(path, "..")));
      this.store.save("capability", assetId, { ...skill, kind: "skill", source_id: id,
        relative_path, path: await realpath(path), digest, size: fileStat.size,
        mtime_ms: fileStat.mtimeMs });
      if (previous) updated += 1; else added += 1;
    }
    let removed = 0;
    for (const item of this.store.list("capability", Number.MAX_SAFE_INTEGER)) {
      if (item.source_id === id && !live.has(String(item.id))) {
        this.store.remove("capability", String(item.id)); removed += 1;
      }
    }
    this.store.save("source", id, { ...source, scanned_at: new Date().toISOString() });
    return { ...this.getSource(id), scan: { added, updated, unchanged, removed, total: files.length,
      issues } };
  }

  async scan(sourceId?: string): Promise<JsonObject> {
    if (sourceId) return this.scanSource(sourceId);
    const results = [];
    for (const source of this.listSources().filter((item) => item.enabled)) {
      results.push(await this.scanSource(String(source.id)));
    }
    return { sources: results };
  }

  search(query: string, limit = 6): JsonObject[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return this.store.searchCapabilities(terms, limit).map((item) => {
      const { body: _body, metadata: _metadata, ...summary } = item;
      return summary;
    });
  }

  get(assetId: string): JsonObject { return this.store.get("capability", assetId); }
}
