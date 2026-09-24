/** Immutable, evidence-addressed execution receipt accepted only by the local evaluation adapter. */
import type { JsonObject } from "../core/infrastructure/store.ts";
import { object, text } from "../core/validation.ts";

export const VERIFIED_EVALUATION_RECEIPT_KIND = "craft.engineering-evaluation.v1";

export interface ProgramCheck {
  evidence_id: string;
  command_digest: string;
  result_digest: string;
  status: "passed" | "failed";
}

export interface VerifiedEvaluationReceipt {
  kind: typeof VERIFIED_EVALUATION_RECEIPT_KIND;
  issued_by: "engineering-eval-cli";
  host_terminal: ProgramCheck;
  frozen_input_digest: string;
  workspace_before_digest: string;
  workspace_after_digest: string;
  acceptance: ProgramCheck;
  siblings: readonly [ProgramCheck, ProgramCheck];
  effect_check: ProgramCheck;
  safety_check: ProgramCheck;
  factual_check: ProgramCheck;
  root_cause_evidence_ids: readonly string[];
  retry_count: number;
  cost_units: number;
  latency_ms: number;
}

function digest(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^sha256:[A-Za-z0-9._-]+$/u.test(result)) throw new Error(`${name} must be a sha256 digest`);
  return result;
}
function finite(value: unknown, name: string, integer = false): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || (integer && !Number.isInteger(result))) throw new Error(`${name} must be a non-negative${integer ? " integer" : " number"}`);
  return result;
}
function check(value: unknown, name: string): ProgramCheck {
  const item = object(value, name); const status = text(item.status, `${name}.status`);
  if (status !== "passed" && status !== "failed") throw new Error(`${name}.status is unsupported`);
  return { evidence_id: text(item.evidence_id, `${name}.evidence_id`), command_digest: digest(item.command_digest, `${name}.command_digest`), result_digest: digest(item.result_digest, `${name}.result_digest`), status };
}

export function receiptEvidenceIds(receipt: VerifiedEvaluationReceipt): string[] {
  return [receipt.host_terminal, receipt.acceptance, ...receipt.siblings, receipt.effect_check, receipt.safety_check, receipt.factual_check].map((item) => item.evidence_id).concat([...receipt.root_cause_evidence_ids]);
}

export function receiptPassed(receipt: VerifiedEvaluationReceipt): boolean {
  return [receipt.host_terminal, receipt.acceptance, ...receipt.siblings, receipt.effect_check, receipt.safety_check, receipt.factual_check].every((item) => item.status === "passed");
}

export function verifiedEvaluationReceipt(value: unknown): VerifiedEvaluationReceipt {
  const item = object(value, "verified_receipt");
  if (text(item.kind, "verified_receipt.kind") !== VERIFIED_EVALUATION_RECEIPT_KIND || text(item.issued_by, "verified_receipt.issued_by") !== "engineering-eval-cli") {
    throw new Error("verified_receipt must be issued by the controlled engineering-eval CLI");
  }
  if (!Array.isArray(item.siblings) || item.siblings.length !== 2) throw new Error("verified_receipt.siblings must contain exactly two checks");
  if (!Array.isArray(item.root_cause_evidence_ids) || !item.root_cause_evidence_ids.length) throw new Error("verified_receipt.root_cause_evidence_ids must not be empty");
  const rootCause = item.root_cause_evidence_ids.map((id, index) => text(id, `verified_receipt.root_cause_evidence_ids[${index}]`));
  if (new Set(rootCause).size !== rootCause.length) throw new Error("verified_receipt.root_cause_evidence_ids must be unique");
  return { kind: VERIFIED_EVALUATION_RECEIPT_KIND, issued_by: "engineering-eval-cli", host_terminal: check(item.host_terminal, "verified_receipt.host_terminal"),
    frozen_input_digest: digest(item.frozen_input_digest, "verified_receipt.frozen_input_digest"), workspace_before_digest: digest(item.workspace_before_digest, "verified_receipt.workspace_before_digest"), workspace_after_digest: digest(item.workspace_after_digest, "verified_receipt.workspace_after_digest"),
    acceptance: check(item.acceptance, "verified_receipt.acceptance"), siblings: [check(item.siblings[0], "verified_receipt.siblings[0]"), check(item.siblings[1], "verified_receipt.siblings[1]")], effect_check: check(item.effect_check, "verified_receipt.effect_check"), safety_check: check(item.safety_check, "verified_receipt.safety_check"), factual_check: check(item.factual_check, "verified_receipt.factual_check"), root_cause_evidence_ids: rootCause,
    retry_count: finite(item.retry_count, "verified_receipt.retry_count", true), cost_units: finite(item.cost_units, "verified_receipt.cost_units"), latency_ms: finite(item.latency_ms, "verified_receipt.latency_ms") };
}

export function receiptPayload(receipt: VerifiedEvaluationReceipt): JsonObject { return receipt as unknown as JsonObject; }
