import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { CraftStore } from "./store.js";
function stableId(prefix, value) {
    return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}
function metadataTerms(metadata) {
    const aliases = metadata.aliases;
    if (typeof aliases === "string")
        return [aliases];
    return Array.isArray(aliases) ? aliases.filter((value) => typeof value === "string") : [];
}
function rerank(query, item) {
    const normalized = query.trim().toLowerCase();
    const terms = normalized.split(/\s+/).filter(Boolean);
    const name = String(item.name).toLowerCase();
    const description = String(item.description).toLowerCase();
    const aliases = metadataTerms(item.metadata).join(" ").toLowerCase();
    const matchedTerms = terms.filter((term) => `${name}\n${description}\n${aliases}`.includes(term));
    const exactName = name === normalized;
    const exactDescription = description.includes(normalized);
    const aliasMatch = aliases.includes(normalized);
    const lexical = Number(item.score);
    return { ...item, score: lexical + matchedTerms.length * 10 + Number(exactName) * 100 + Number(exactDescription) * 40 + Number(aliasMatch) * 60,
        match: { matched_terms: matchedTerms, exact_name: exactName, exact_description: exactDescription, alias_match: aliasMatch } };
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
export async function skillFiles(root, onError) {
    const found = [];
    const visited = new Set();
    async function walk(directory) {
        const actual = await realpath(directory);
        const key = pathKey(actual);
        if (visited.has(key))
            return;
        visited.add(key);
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const path = join(directory, entry.name);
            try {
                const info = await stat(path);
                if (info.isDirectory()) {
                    await walk(path);
                }
                else if (info.isFile() && entry.name.toLowerCase() === "skill.md") {
                    found.push(path);
                }
            }
            catch (error) {
                onError?.(path, error);
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
            .find((item) => pathKey(String(item.real_path)) === pathKey(root));
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
        const issues = [];
        const files = await skillFiles(String(source.real_path), (path, error) => issues.push({
            path, error: String(error),
        }));
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
                search_text: `${skill.body}\n${metadataTerms(skill.metadata).join("\n")}`,
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
        return { ...this.getSource(id), scan: { added, updated, unchanged, removed, total: files.length,
                issues } };
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
        const lexical = this.store.searchCapabilities(terms, 20);
        const aliasFallback = lexical.length ? [] : this.store.list("capability", Number.MAX_SAFE_INTEGER, (item) => {
            const aliases = metadataTerms(item.metadata).join(" ").toLowerCase();
            return terms.every((term) => aliases.includes(term));
        });
        return [...lexical, ...aliasFallback].filter((item, index, values) => values.findIndex((candidate) => candidate.id === item.id) === index).map((item) => rerank(query, item))
            .sort((left, right) => Number(right.score) - Number(left.score) || String(left.id).localeCompare(String(right.id)))
            .slice(0, Math.min(Math.max(1, limit), 20)).map((item) => {
            const { body: _body, metadata: _metadata, search_text: _searchText, ...summary } = item;
            return summary;
        });
    }
    get(assetId) { return this.store.get("capability", assetId); }
}
//# sourceMappingURL=catalog.js.map