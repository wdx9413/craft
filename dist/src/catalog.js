import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { CraftStore } from "./store.js";
function stableId(prefix, value) {
    return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}
export function pathKey(path, platform = process.platform) {
    return platform === "win32" ? path.toLowerCase() : path;
}
export function parseSkill(text, fallback) {
    let metadata = {};
    let body = text;
    if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
        const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
        if (match) {
            const parsed = parse(match[1]);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                metadata = parsed;
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
export async function skillFiles(root) {
    const found = [];
    const visited = new Set();
    async function walk(directory) {
        const actual = await realpath(directory);
        const key = pathKey(actual);
        if (visited.has(key))
            return;
        visited.add(key);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            const info = await stat(path);
            if (info.isDirectory()) {
                await walk(path);
            }
            else if (info.isFile() && entry.name.toLowerCase() === "skill.md") {
                found.push(path);
            }
        }
    }
    await walk(root);
    return found.sort();
}
export class Catalog {
    store;
    constructor(store) { this.store = store; }
    async addSource(path, label, scan = true) {
        const requested_path = resolve(path);
        const root = await realpath(requested_path);
        if (!(await stat(root)).isDirectory())
            throw new Error("Capability source must be a directory.");
        const duplicate = this.store.list("source", Number.MAX_SAFE_INTEGER)
            .find((item) => String(item.real_path).toLowerCase() === root.toLowerCase());
        if (duplicate)
            throw new Error(`Capability source already exists: ${duplicate.id}`);
        const id = stableId("source", root);
        this.store.save("source", id, { label: label || basename(root), requested_path,
            real_path: root, enabled: true, scanned_at: null });
        return scan ? this.scanSource(id) : this.getSource(id);
    }
    listSources() { return this.store.list("source", Number.MAX_SAFE_INTEGER); }
    getSource(id) { return this.store.get("source", id); }
    updateSource(id, enabled, label) {
        const current = this.getSource(id);
        return this.store.save("source", id, { ...current,
            enabled: enabled ?? current.enabled, label: label ?? current.label });
    }
    removeSource(id) {
        this.getSource(id);
        for (const capability of this.store.list("capability", Number.MAX_SAFE_INTEGER)) {
            if (capability.source_id === id)
                this.store.remove("capability", String(capability.id));
        }
        this.store.remove("source", id);
        return { id, removed: true };
    }
    async scanSource(id) {
        const source = this.getSource(id);
        if (!source.enabled)
            throw new Error(`Capability source is disabled: ${id}`);
        const files = await skillFiles(String(source.real_path));
        const live = new Set();
        let added = 0;
        let updated = 0;
        let unchanged = 0;
        for (const path of files) {
            const relative_path = relative(String(source.real_path), path).replaceAll("\\", "/");
            const assetId = stableId("cap", `${id}:${relative_path}`);
            live.add(assetId);
            const fileStat = await stat(path);
            let previous;
            try {
                previous = this.store.get("capability", assetId);
            }
            catch {
                previous = undefined;
            }
            if (previous?.size === fileStat.size && previous?.mtime_ms === fileStat.mtimeMs) {
                unchanged += 1;
                continue;
            }
            const text = await readFile(path, "utf8");
            const digest = createHash("sha256").update(text).digest("hex");
            if (previous?.digest === digest) {
                this.store.save("capability", assetId, { ...previous, size: fileStat.size, mtime_ms: fileStat.mtimeMs });
                unchanged += 1;
                continue;
            }
            const skill = parseSkill(text, basename(resolve(path, "..")));
            this.store.save("capability", assetId, { ...skill, kind: "skill", source_id: id,
                relative_path, path: await realpath(path), digest, size: fileStat.size,
                mtime_ms: fileStat.mtimeMs });
            if (previous)
                updated += 1;
            else
                added += 1;
        }
        let removed = 0;
        for (const item of this.store.list("capability", Number.MAX_SAFE_INTEGER)) {
            if (item.source_id === id && !live.has(String(item.id))) {
                this.store.remove("capability", String(item.id));
                removed += 1;
            }
        }
        this.store.save("source", id, { ...source, scanned_at: new Date().toISOString() });
        return { ...this.getSource(id), scan: { added, updated, unchanged, removed, total: files.length } };
    }
    async scan(sourceId) {
        if (sourceId)
            return this.scanSource(sourceId);
        const results = [];
        for (const source of this.listSources().filter((item) => item.enabled)) {
            results.push(await this.scanSource(String(source.id)));
        }
        return { sources: results };
    }
    search(query, limit = 6) {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (!terms.length)
            return [];
        return this.store.list("capability", Number.MAX_SAFE_INTEGER).map((item) => {
            const text = `${item.name} ${item.description} ${item.body}`.toLowerCase();
            return { item, score: terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) };
        }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score)
            .slice(0, Math.max(1, Math.min(limit, 20))).map(({ item, score }) => ({ ...item, score }));
    }
    get(assetId) { return this.store.get("capability", assetId); }
}
//# sourceMappingURL=catalog.js.map