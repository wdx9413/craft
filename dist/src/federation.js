import { createHash, randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function object(value, name) { if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`); return value; }
function strings(value, name, minimum = 0) { if (!Array.isArray(value) || value.length < minimum)
    throw new Error(`${name} must contain at least ${minimum} values`); const result = value.map((item) => text(item, name)); if (new Set(result).size !== result.length)
    throw new Error(`${name} must contain unique values`); return result; }
function canonical(value) { if (Array.isArray(value))
    return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function digest(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function safe(value, path = "manifest") {
    if (typeof value === "string" && /(?:bearer\s+[a-z0-9._-]{8,}|sk-[a-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu.test(value))
        throw new Error(`${path} contains secret-like material`);
    if (Array.isArray(value)) {
        value.forEach((item, index) => safe(item, `${path}[${index}]`));
        return;
    }
    if (!value || typeof value !== "object")
        return;
    for (const [key, child] of Object.entries(value)) {
        if (/^(?:api[_-]?key|authorization|cookie|password|secret|token)$/iu.test(key))
            throw new Error(`${path}.${key} is a sensitive field`);
        safe(child, `${path}.${key}`);
    }
}
export class CapabilityFederationKernel {
    store;
    constructor(store) { this.store = store; }
    propose(args) {
        const asset = this.store.get("capability_asset", text(args.asset_id, "asset_id"), Number(args.asset_version));
        if (asset.trust !== "verified" || asset.health !== "healthy")
            throw new Error("Only a healthy verified Capability Asset can be shared");
        const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1);
        for (const id of evidenceIds)
            this.store.get("evidence", id);
        const audience = text(args.audience, "audience");
        if (!new Set(["personal", "team", "organization"]).has(audience))
            throw new Error("Federation audience is unsupported");
        const manifest = object(args.manifest, "manifest");
        safe(manifest);
        const bundleId = String(args.bundle_id ?? `capability_bundle_${randomUUID().replaceAll("-", "")}`);
        const fingerprint = digest({ asset_id: asset.id, asset_version: asset.version, audience, manifest, evidence_ids: [...evidenceIds].sort() });
        const existing = this.store.find("capability_bundle", bundleId);
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                throw new Error("Capability bundle idempotency conflict");
            return { bundle: existing, idempotent: true };
        }
        return { bundle: this.store.create("capability_bundle", bundleId, { asset_id: asset.id, asset_version: asset.version, audience, manifest,
                evidence_ids: evidenceIds, fingerprint, status: "proposed", execution_authority: false, raw_trajectory_stored: false }), idempotent: false };
    }
    review(args) {
        const bundle = this.store.get("capability_bundle", text(args.bundle_id, "bundle_id"));
        if (bundle.status !== "proposed")
            throw new Error("Capability bundle is not awaiting review");
        const decision = text(args.decision, "decision");
        if (!new Set(["approve", "reject"]).has(decision))
            throw new Error("Federation review decision is unsupported");
        const reviewedManifest = args.reviewed_manifest === undefined ? object(bundle.manifest, "manifest") : object(args.reviewed_manifest, "reviewed_manifest");
        safe(reviewedManifest);
        return { bundle: this.store.save("capability_bundle", String(bundle.id), { ...payload(bundle), manifest: reviewedManifest,
                status: decision === "approve" ? "reviewed" : "rejected", reviewer: text(args.reviewer, "reviewer"), review_ref: text(args.review_ref, "review_ref") }) };
    }
    publish(args) {
        const bundle = this.store.get("capability_bundle", text(args.bundle_id, "bundle_id"), Number(args.bundle_version));
        if (bundle.status !== "reviewed")
            throw new Error("Only a reviewed Capability bundle can be published");
        const publisher = text(args.publisher, "publisher");
        if (publisher === bundle.reviewer)
            throw new Error("Federation publication requires an independent publisher");
        const asset = this.store.get("capability_asset", String(bundle.asset_id), Number(bundle.asset_version));
        const currentAsset = this.store.get("capability_asset", String(bundle.asset_id));
        if (asset.trust !== "verified" || asset.health !== "healthy" || currentAsset.health !== "healthy")
            throw new Error("Capability bundle asset is no longer publishable");
        const releaseId = String(args.release_id ?? `capability_release_${randomUUID().replaceAll("-", "")}`);
        const releaseDigest = digest({ bundle_id: bundle.id, bundle_version: bundle.version, asset_id: asset.id, asset_version: asset.version, manifest: bundle.manifest });
        const approvalRef = text(args.approval_ref, "approval_ref");
        const publicationFingerprint = digest({ release_digest: releaseDigest, publisher, approval_ref: approvalRef });
        const existing = this.store.find("capability_release", releaseId);
        if (existing) {
            if (existing.publication_fingerprint !== publicationFingerprint)
                throw new Error("Capability release idempotency conflict");
            return { release: existing, idempotent: true };
        }
        return { release: this.store.create("capability_release", releaseId, { bundle_id: bundle.id, bundle_version: bundle.version, asset_id: asset.id,
                asset_version: asset.version, audience: bundle.audience, manifest: bundle.manifest, evidence_ids: bundle.evidence_ids, publisher,
                approval_ref: approvalRef, release_digest: releaseDigest, publication_fingerprint: publicationFingerprint, status: "active", execution_authority: false }), idempotent: false };
    }
    subscribe(args) {
        const release = this.store.get("capability_release", text(args.release_id, "release_id"), Number(args.release_version));
        const currentRelease = this.store.get("capability_release", String(release.id));
        if (release.status !== "active" || currentRelease.status !== "active")
            throw new Error("Capability release is not active");
        const consumer = text(args.consumer, "consumer");
        const subscriptionId = String(args.subscription_id ?? `capability_subscription_${randomUUID().replaceAll("-", "")}`);
        const fingerprint = digest({ release_id: release.id, release_version: release.version, release_digest: release.release_digest, consumer });
        const existing = this.store.find("capability_subscription", subscriptionId);
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                throw new Error("Capability subscription idempotency conflict");
            return { subscription: existing, idempotent: true };
        }
        return { subscription: this.store.create("capability_subscription", subscriptionId, { release_id: release.id, release_version: release.version,
                release_digest: release.release_digest, consumer, asset_id: release.asset_id, asset_version: release.asset_version, fingerprint, status: "pinned", execution_authority: false }), idempotent: false };
    }
    resolve(args) {
        const subscription = this.store.get("capability_subscription", text(args.subscription_id, "subscription_id"));
        if (subscription.status !== "pinned")
            throw new Error("Capability subscription is not pinned");
        const release = this.store.get("capability_release", String(subscription.release_id), Number(subscription.release_version));
        const currentRelease = this.store.get("capability_release", String(subscription.release_id));
        if (release.status !== "active" || currentRelease.status !== "active" || release.release_digest !== subscription.release_digest)
            throw new Error("Capability release was revoked or changed");
        const asset = this.store.get("capability_asset", String(subscription.asset_id), Number(subscription.asset_version));
        return { subscription, release, asset, activation_allowed: true, execution_authority: false };
    }
    revoke(args) {
        const release = this.store.get("capability_release", text(args.release_id, "release_id"));
        if (release.status === "revoked")
            return { release, idempotent: true };
        return { release: this.store.save("capability_release", String(release.id), { ...payload(release), status: "revoked", revoked_by: text(args.actor, "actor"),
                revocation_ref: text(args.revocation_ref, "revocation_ref"), reason: text(args.reason, "reason") }), idempotent: false };
    }
}
//# sourceMappingURL=federation.js.map