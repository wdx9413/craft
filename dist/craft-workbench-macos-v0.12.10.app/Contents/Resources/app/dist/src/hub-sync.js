import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function integer(value, name, min, max) { const result = Number(value); if (!Number.isInteger(result) || result < min || result > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`); return result; }
function strings(value, name, max = 50) { if (!Array.isArray(value) || value.length > max)
    throw new Error(`${name} must be an array with at most ${max} values`); const result = value.map((item) => text(item, name)); if (new Set(result).size !== result.length)
    throw new Error(`${name} must contain unique values`); return result; }
function canonical(value) { if (Array.isArray(value))
    return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function digest(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function entry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Hub entry must be an object");
    const item = value;
    const status = text(item.status, "entry.status");
    if (!new Set(["active", "withdrawn"]).has(status))
        throw new Error("Hub entry status is unsupported");
    const result = { entry_id: text(item.entry_id, "entry.entry_id"), status, content_digest: text(item.content_digest, "entry.content_digest") };
    if (status === "active")
        Object.assign(result, { release_id: text(item.release_id, "entry.release_id"), release_version: integer(item.release_version, "entry.release_version", 1, Number.MAX_SAFE_INTEGER),
            name: text(item.name, "entry.name"), description: text(item.description, "entry.description"), tags: strings(item.tags ?? [], "entry.tags") });
    return result;
}
export class HubSyncKernel {
    store;
    constructor(store) { this.store = store; }
    sourceRegister(args) {
        const endpoint = new URL(text(args.endpoint, "endpoint"));
        if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
            throw new Error("Hub endpoint must be HTTPS without embedded credentials");
        const publicKey = text(args.public_key_pem, "public_key_pem");
        let key;
        try {
            key = createPublicKey(publicKey);
        }
        catch {
            throw new Error("Hub public key is invalid");
        }
        if (key.asymmetricKeyType !== "ed25519")
            throw new Error("Hub source requires an Ed25519 public key");
        const sourceId = String(args.source_id ?? `hub_source_${randomUUID().replaceAll("-", "")}`);
        const fingerprint = digest({ endpoint: endpoint.toString(), public_key_pem: publicKey, publisher: args.publisher });
        const existing = this.store.find("hub_source", sourceId);
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                throw new Error("Hub source idempotency conflict");
            return { source: existing, idempotent: true };
        }
        return { source: this.store.create("hub_source", sourceId, { endpoint: endpoint.toString(), publisher: text(args.publisher, "publisher"), public_key_pem: publicKey,
                fingerprint, status: "active", cursor_revision: 0, cursor_digest: "genesis", last_sync_at: null }), idempotent: false };
    }
    ingest(args) {
        const source = this.store.get("hub_source", text(args.source_id, "source_id"));
        if (source.status !== "active")
            throw new Error("Hub source is not active");
        const revision = integer(args.revision, "revision", 1, Number.MAX_SAFE_INTEGER);
        const previousDigest = text(args.previous_digest, "previous_digest");
        if (!Array.isArray(args.entries) || args.entries.length > 1000)
            throw new Error("Hub page must contain at most 1000 entries");
        const entries = args.entries.map(entry);
        if (new Set(entries.map((item) => item.entry_id)).size !== entries.length)
            throw new Error("Hub page entry ids must be unique");
        const issuedAt = text(args.issued_at, "issued_at");
        if (Number.isNaN(Date.parse(issuedAt)))
            throw new Error("Hub issued_at must be an ISO timestamp");
        const envelope = { source_id: source.id, revision, previous_digest: previousDigest, issued_at: issuedAt, entries };
        const pageDigest = digest(envelope);
        let signature;
        try {
            signature = Buffer.from(text(args.signature, "signature"), "base64");
        }
        catch {
            throw new Error("Hub signature is invalid");
        }
        if (!signature.length || !verify(null, Buffer.from(canonical(envelope)), String(source.public_key_pem), signature))
            throw new Error("Hub page signature verification failed");
        const receiptId = String(args.receipt_id ?? `hub_sync_${randomUUID().replaceAll("-", "")}`);
        const existing = this.store.find("hub_sync_receipt", receiptId);
        if (existing) {
            if (existing.page_digest !== pageDigest)
                throw new Error("Hub sync receipt idempotency conflict");
            return { receipt: existing, idempotent: true };
        }
        if (revision !== Number(source.cursor_revision) + 1)
            throw new Error("Hub revision must advance exactly once");
        if (previousDigest !== source.cursor_digest)
            throw new Error("Hub previous digest does not match the trusted cursor");
        const saved = this.store.transaction((database) => {
            const now = new Date().toISOString();
            const insert = (kind, id, data, version) => { database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(kind, id, version, JSON.stringify(data), now, now); return { ...data, id, version, created_at: now, updated_at: now }; };
            for (const item of entries) {
                const id = `${source.id}:${item.entry_id}`;
                const row = database.prepare("SELECT COALESCE(MAX(version),0)+1 version FROM records WHERE kind='hub_catalog_entry' AND id=?").get(id);
                insert("hub_catalog_entry", id, { ...item, source_id: source.id, source_revision: revision, page_digest: pageDigest }, Number(row.version));
            }
            const nextSource = insert("hub_source", String(source.id), { ...payload(source), cursor_revision: revision, cursor_digest: pageDigest, last_sync_at: issuedAt }, Number(source.version) + 1);
            const receipt = insert("hub_sync_receipt", receiptId, { source_id: source.id, revision, previous_digest: previousDigest, page_digest: pageDigest,
                entry_count: entries.length, signature_verified: true, issued_at: issuedAt }, 1);
            return { source: nextSource, receipt };
        });
        return { ...saved, idempotent: false };
    }
    search(args) {
        const terms = text(args.query, "query").toLowerCase().split(/\s+/u);
        const limit = integer(args.limit ?? 10, "limit", 1, 50);
        const entries = this.store.list("hub_catalog_entry", 100_000, (item) => item.status === "active").map((item) => {
            const haystack = `${item.name} ${item.description} ${item.tags.join(" ")}`.toLowerCase();
            return { ...item, score: terms.reduce((sum, term) => sum + Number(haystack.includes(term)), 0) };
        }).filter((item) => Number(item.score) > 0)
            .sort((left, right) => Number(right.score) - Number(left.score) || String(left.id).localeCompare(String(right.id))).slice(0, limit);
        return { entries, retrieval: "local_signed_catalog", scanned_remote: false };
    }
    sourceDisable(args) {
        const source = this.store.get("hub_source", text(args.source_id, "source_id"));
        if (source.status === "disabled")
            return { source, idempotent: true };
        return { source: this.store.save("hub_source", String(source.id), { ...payload(source), status: "disabled", disabled_reason: text(args.reason, "reason") }), idempotent: false };
    }
}
//# sourceMappingURL=hub-sync.js.map