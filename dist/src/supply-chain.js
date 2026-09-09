import { createHash, randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function canonical(value) { if (Array.isArray(value))
    return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function digest(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function strings(value, name) { if (!Array.isArray(value) || !value.length)
    throw new Error(`${name} must be a non-empty array`); const result = value.map((item) => text(item, name)); if (new Set(result).size !== result.length)
    throw new Error(`${name} must contain unique values`); return result; }
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
export class SupplyChainKernel {
    store;
    constructor(store) { this.store = store; }
    advisoryRecord(args) {
        const source = this.store.get("hub_source", text(args.source_id, "source_id"));
        const entryId = args.entry_id === undefined ? null : text(args.entry_id, "entry_id");
        const assetId = args.asset_id === undefined ? null : text(args.asset_id, "asset_id");
        if (Number(entryId !== null) + Number(assetId !== null) !== 1)
            throw new Error("Advisory must target exactly one entry_id or asset_id");
        if (entryId)
            this.store.get("hub_catalog_entry", `${source.id}:${entryId}`);
        if (assetId)
            this.store.get("capability_asset", assetId);
        const severity = text(args.severity, "severity");
        if (!SEVERITIES.has(severity))
            throw new Error("Advisory severity is unsupported");
        const evidenceIds = strings(args.evidence_ids, "evidence_ids");
        for (const id of evidenceIds)
            this.store.get("evidence", id);
        const advisoryId = String(args.advisory_id ?? `supply_chain_advisory_${randomUUID().replaceAll("-", "")}`);
        const fingerprint = digest({ source_id: source.id, entry_id: entryId, asset_id: assetId, severity, evidence_ids: [...evidenceIds].sort(), summary: args.summary });
        const existing = this.store.find("supply_chain_advisory", advisoryId);
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                throw new Error("Supply-chain advisory idempotency conflict");
            return { advisory: existing, idempotent: true };
        }
        return { advisory: this.store.create("supply_chain_advisory", advisoryId, { source_id: source.id, entry_id: entryId, asset_id: assetId,
                severity, summary: text(args.summary, "summary"), evidence_ids: evidenceIds, fingerprint, status: "active" }), idempotent: false };
    }
    advisoryResolve(args) {
        const advisory = this.store.get("supply_chain_advisory", text(args.advisory_id, "advisory_id"));
        if (advisory.status === "resolved")
            return { advisory, idempotent: true };
        const evidenceIds = strings(args.evidence_ids, "evidence_ids");
        for (const id of evidenceIds)
            this.store.get("evidence", id);
        return { advisory: this.store.save("supply_chain_advisory", String(advisory.id), { ...payload(advisory), status: "resolved",
                resolution: text(args.resolution, "resolution"), resolver: text(args.resolver, "resolver"), resolution_evidence_ids: evidenceIds }), idempotent: false };
    }
    reconcile(args) {
        const source = this.store.get("hub_source", text(args.source_id, "source_id"));
        const invalidated = [];
        const certifications = this.store.list("capability_certification", 100_000, (item) => item.status === "promoted");
        for (const certification of certifications) {
            const materialization = this.store.get("capability_materialization", String(certification.materialization_id));
            if (materialization.source_id !== source.id)
                continue;
            const entry = this.store.get("hub_catalog_entry", String(materialization.entry_record_id));
            const asset = this.store.get("capability_asset", String(certification.asset_id));
            const advisory = this.store.list("supply_chain_advisory", 100_000, (item) => item.status === "active" && item.source_id === source.id
                && (["high", "critical"].includes(String(item.severity))) && (item.entry_id === materialization.entry_id || item.asset_id === asset.id))[0];
            const reason = source.status !== "active" ? "source_disabled" : entry.status !== "active" ? "entry_withdrawn"
                : entry.content_digest !== materialization.content_digest ? "content_digest_changed" : advisory ? "security_advisory"
                    : asset.trust !== "verified" || asset.certification_id !== certification.id || Number(asset.certification_version) !== Number(certification.version) ? "certified_asset_drift" : null;
            if (!reason)
                continue;
            const evaluation = this.store.get("evaluation_run", String(certification.evaluation_run_id));
            const trial = this.store.get("trial", String(evaluation.trial_ids[0]));
            const entries = [
                { kind: "capability_asset", id: String(asset.id), payload: { ...payload(asset), health: "stale", governance_status: "blocked", invalidation_reason: reason } },
                { kind: "capability_materialization", id: String(materialization.id), payload: { ...payload(materialization), status: "recertification_required", invalidation_reason: reason } },
                { kind: "capability_certification", id: String(certification.id), payload: { ...payload(certification), status: "invalidated", invalidation_reason: reason,
                        advisory_id: advisory?.id ?? null, task_id: trial.task_id } },
            ];
            for (const profile of this.store.list("activation_profile", 100_000, (item) => item.status === "recommended" && item.asset_ids.includes(String(asset.id)))) {
                const versions = profile.asset_versions;
                const certifiedVersion = Number(certification.asset_version) + 1;
                if (Number(versions[String(asset.id)]) === certifiedVersion)
                    entries.push({ kind: "activation_profile", id: String(profile.id), payload: { ...payload(profile), status: "invalidated", invalidation_reason: reason, invalidated_asset_id: asset.id } });
            }
            const saved = this.store.saveBatch(entries);
            invalidated.push({ certification: saved[2], asset: saved[0], materialization: saved[1], profiles: saved.slice(3), reason });
        }
        return { source_id: source.id, invalidated, count: invalidated.length, recovery_refresh_required: invalidated.length > 0 };
    }
}
//# sourceMappingURL=supply-chain.js.map