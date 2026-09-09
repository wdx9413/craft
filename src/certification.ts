import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function integer(value: unknown, name: string): number { const result = Number(value); if (!Number.isInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`); return result; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }

export class CapabilityCertificationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  assess(args: JsonObject): JsonObject {
    const materialization = this.store.get("capability_materialization", text(args.materialization_id, "materialization_id"), integer(args.materialization_version, "materialization_version"));
    if (materialization.status !== "candidate_registered") throw new Error("Certification requires a registered Capability candidate");
    const asset = this.store.get("capability_asset", String(materialization.asset_id), Number(materialization.asset_version));
    if (asset.trust !== "candidate" || asset.materialization_id !== materialization.id || Number(asset.materialization_version) !== Number(materialization.version)) throw new Error("Certification candidate identity does not match its Materialization");
    const source = this.store.get("hub_source", String(materialization.source_id)); const entry = this.store.get("hub_catalog_entry", String(materialization.entry_record_id));
    if (source.status !== "active" || entry.status !== "active" || entry.content_digest !== materialization.content_digest) throw new Error("Certification source or catalog entry is no longer current");
    const profile = this.store.get("sandbox_profile", text(args.sandbox_profile_id, "sandbox_profile_id"), integer(args.sandbox_profile_version, "sandbox_profile_version"));
    if (profile.lifecycle !== "verified") throw new Error("Certification requires a verified Sandbox Profile");
    const evaluation = this.store.get("evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    if (evaluation.verdict !== "passed" || evaluation.split !== "held_out" || evaluation.subject_type !== "capability_asset" || evaluation.subject_id !== asset.id || Number(evaluation.subject_version) !== Number(asset.version)) throw new Error("Certification requires a passed held-out Evaluation for the exact Capability candidate");
    const trialIds = evaluation.trial_ids as string[]; if (!trialIds.length) throw new Error("Certification Evaluation has no Trials");
    if (!Array.isArray(args.sandbox_receipts) || args.sandbox_receipts.length !== trialIds.length) throw new Error("Certification requires one Sandbox receipt per Trial");
    const receiptIds = new Set<string>(); for (const raw of args.sandbox_receipts) { if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Certification Sandbox binding must be an object"); const binding = raw as JsonObject;
      const trial = this.store.get("trial", text(binding.trial_id, "sandbox_receipts.trial_id")); if (!trialIds.includes(String(trial.id))) throw new Error("Certification Sandbox binding references a foreign Trial");
      const receipt = this.store.get("sandbox_receipt", text(binding.receipt_id, "sandbox_receipts.receipt_id")); if (receiptIds.has(String(receipt.id))) throw new Error("Certification Sandbox receipts must be unique"); receiptIds.add(String(receipt.id));
      if (receipt.status !== "passed" || receipt.task_id !== trial.task_id || receipt.profile_id !== profile.id || Number(receipt.profile_version) !== Number(profile.version) || !Array.isArray(receipt.evidence_ids) || !receipt.evidence_ids.length) throw new Error("Certification Sandbox receipt does not prove the exact Trial environment");
      const outcome = this.store.get("outcome", `outcome_${trial.id}`); if (outcome.verdict !== "passed" || !Array.isArray(outcome.evidence_ids) || !outcome.evidence_ids.length) throw new Error("Certification Trial requires a passed evidence-backed Outcome");
    }
    const signoff = this.store.get("signoff", text(args.signoff_id, "signoff_id")); if (signoff.decision !== "passed" || signoff.evaluation_run_id !== evaluation.id || signoff.subject_type !== "capability_asset" || signoff.subject_id !== asset.id || Number(signoff.subject_version) !== Number(asset.version)) throw new Error("Certification requires a passed Signoff for the exact Evaluation");
    const grades = (signoff.grade_ids as string[]).map((id) => this.store.get("grade", id)); for (const trialId of trialIds) { const grade = grades.find((item) => item.trial_id === trialId && item.grader_type === "program" && item.verdict === "passed" && Array.isArray(item.evidence_ids) && item.evidence_ids.length); if (!grade) throw new Error("Certification requires an evidence-backed passing program Grade for every Trial"); }
    const certifier = text(args.certifier, "certifier"); if (certifier === materialization.reviewer) throw new Error("Certification requires an independent certifier");
    const certificationId = String(args.certification_id ?? `capability_certification_${randomUUID().replaceAll("-", "")}`); const fingerprint = digest({ materialization_id: materialization.id, materialization_version: materialization.version,
      asset_id: asset.id, asset_version: asset.version, sandbox_profile_id: profile.id, sandbox_profile_version: profile.version,
      evaluation_run_id: evaluation.id, signoff_id: signoff.id, receipt_ids: [...receiptIds].sort(), certifier });
    const existing = this.store.find("capability_certification", certificationId); if (existing) { if (existing.fingerprint !== fingerprint) throw new Error("Capability certification idempotency conflict"); return { certification: existing, idempotent: true }; }
    return { certification: this.store.create("capability_certification", certificationId, { materialization_id: materialization.id, materialization_version: materialization.version,
      asset_id: asset.id, asset_version: asset.version, sandbox_profile_id: profile.id, sandbox_profile_version: profile.version,
      evaluation_run_id: evaluation.id, signoff_id: signoff.id, sandbox_receipt_ids: [...receiptIds].sort(), certifier,
      certification_ref: text(args.certification_ref, "certification_ref"), fingerprint, status: "eligible", execution_authority: false }), idempotent: false };
  }

  promote(args: JsonObject): JsonObject {
    const certification = this.store.get("capability_certification", text(args.certification_id, "certification_id"), integer(args.certification_version, "certification_version")); if (certification.status !== "eligible") throw new Error("Capability certification is not eligible for promotion");
    const promoter = text(args.promoter, "promoter"); if (promoter === certification.certifier) throw new Error("Capability promotion requires an independent promoter");
    const materialization = this.store.get("capability_materialization", String(certification.materialization_id), Number(certification.materialization_version)); const currentMaterialization = this.store.get("capability_materialization", String(certification.materialization_id));
    const asset = this.store.get("capability_asset", String(certification.asset_id), Number(certification.asset_version)); const currentAsset = this.store.get("capability_asset", String(certification.asset_id));
    const source = this.store.get("hub_source", String(materialization.source_id)); const entry = this.store.get("hub_catalog_entry", String(materialization.entry_record_id));
    if (currentMaterialization.version !== materialization.version || currentMaterialization.status !== "candidate_registered" || currentAsset.version !== asset.version || currentAsset.trust !== "candidate") throw new Error("Capability candidate changed after certification");
    if (source.status !== "active" || entry.status !== "active" || entry.content_digest !== materialization.content_digest) throw new Error("Capability source changed after certification");
    const approvalRef = text(args.approval_ref, "approval_ref"); const [verifiedAsset, certifiedMaterialization, promoted] = this.store.saveBatch([
      { kind: "capability_asset", id: String(asset.id), payload: { ...payload(asset), trust: "verified", certification_id: certification.id, certification_version: certification.version } },
      { kind: "capability_materialization", id: String(materialization.id), payload: { ...payload(materialization), status: "certified", certification_id: certification.id, certification_version: certification.version } },
      { kind: "capability_certification", id: String(certification.id), payload: { ...payload(certification), status: "promoted", promoter, approval_ref: approvalRef } },
    ]);
    return { certification: promoted, materialization: certifiedMaterialization, asset: verifiedAsset, executable: false };
  }
}
