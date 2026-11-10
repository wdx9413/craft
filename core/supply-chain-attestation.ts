import { createHash, createPublicKey, verify } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";

const SUBJECT_KINDS = new Set(["capability_asset", "mcp_registry_server", "hub_catalog_entry"]);




function sha256(value: unknown, name: string): string { const result = text(value, name); if (!/^sha256:[a-f0-9]{64}$/u.test(result)) throw new Error(`${name} must be a SHA-256 digest`); return result; }

/**
 * Verifies publisher provenance without installing or activating an asset.
 * This is deliberately a supply-chain proof seam, not another certification
 * system: Capability certification remains the existing Eval/Signoff gate.
 */
export class SupplyChainAttestationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  publisherRegister(args: JsonObject): JsonObject {
    const publisherId = text(args.publisher_id, "publisher_id"); const publicKeyPem = text(args.public_key_pem, "public_key_pem");
    let keyFingerprint: string;
    try { keyFingerprint = digestJson(createPublicKey(publicKeyPem).export({ format: "der", type: "spki" }).toString("base64")); }
    catch { throw new Error("publisher public_key_pem is invalid"); }
    const definition = { publisher_id: publisherId, key_fingerprint: keyFingerprint, identity_ref: text(args.identity_ref, "identity_ref") };
    const existing = this.store.find("supply_chain_publisher", publisherId); const definitionDigest = digestJson(definition);
    if (existing) { if (existing.definition_digest !== definitionDigest) throw new Error("Supply-chain publisher idempotency conflict"); return { publisher: existing, idempotent: true }; }
    return { publisher: this.store.create("supply_chain_publisher", publisherId, { ...definition, definition_digest: definitionDigest, public_key_pem: publicKeyPem, status: "active" }), idempotent: false };
  }

  attest(args: JsonObject): JsonObject {
    const publisher = this.store.get("supply_chain_publisher", text(args.publisher_id, "publisher_id")); if (publisher.status !== "active") throw new Error("Supply-chain publisher is not active");
    const subjectKind = text(args.subject_kind, "subject_kind"); if (!SUBJECT_KINDS.has(subjectKind)) throw new Error("Supply-chain subject kind is unsupported");
    const subjectId = text(args.subject_id, "subject_id"); const subjectDigest = sha256(args.subject_digest, "subject_digest");
    const signature = Buffer.from(text(args.signature, "signature"), "base64url"); let verified = false;
    try { verified = verify(null, Buffer.from(subjectDigest, "utf8"), createPublicKey(String(publisher.public_key_pem)), signature); }
    catch { throw new Error("Supply-chain signature is invalid"); }
    if (!verified) throw new Error("Supply-chain signature does not verify");
    const identity = { publisher_id: publisher.id, publisher_version: publisher.version, subject_kind: subjectKind, subject_id: subjectId, subject_digest: subjectDigest, signature_digest: digestJson(signature.toString("base64url")) };
    const attestationId = String(args.attestation_id ?? `supply_attestation_${digestJson(identity).slice(-24)}`); const existing = this.store.find("supply_chain_attestation", attestationId); const attestationDigest = digestJson(identity);
    if (existing) { if (existing.attestation_digest !== attestationDigest) throw new Error("Supply-chain attestation idempotency conflict"); return { attestation: existing, idempotent: true }; }
    return { attestation: this.store.create("supply_chain_attestation", attestationId, { ...identity, attestation_digest: attestationDigest, status: "verified", raw_signature_stored: false }), idempotent: false };
  }

  assertCurrent(args: JsonObject): JsonObject {
    const attestation = this.store.get("supply_chain_attestation", text(args.attestation_id, "attestation_id")); if (attestation.status !== "verified") throw new Error("Supply-chain attestation is not active");
    const current = sha256(args.current_subject_digest, "current_subject_digest"); const matches = current === attestation.subject_digest;
    if (!matches) this.store.save("supply_chain_attestation", String(attestation.id), { ...payload(attestation), status: "stale", stale_at: new Date().toISOString() });
    return { attestation: this.store.get("supply_chain_attestation", String(attestation.id)), current, matches, activation_permitted: false };
  }

  revoke(args: JsonObject): JsonObject {
    const attestation = this.store.get("supply_chain_attestation", text(args.attestation_id, "attestation_id")); if (attestation.status === "revoked") return { attestation, idempotent: true };
    return { attestation: this.store.save("supply_chain_attestation", String(attestation.id), { ...payload(attestation), status: "revoked", revocation_reason: text(args.reason, "reason") }), idempotent: false };
  }
}
