import type { CraftService } from "../application/craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";
import { stableDigest } from "../digest.ts";

const USAGE_STATES = new Set(["presented"]);
const SHA256 = /^sha256:[a-f0-9]{64}$/iu;

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,192}$/u.test(value) ? value : null;
}

function exactProcedureRef(value: unknown): JsonObject | null {
  const ref = record(value);
  if (!ref || ref.member !== "experience" || identifier(ref.id) === null || !Number.isSafeInteger(ref.version) || Number(ref.version) < 1
    || typeof ref.digest !== "string" || !SHA256.test(ref.digest)) return null;
  return { member: "experience", id: ref.id, version: Number(ref.version), digest: ref.digest.toLowerCase() };
}

function sameProject(left: unknown, right: unknown): boolean {
  const a = record(left), b = record(right);
  return a?.kind === "project" && b?.kind === "project" && a.id === b.id && typeof a.id === "string";
}

function experienceRefsFromReceipt(receipt: JsonObject): unknown[] {
  const refs: unknown[] = Array.isArray(receipt.asset_refs) ? [...receipt.asset_refs] : [];
  if (!Array.isArray(receipt.contributions)) return refs;
  for (const contributionValue of receipt.contributions) {
    const contribution = record(contributionValue);
    if (contribution?.member !== "experience" || !Array.isArray(contribution.references)) continue;
    for (const referenceValue of contribution.references) {
      const reference = record(referenceValue);
      if (!reference) continue;
      refs.push({ member: "experience", id: reference.id, version: reference.version, digest: reference.digest });
    }
  }
  return refs;
}

/**
 * Records what the Codex Host observed about one exact Experience Procedure
 * selected by a current Context Receipt. It is an adapter boundary: callers
 * must supply actual Host-observed state and same-Trace tool event references.
 */
export class CodexExperienceProcedureUsageCapture {
  readonly service: CraftService;

  constructor(service: CraftService) {
    this.service = service;
  }

  record(args: JsonObject): JsonObject {
    if (args.host !== "codex") return { status: "rejected", reason_code: "unsupported_host" };
    const traceId = identifier(args.trace_id);
    const sessionId = identifier(args.session_id);
    const turnId = identifier(args.turn_id);
    const receiptId = identifier(args.context_receipt_id);
    const scope = record(args.project_scope);
    if (!traceId || !sessionId || !turnId || !receiptId || !scope || scope.kind !== "project" || typeof scope.id !== "string") {
      return { status: "rejected", reason_code: "host_identity_unavailable" };
    }

    const trace = this.service.store.find("trace", traceId);
    if (!trace) return { status: "rejected", reason_code: "trace_unavailable" };
    if (trace.host !== "codex" || trace.session_id !== sessionId || trace.turn_id !== turnId
      || !sameProject(trace.project_scope, scope)) return { status: "rejected", reason_code: "trace_identity_conflict" };
    if (["completed", "failed", "cancelled", "blocked"].includes(String(trace.status))) {
      return { status: "rejected", reason_code: "trace_terminal" };
    }

    const receipt = this.service.store.find("context_resolution_receipt", receiptId)
      ?? this.service.store.find("context_pack_receipt", receiptId);
    if (!receipt) return { status: "rejected", reason_code: "context_receipt_unavailable" };
    if (!sameProject(receipt.scope, scope)) return { status: "rejected", reason_code: "context_receipt_scope_conflict" };
    const procedureRef = exactProcedureRef(args.procedure_ref);
    const selectedRef = experienceRefsFromReceipt(receipt).map(exactProcedureRef).find(ref => ref !== null
      && ref.member === "experience" && procedureRef !== null
      && ref.id === procedureRef.id && ref.version === procedureRef.version && ref.digest === procedureRef.digest);
    if (!procedureRef || !selectedRef) {
      return { status: "rejected", reason_code: "procedure_reference_not_in_context_receipt" };
    }

    const usageState = typeof args.usage_state === "string" ? args.usage_state : "";
    if (!USAGE_STATES.has(usageState)) return { status: "rejected", reason_code: "usage_state_unsupported" };
    if (args.source_event_refs !== undefined
      && (!Array.isArray(args.source_event_refs) || args.source_event_refs.length > 0)) {
      return { status: "rejected", reason_code: "usage_evidence_unavailable" };
    }
    // The current Codex Hook contract proves that a Procedure was injected.
    // It does not prove that the model followed, modified, skipped or rolled it back.
    const refs: string[] = [];
    const usage = false;
    const identity = { trace_id: traceId, context_receipt_id: receiptId, procedure_ref: procedureRef,
      usage_state: usageState, source_event_refs: refs };
    const eventRef = `codex_experience_usage_${stableDigest(identity).slice(-32)}`;
    const saved = this.service.traceAppend({
      trace_id: traceId,
      event_id: eventRef,
      event_kind: "experience.procedure.usage",
      actor: "host",
      source: "codex",
      trust: "observed",
      operation_id: "codex_experience_procedure_usage",
      status: usageState,
      input_refs: [receiptId, ...refs],
      action_contract: {
        kind: "experience_procedure_usage",
        context_receipt_id: receiptId,
        procedure_ref: procedureRef,
        usage_state: usageState,
        usage,
        effect_evidence: "not_established",
        source_event_refs: refs,
      },
      data: {},
    });
    return { status: "captured", event_ref: eventRef, trace_id: traceId, usage, effect_evidence: "not_established",
      idempotent: saved.idempotent === true };
  }
}
