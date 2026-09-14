import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

type Risk = "low" | "moderate" | "high" | "critical";
type CheckKind = "contract" | "deterministic_e2e" | "state_machine" | "adversarial" | "recovery" | "host_conformance" | "eval_campaign" | "release_qualification";
type ReceiptStatus = "passed" | "failed" | "blocked" | "inconclusive";

const RANK: Record<Risk, number> = { low: 1, moderate: 2, high: 3, critical: 4 };
const RISK = new Set<Risk>(Object.keys(RANK) as Risk[]);
const KINDS = new Set(["code", "policy", "capability", "host", "plugin", "data", "docs", "version", "harness"]);
const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);
const STATUSES = new Set<ReceiptStatus>(["passed", "failed", "blocked", "inconclusive"]);

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function list(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty array`);
  const values = value.map((item) => text(item, name)); if (new Set(values).size !== values.length) throw new Error(`${name} must contain unique values`); return values;
}
function optionalList(value: unknown, name: string): string[] { return value === undefined ? [] : list(value, name); }
function boolean(value: unknown, name: string): boolean { if (value === undefined) return false; if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`); return value; }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }

function maxRisk(left: Risk, right: Risk): Risk { return RANK[left] >= RANK[right] ? left : right; }

function deriveRisk(kinds: string[], effects: string[], candidate: boolean, realHost: boolean): Risk {
  let risk: Risk = kinds.includes("docs") || kinds.includes("version") ? "low" : "moderate";
  if (kinds.some((kind) => ["policy", "capability", "host", "plugin"].includes(kind)) || candidate || realHost) risk = maxRisk(risk, "high");
  if (effects.includes("local_write")) risk = maxRisk(risk, "high");
  if (effects.some((effect) => ["external_write", "destructive"].includes(effect))) risk = "critical";
  return risk;
}

function checkKinds(risk: Risk, kinds: string[], candidate: boolean, realHost: boolean): CheckKind[] {
  const checks: CheckKind[] = ["contract", "deterministic_e2e", "state_machine"];
  if (RANK[risk] >= RANK.high) checks.push("adversarial", "recovery");
  if (realHost || kinds.includes("host")) checks.push("host_conformance");
  if (candidate) checks.push("eval_campaign", "release_qualification");
  return checks;
}

function receiptIdentity(args: JsonObject): JsonObject {
  return { verification_id: text(args.verification_id, "verification_id"), check_id: text(args.check_id, "check_id"), status: text(args.status, "status"), summary: text(args.summary, "summary"), evidence_ids: optionalList(args.evidence_ids, "evidence_ids"), environment_fingerprint: text(args.environment_fingerprint, "environment_fingerprint") };
}

export class VerificationPlane {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  plan(args: JsonObject): JsonObject {
    if (boolean(args.content_stored, "content_stored")) throw new Error("Verification Plan must be content-free");
    const changeKinds = list(args.change_kinds, "change_kinds"); if (changeKinds.some((kind) => !KINDS.has(kind))) throw new Error("change_kinds contains an unsupported kind");
    const effects = list(args.effects, "effects"); if (effects.some((effect) => !EFFECTS.has(effect))) throw new Error("effects contains an unsupported effect");
    const candidateChange = boolean(args.candidate_change, "candidate_change"); const requiresRealHost = boolean(args.requires_real_host, "requires_real_host");
    const derivedRisk = deriveRisk(changeKinds, effects, candidateChange, requiresRealHost);
    const requested = args.requested_risk_level === undefined ? derivedRisk : text(args.requested_risk_level, "requested_risk_level") as Risk;
    if (!RISK.has(requested)) throw new Error("requested_risk_level is unsupported");
    const risk = maxRisk(derivedRisk, requested); const identity = { change_ref: text(args.change_ref, "change_ref"), change_kinds: [...changeKinds].sort(), effects: [...effects].sort(), candidate_change: candidateChange, requires_real_host: requiresRealHost, environment_fingerprint: text(args.environment_fingerprint, "environment_fingerprint"), requested_risk_level: requested, risk_level: risk, content_stored: false };
    const verificationId = String(args.verification_id ?? `verification_${digest(identity).slice(-16)}`); const identityDigest = digest(identity); const existing = this.store.find("verification_plan", verificationId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Verification Plan idempotency conflict"); const checks = this.checks(existing.id); return { verification: { ...existing, checks }, checks, idempotent: true }; }
    const verification = this.store.create("verification_plan", verificationId, { ...identity, identity_digest: identityDigest, risk_escalated: RANK[risk] > RANK[requested], execution_authority: "none", lifecycle: "planned" });
    const checks = checkKinds(risk, changeKinds, candidateChange, requiresRealHost).map((kind, index) => this.store.create("verification_check", `${verificationId}:${kind}`, { verification_id: verification.id, kind, order: index + 1, required: true, status: "pending" }));
    return { verification: { ...verification, checks }, checks, idempotent: false };
  }

  record(args: JsonObject): JsonObject {
    const identity = receiptIdentity(args); const verification = this.store.get("verification_plan", String(identity.verification_id));
    if (identity.environment_fingerprint !== verification.environment_fingerprint) throw new Error("Verification Receipt environment does not match the plan");
    if (!STATUSES.has(identity.status as ReceiptStatus)) throw new Error("Verification Receipt status is unsupported");
    const check = this.store.find("verification_check", `${verification.id}:${identity.check_id}`) ?? this.store.find("verification_check", String(identity.check_id));
    if (!check || check.verification_id !== verification.id) throw new Error("Verification Receipt check is not planned");
    const evidenceIds = identity.evidence_ids as string[];
    if (identity.status === "passed" && !evidenceIds.length) throw new Error("Passed Verification Receipt requires Evidence");
    for (const evidenceId of evidenceIds) {
      const confidence = String(this.store.get("evidence", evidenceId).confidence);
      if (!new Set(["confirmed", "bounded"]).has(confidence)) throw new Error("Verification Receipt Evidence must be confirmed or bounded");
    }
    const receiptId = String(args.receipt_id ?? `${verification.id}:${check.id}`); const identityDigest = digest(identity); const existing = this.store.find("verification_receipt", receiptId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Verification Receipt idempotency conflict"); return { receipt: existing, idempotent: true }; }
    if (check.status !== "pending") throw new Error("Verification check already has a Receipt");
    const receipt = this.store.create("verification_receipt", receiptId, { ...identity, verification_id: verification.id, check_id: check.id, identity_digest: identityDigest });
    this.store.save("verification_check", String(check.id), { ...payload(check), status: identity.status, receipt_id: receipt.id });
    return { receipt, idempotent: false };
  }

  assess(args: JsonObject): JsonObject {
    const verification = this.store.get("verification_plan", text(args.verification_id, "verification_id")); const checks = this.checks(verification.id);
    const failed = checks.some((check) => check.status === "failed"); const complete = checks.every((check) => check.status === "passed"); const candidate = verification.candidate_change === true;
    const qualificationId = args.release_qualification_id === undefined ? undefined : text(args.release_qualification_id, "release_qualification_id");
    const qualification = qualificationId === undefined ? undefined : this.store.get("release_qualification", qualificationId);
    const qualificationVerdict = candidate ? String(qualification?.conclusion ?? "inconclusive") : "not_required";
    const verdict = failed || qualificationVerdict === "rejected" ? "rejected" : !complete || qualificationVerdict !== "eligible" && qualificationVerdict !== "not_required" ? "inconclusive" : "eligible";
    const identity = { verification_id: verification.id, verification_version: verification.version, check_versions: checks.map((check) => [check.id, check.version, check.status]), release_qualification_id: qualificationId ?? null, release_qualification_version: qualification?.version ?? null, verdict };
    const assessmentId = String(args.assessment_id ?? `verification_assessment_${digest(identity).slice(-16)}`); const identityDigest = digest(identity); const existing = this.store.find("verification_assessment", assessmentId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Verification Assessment idempotency conflict"); return { assessment: existing, verdict, idempotent: true }; }
    const assessment = this.store.create("verification_assessment", assessmentId, { ...identity, identity_digest: identityDigest, recommendation: verdict === "eligible" ? "eligible_for_declared_next_gate" : verdict === "rejected" ? "fix_or_rollback_before_progress" : "collect_missing_comparable_evidence" });
    return { assessment, verdict, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const verification = this.store.get("verification_plan", text(args.verification_id, "verification_id"));
    return { verification, checks: this.checks(verification.id), receipts: this.store.list("verification_receipt", 100, (item) => item.verification_id === verification.id), assessments: this.store.list("verification_assessment", 100, (item) => item.verification_id === verification.id) };
  }

  private checks(verificationId: unknown): JsonObject[] {
    return this.store.list("verification_check", 20, (item) => item.verification_id === verificationId).sort((left, right) => Number(left.order) - Number(right.order));
  }
}
