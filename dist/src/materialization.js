import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CraftStore } from "./store.js";
const TYPES = new Set(["skill", "workflow", "tool", "mcp", "script", "adapter", "agent", "template"]);
const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive", "unknown"]);
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function canonical(value) { if (Array.isArray(value))
    return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function digest(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function safeRelative(value) { const result = text(value, "file.path").replaceAll("\\", "/"); if (path.posix.isAbsolute(result) || result.split("/").some((part) => !part || part === "." || part === "..") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(path.posix.basename(result)))
    throw new Error("Materialized file path is unsafe"); return result; }
function decode(value) { const encoded = text(value, "file.content_base64"); if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded))
    throw new Error("file.content_base64 is invalid"); return Buffer.from(encoded, "base64"); }
function files(value) {
    if (!Array.isArray(value) || !value.length || value.length > 200)
        throw new Error("Materialization requires between 1 and 200 files");
    const result = value.map((raw) => { if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Materialized file must be an object"); const item = raw; const filePath = safeRelative(item.path); const content = decode(item.content_base64); if (content.length > 1_048_576)
        throw new Error("Materialized file exceeds 1 MiB"); return { path: filePath, content, size: content.length, digest: `sha256:${createHash("sha256").update(content).digest("hex")}` }; });
    if (new Set(result.map((item) => item.path.toLowerCase())).size !== result.length)
        throw new Error("Materialized file paths must be unique across platforms");
    if (result.reduce((sum, item) => sum + item.size, 0) > 5_242_880)
        throw new Error("Materialized package exceeds 5 MiB");
    return result;
}
function findings(items) {
    const result = [];
    for (const item of items) {
        const extension = path.posix.extname(item.path).toLowerCase();
        const body = item.content.toString("utf8");
        if (new Set([".exe", ".dll", ".so", ".dylib", ".wasm", ".node"]).has(extension))
            result.push({ severity: "critical", code: "native_executable", path: item.path });
        if (/(?:bearer\s+[a-z0-9._-]{8,}|sk-[a-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu.test(body))
            result.push({ severity: "high", code: "secret_like_content", path: item.path });
        if (path.posix.basename(item.path).toLowerCase() === "package.json") {
            try {
                const parsed = JSON.parse(body);
                if (parsed.scripts && typeof parsed.scripts === "object" && Object.keys(parsed.scripts).length)
                    result.push({ severity: "high", code: "package_lifecycle_scripts", path: item.path });
            }
            catch {
                result.push({ severity: "critical", code: "invalid_package_json", path: item.path });
            }
        }
    }
    return result;
}
export class MaterializationKernel {
    store;
    constructor(store) { this.store = store; }
    async stage(args) {
        const source = this.store.get("hub_source", text(args.source_id, "source_id"));
        if (source.status !== "active")
            throw new Error("Hub source is not active");
        const entry = this.store.get("hub_catalog_entry", `${source.id}:${text(args.entry_id, "entry_id")}`);
        if (entry.status !== "active")
            throw new Error("Hub catalog entry is not active");
        const packageFiles = files(args.files);
        if (!packageFiles.some((item) => new Set(["skill.md", "capability.json", "plugin.json"]).has(path.posix.basename(item.path).toLowerCase())))
            throw new Error("Materialized package requires a capability descriptor");
        const manifest = packageFiles.map(({ path: filePath, size, digest: fileDigest }) => ({ path: filePath, size, digest: fileDigest }));
        const contentDigest = digest(manifest);
        if (contentDigest !== entry.content_digest)
            throw new Error("Materialized package digest does not match the signed catalog");
        const scan = findings(packageFiles);
        if (scan.some((item) => item.severity === "critical"))
            throw new Error("Materialized package contains a critical finding");
        const materializationId = String(args.materialization_id ?? `materialization_${randomUUID().replaceAll("-", "")}`);
        const fingerprint = digest({ source_id: source.id, entry_id: entry.entry_id, content_digest: contentDigest });
        const existing = this.store.find("capability_materialization", materializationId);
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                throw new Error("Materialization idempotency conflict");
            return { materialization: existing, idempotent: true };
        }
        const root = path.resolve(this.store.paths.cacheDir, "hub-packages", String(source.id), String(entry.entry_id), contentDigest.slice(7));
        const base = path.resolve(this.store.paths.cacheDir, "hub-packages");
        if (path.relative(base, root).startsWith(".."))
            throw new Error("Materialization target escaped the cache root");
        const temporary = `${root}.tmp-${process.pid}-${randomUUID()}`;
        try {
            await mkdir(temporary, { recursive: true });
            for (const item of packageFiles) {
                const target = path.resolve(temporary, ...item.path.split("/"));
                await mkdir(path.dirname(target), { recursive: true });
                await writeFile(target, item.content, { flag: "wx" });
            }
            await mkdir(path.dirname(root), { recursive: true });
            await rename(temporary, root);
        }
        catch (error) {
            await rm(temporary, { recursive: true, force: true });
            throw error;
        }
        const riskLevel = scan.some((item) => item.severity === "high") ? "high" : "low";
        return { materialization: this.store.create("capability_materialization", materializationId, { source_id: source.id, source_revision: entry.source_revision,
                entry_id: entry.entry_id, entry_record_id: entry.id, content_digest: contentDigest, package_root: root, manifest, findings: scan, risk_level: riskLevel,
                status: "quarantined", execution_authority: false, fingerprint }), idempotent: false };
    }
    review(args) {
        const item = this.store.get("capability_materialization", text(args.materialization_id, "materialization_id"));
        if (item.status !== "quarantined")
            throw new Error("Materialization is not awaiting review");
        const decision = text(args.decision, "decision");
        if (!new Set(["approve", "reject"]).has(decision))
            throw new Error("Materialization review decision is unsupported");
        const evidenceIds = decision === "approve" ? (Array.isArray(args.evidence_ids) && args.evidence_ids.length ? args.evidence_ids.map((id) => text(id, "evidence_id")) : (() => { throw new Error("Approved materialization requires Evidence"); })()) : [];
        for (const id of evidenceIds)
            this.store.get("evidence", id);
        if (decision === "approve" && item.risk_level === "high" && !args.security_approval_ref)
            throw new Error("High-risk materialization requires security approval");
        return { materialization: this.store.save("capability_materialization", String(item.id), { ...payload(item), status: decision === "approve" ? "approved" : "rejected",
                reviewer: text(args.reviewer, "reviewer"), review_ref: text(args.review_ref, "review_ref"), evidence_ids: evidenceIds,
                security_approval_ref: decision === "approve" ? args.security_approval_ref ?? null : null }) };
    }
    activate(args) {
        const item = this.store.get("capability_materialization", text(args.materialization_id, "materialization_id"));
        if (item.status !== "approved")
            throw new Error("Only an approved materialization can become a Capability candidate");
        const source = this.store.get("hub_source", String(item.source_id));
        if (source.status !== "active")
            throw new Error("Materialization source is not active");
        const entry = this.store.get("hub_catalog_entry", String(item.entry_record_id));
        if (entry.status !== "active" || entry.content_digest !== item.content_digest)
            throw new Error("Materialized catalog entry was withdrawn or changed");
        const assetType = text(args.asset_type, "asset_type");
        const effect = text(args.effect, "effect");
        if (!TYPES.has(assetType) || !EFFECTS.has(effect))
            throw new Error("Materialized Capability type or effect is unsupported");
        const assetId = text(args.asset_id, "asset_id");
        const current = this.store.find("capability_asset", assetId);
        const asset = this.store.save("capability_asset", assetId, { name: text(args.name ?? entry.name, "name"), asset_type: assetType,
            trust: "candidate", health: "healthy", effect, source_uri: `file://${String(item.package_root).replaceAll("\\", "/")}`, source_digest: item.content_digest,
            dependencies: [], aliases: [], requires_credential: false, cost_hint: {}, materialization_id: item.id, materialization_version: item.version,
            execution_authority: false }, current ? Number(current.version) + 1 : 1);
        const activated = this.store.save("capability_materialization", String(item.id), { ...payload(item), status: "candidate_registered", asset_id: asset.id, asset_version: asset.version });
        return { materialization: activated, asset, executable: false };
    }
}
//# sourceMappingURL=materialization.js.map